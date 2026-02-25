import { Effect, Schema } from "effect"
import * as Chat from "effect/unstable/ai/Chat"
import type * as Response from "effect/unstable/ai/Response"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { ContextWindowExceeded, SessionNotFound, TokenBudgetExceeded } from "../../../domain/src/errors.js"
import type { AgentId, AuditEntryId, ConversationId, MessageId, SessionId, TurnId } from "../../../domain/src/ids.js"
import {
  type AuditEntryRecord,
  type ContentBlock,
  ContentBlock as ContentBlockSchema,
  type TurnRecord
} from "../../../domain/src/ports.js"
import { ToolRegistry } from "../ai/ToolRegistry.js"
import { AgentStatePortTag, GovernancePortTag, SessionTurnPortTag } from "../PortTags.js"

export const TurnAuditReasonCode = Schema.Literals([
  "turn_processing_accepted",
  "turn_processing_policy_denied",
  "turn_processing_requires_approval",
  "turn_processing_token_budget_exceeded",
  "turn_processing_model_error"
])
export type TurnAuditReasonCode = typeof TurnAuditReasonCode.Type

export const ProcessTurnPayload = Schema.Struct({
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  agentId: Schema.String,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlockSchema),
  createdAt: Schema.DateTimeUtc,
  inputTokens: Schema.Number
})
export type ProcessTurnPayload = typeof ProcessTurnPayload.Type

export const ProcessTurnResult = Schema.Struct({
  turnId: Schema.String,
  accepted: Schema.Boolean,
  auditReasonCode: TurnAuditReasonCode,
  assistantContent: Schema.String,
  assistantContentBlocks: Schema.Array(ContentBlockSchema),
  modelFinishReason: Schema.Union([Schema.String, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null])
})
export type ProcessTurnResult = typeof ProcessTurnResult.Type

export class TurnPolicyDenied extends Schema.ErrorClass<TurnPolicyDenied>(
  "TurnPolicyDenied"
)({
  _tag: Schema.tag("TurnPolicyDenied"),
  turnId: Schema.String,
  reason: Schema.String
}) {}

export class TurnModelFailure extends Schema.ErrorClass<TurnModelFailure>(
  "TurnModelFailure"
)({
  _tag: Schema.tag("TurnModelFailure"),
  turnId: Schema.String,
  reason: Schema.String
}) {}

export const TurnProcessingError = Schema.Union([
  TurnPolicyDenied,
  TurnModelFailure,
  TokenBudgetExceeded,
  SessionNotFound,
  ContextWindowExceeded
])
export type TurnProcessingError = typeof TurnProcessingError.Type

const PolicyDecisionSchema = Schema.Struct({
  decision: Schema.Literals(["Allow", "Deny", "RequireApproval"]),
  policyId: Schema.Union([Schema.String, Schema.Null]),
  reason: Schema.String
})

const PersistTurnError = Schema.Union([SessionNotFound, ContextWindowExceeded])
const JsonFromString = Schema.UnknownFromJsonString
const encodeUnknownJson = Schema.encodeUnknownEffect(JsonFromString)

export const TurnProcessingWorkflow = Workflow.make({
  name: "TurnProcessingWorkflow",
  payload: ProcessTurnPayload,
  success: ProcessTurnResult,
  error: TurnProcessingError,
  idempotencyKey: (payload) => payload.turnId
})

export const layer = TurnProcessingWorkflow.toLayer(
  Effect.fn("TurnProcessingWorkflow.execute")(function*(payload, _executionId: string) {
    const agentStatePort = yield* AgentStatePortTag
    const sessionTurnPort = yield* SessionTurnPortTag
    const governancePort = yield* GovernancePortTag
    const toolRegistry = yield* ToolRegistry
    const chatPersistence = yield* Chat.Persistence

    const policy = yield* Activity.make({
      name: "EvaluatePolicy",
      success: PolicyDecisionSchema,
      execute: governancePort.evaluatePolicy({
        agentId: payload.agentId as AgentId,
        sessionId: payload.sessionId as SessionId,
        action: "ReadMemory"
      })
    })

    if (policy.decision === "Deny") {
      yield* writeAuditEntry(
        governancePort,
        payload,
        "Deny",
        "turn_processing_policy_denied"
      )
      return yield* new TurnPolicyDenied({
        turnId: payload.turnId,
        reason: policy.reason
      })
    }

    if (policy.decision === "RequireApproval") {
      yield* writeAuditEntry(
        governancePort,
        payload,
        "RequireApproval",
        "turn_processing_requires_approval"
      )
      return yield* new TurnPolicyDenied({
        turnId: payload.turnId,
        reason: policy.reason
      })
    }

    yield* Activity.make({
      name: "CheckTokenBudget",
      error: TokenBudgetExceeded,
      execute: agentStatePort.consumeTokenBudget(
        payload.agentId as AgentId,
        payload.inputTokens,
        payload.createdAt
      )
    }).asEffect().pipe(
      Effect.catchTag("TokenBudgetExceeded", (error) =>
        writeAuditEntry(
          governancePort,
          payload,
          "Deny",
          "turn_processing_token_budget_exceeded"
        ).pipe(
          Effect.andThen(Effect.fail(error))
        ))
    )

    yield* Activity.make({
      name: "PersistUserTurn",
      error: PersistTurnError,
      execute: Effect.gen(function*() {
        yield* Activity.idempotencyKey("PersistUserTurn")
        yield* sessionTurnPort.updateContextWindow(
          payload.sessionId as SessionId,
          payload.inputTokens
        )
        yield* sessionTurnPort.appendTurn(makeUserTurn(payload))
      })
    }).asEffect()

    const modelResponse = yield* Effect.gen(function*() {
      const toolkitBundle = yield* toolRegistry.makeToolkit({
        agentId: payload.agentId as AgentId,
        sessionId: payload.sessionId as SessionId,
        turnId: payload.turnId as TurnId,
        now: payload.createdAt
      })
      const chat = yield* chatPersistence.getOrCreate(payload.sessionId)

      return yield* chat.generateText({
        prompt: toPromptText(payload.content, payload.contentBlocks),
        toolkit: toolkitBundle.toolkit
      }).pipe(
        Effect.provide(toolkitBundle.handlerLayer)
      )
    }).pipe(
      Effect.catch((error) =>
        writeAuditEntry(
          governancePort,
          payload,
          "Deny",
          "turn_processing_model_error"
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new TurnModelFailure({
                turnId: payload.turnId,
                reason: toErrorMessage(error)
              })
            )
          )
        )
      )
    )

    const assistantResult = yield* Effect.gen(function*() {
      const assistantContent = modelResponse.text
      const assistantContentBlocks = yield* toDomainContentBlocks(modelResponse.content)
      const modelUsageJson = yield* encodeUnknownJson(modelResponse.usage)
      return {
        assistantContent,
        assistantContentBlocks,
        modelUsageJson
      } as const
    }).pipe(
      Effect.catch((error) =>
        writeAuditEntry(
          governancePort,
          payload,
          "Deny",
          "turn_processing_model_error"
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new TurnModelFailure({
                turnId: payload.turnId,
                reason: `encoding_error: ${toErrorMessage(error)}`
              })
            )
          )
        )
      )
    )

    yield* Activity.make({
      name: "PersistAssistantTurn",
      execute: sessionTurnPort.appendTurn(
        makeAssistantTurn(payload, {
          assistantContent: assistantResult.assistantContent,
          assistantContentBlocks: assistantResult.assistantContentBlocks,
          modelFinishReason: modelResponse.finishReason,
          modelUsageJson: assistantResult.modelUsageJson
        })
      )
    }).asEffect()

    yield* writeAuditEntry(
      governancePort,
      payload,
      "Allow",
      "turn_processing_accepted"
    )

    return {
      turnId: payload.turnId,
      accepted: true,
      auditReasonCode: "turn_processing_accepted",
      assistantContent: assistantResult.assistantContent,
      assistantContentBlocks: assistantResult.assistantContentBlocks,
      modelFinishReason: modelResponse.finishReason,
      modelUsageJson: assistantResult.modelUsageJson
    } as const
  })
)

const writeAuditEntry = (
  governancePort: {
    readonly writeAudit: (entry: AuditEntryRecord) => Effect.Effect<void>
  },
  payload: ProcessTurnPayload,
  decision: AuditEntryRecord["decision"],
  reasonCode: TurnAuditReasonCode
) =>
  Activity.make({
    name: "WriteAudit",
    execute: Effect.gen(function*() {
      const idempotencyKey = yield* Activity.idempotencyKey(`WriteAudit:${reasonCode}`)
      const auditEntryId = (`audit:${idempotencyKey}`) as AuditEntryId
      yield* governancePort.writeAudit({
        auditEntryId,
        agentId: payload.agentId as AgentId,
        sessionId: payload.sessionId as SessionId,
        decision,
        reason: reasonCode,
        createdAt: payload.createdAt
      })
    })
  }).asEffect().pipe(Effect.ignore)

const makeUserTurn = (payload: ProcessTurnPayload): TurnRecord => ({
  turnId: payload.turnId as TurnId,
  sessionId: payload.sessionId as SessionId,
  conversationId: payload.conversationId as ConversationId,
  turnIndex: 0,
  participantRole: "UserRole" as const,
  participantAgentId: payload.agentId as AgentId,
  message: {
    messageId: (`message:${payload.turnId}:user`) as MessageId,
    role: "UserRole" as const,
    content: payload.content,
    contentBlocks: payload.contentBlocks.length > 0
      ? payload.contentBlocks
      : [{ contentBlockType: "TextBlock" as const, text: payload.content }]
  },
  modelFinishReason: null,
  modelUsageJson: null,
  createdAt: payload.createdAt
})

const makeAssistantTurn = (
  payload: ProcessTurnPayload,
  details: {
    readonly assistantContent: string
    readonly assistantContentBlocks: ReadonlyArray<ContentBlock>
    readonly modelFinishReason: string
    readonly modelUsageJson: string
  }
): TurnRecord => ({
  turnId: (`${payload.turnId}:assistant`) as TurnId,
  sessionId: payload.sessionId as SessionId,
  conversationId: payload.conversationId as ConversationId,
  turnIndex: 0,
  participantRole: "AssistantRole" as const,
  participantAgentId: payload.agentId as AgentId,
  message: {
    messageId: (`message:${payload.turnId}:assistant`) as MessageId,
    role: "AssistantRole" as const,
    content: details.assistantContent,
    contentBlocks: details.assistantContentBlocks
  },
  modelFinishReason: details.modelFinishReason,
  modelUsageJson: details.modelUsageJson,
  createdAt: payload.createdAt
})

const toPromptText = (
  fallback: string,
  contentBlocks: ReadonlyArray<ContentBlock>
): string => {
  const textFromBlocks = contentBlocks
    .filter((block) => block.contentBlockType === "TextBlock")
    .map((block) => block.text)
    .join("\n")
    .trim()

  return textFromBlocks.length > 0 ? textFromBlocks : fallback
}

const toDomainContentBlocks = (
  parts: ReadonlyArray<Response.Part<any>>
): Effect.Effect<ReadonlyArray<ContentBlock>, Schema.SchemaError> =>
  Effect.gen(function*() {
    const blocks: Array<ContentBlock> = []

    for (const part of parts) {
      switch (part.type) {
        case "text": {
          blocks.push({
            contentBlockType: "TextBlock",
            text: part.text
          })
          break
        }
        case "tool-call": {
          blocks.push({
            contentBlockType: "ToolUseBlock",
            toolCallId: part.id,
            toolName: part.name,
            inputJson: yield* encodeUnknownJson(part.params)
          })
          break
        }
        case "tool-result": {
          blocks.push({
            contentBlockType: "ToolResultBlock",
            toolCallId: part.id,
            toolName: part.name,
            outputJson: yield* encodeUnknownJson(part.result),
            isError: part.isFailure
          })
          break
        }
        case "file": {
          if (part.mediaType.startsWith("image/")) {
            blocks.push({
              contentBlockType: "ImageBlock",
              mediaType: part.mediaType,
              source: toImageSource(part.data),
              altText: null
            })
          }
          break
        }
        default:
          break
      }
    }

    return blocks
  })

const toImageSource = (data: string | Uint8Array | URL): string => {
  if (typeof data === "string") {
    return data
  }
  if (data instanceof URL) {
    return data.toString()
  }
  return `data:application/octet-stream;base64,${Buffer.from(data).toString("base64")}`
}
const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
