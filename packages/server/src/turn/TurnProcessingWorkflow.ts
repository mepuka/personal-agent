import { Effect, Layer, Option, Ref, Schema } from "effect"
import * as Chat from "effect/unstable/ai/Chat"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  MAX_TOOL_ITERATIONS_CAP,
  TURN_LOOP_TIMEOUT_SECONDS
} from "@template/domain/system-defaults"
import {
  ContextWindowExceeded,
  SessionNotFound,
  TokenBudgetExceeded
} from "../../../domain/src/errors.js"
import type {
  AgentId,
  AuditEntryId,
  ConversationId,
  MessageId,
  SessionId,
  TurnId
} from "../../../domain/src/ids.js"
import {
  type AuditEntryRecord,
  type ContentBlock,
  ContentBlock as ContentBlockSchema,
  type Instant,
  type TurnRecord
} from "../../../domain/src/ports.js"
import { ModelFinishReason } from "../../../domain/src/status.js"
import { AgentConfig } from "../ai/AgentConfig.js"
import {
  encodeFinishReason,
  encodePartsToContentBlocks,
  encodeUsageToJson
} from "../ai/ContentBlockCodec.js"
import { ModelRegistry } from "../ai/ModelRegistry.js"
import { ToolRegistry, type ToolRegistryService } from "../ai/ToolRegistry.js"
import { MemoryPortSqlite } from "../MemoryPortSqlite.js"
import {
  AgentStatePortTag,
  GovernancePortTag,
  MemoryPortTag,
  SessionTurnPortTag
} from "../PortTags.js"


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
  userId: Schema.String,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlockSchema),
  createdAt: Schema.DateTimeUtc,
  inputTokens: Schema.Number
})
export type ProcessTurnPayload = typeof ProcessTurnPayload.Type

const TurnIterationStats = Schema.Struct({
  iteration: Schema.Number,
  finishReason: ModelFinishReason,
  toolCallsThisIteration: Schema.Number,
  toolCallsTotal: Schema.Number
})
type TurnIterationStats = typeof TurnIterationStats.Type

export const ProcessTurnResult = Schema.Struct({
  turnId: Schema.String,
  accepted: Schema.Boolean,
  auditReasonCode: TurnAuditReasonCode,
  assistantContent: Schema.String,
  assistantContentBlocks: Schema.Array(ContentBlockSchema),
  iterationsUsed: Schema.Number,
  toolCallsTotal: Schema.Number,
  iterationStats: Schema.Array(TurnIterationStats),
  modelFinishReason: Schema.Union([ModelFinishReason, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null])
})
export type ProcessTurnResult = typeof ProcessTurnResult.Type

interface ToolLoopResult {
  readonly finalResponse: LanguageModel.GenerateTextResponse<any>
  readonly allContentParts: ReadonlyArray<Response.Part<any>>
  readonly iterationsUsed: number
  readonly toolCallsTotal: number
  readonly iterationStats: ReadonlyArray<TurnIterationStats>
  readonly usage: Response.Usage
}

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
  toolDefinitionId: Schema.Union([Schema.String, Schema.Null]),
  reason: Schema.String
})

const PersistTurnError = Schema.Union([SessionNotFound, ContextWindowExceeded])

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
    yield* MemoryPortTag // required by layer — actual retrieval uses sqlitePort below
    const toolRegistry = yield* ToolRegistry
    const chatPersistence = yield* Chat.Persistence
    const agentConfig = yield* AgentConfig
    const modelRegistry = yield* ModelRegistry
    const sqlitePort = yield* MemoryPortSqlite

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

    const maxToolIterations = yield* agentStatePort.get(payload.agentId as AgentId).pipe(
      Effect.map((state) => Math.min(Math.max(state?.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS, 1), MAX_TOOL_ITERATIONS_CAP))
    )

    // Retrieve semantic memories for context injection (snapshot read, not an Activity)
    // Uses FTS5 full-text search via MemoryPortSqlite.retrieve for relevance ranking
    const semanticMemories = yield* sqlitePort.retrieve(
      payload.agentId as AgentId,
      { query: payload.content, tier: "SemanticMemory", limit: 20 }
    )

    const modelResult = yield* Effect.gen(function*() {
      // Resolve agent profile and model layer
      const profile = yield* agentConfig.getAgent(payload.agentId)
      const lmLayer = yield* modelRegistry.get(
        profile.model.provider,
        profile.model.modelId
      )

      const chat = yield* chatPersistence.getOrCreate(payload.sessionId)

      // Build system prompt: base persona + fresh memory context each turn
      const baseSystemPrompt = profile.persona.systemPrompt
      const systemPromptWithMemory = semanticMemories.length > 0
        ? baseSystemPrompt
          + "\n\n[Relevant Memory]\n"
          + semanticMemories.map((m) => `- ${m.content}`).join("\n")
        : baseSystemPrompt

      // Set system prompt (always re-set to avoid stale memory accumulation)
      const currentHistory = yield* Ref.get(chat.history)
      const withSystem = Prompt.setSystem(currentHistory, systemPromptWithMemory)
      yield* Ref.set(chat.history, withSystem)

      // Build prompt with memory context prepended
      const userPrompt = toPromptText(payload.content, payload.contentBlocks)

      const loopResultOption = yield* processWithToolLoop({
        chat,
        toolRegistry,
        lmLayer,
        context: {
          agentId: payload.agentId as AgentId,
          sessionId: payload.sessionId as SessionId,
          conversationId: payload.conversationId as ConversationId,
          turnId: payload.turnId as TurnId,
          now: payload.createdAt
        },
        userPrompt,
        maxIterations: maxToolIterations
      }).pipe(
        Effect.timeoutOption(`${TURN_LOOP_TIMEOUT_SECONDS} seconds`)
      )

      if (Option.isNone(loopResultOption)) {
        return yield* new TurnModelFailure({
          turnId: payload.turnId,
          reason: "tool_loop_timeout"
        })
      }

      return loopResultOption.value
    }).pipe(
      Effect.catch((error) =>
        writeAuditEntry(
          governancePort,
          payload,
          "Deny",
          "turn_processing_model_error"
        ).pipe(
          Effect.andThen(Effect.fail(toTurnModelFailure(payload.turnId, error)))
        )
      )
    )

    const assistantResult = yield* Effect.gen(function*() {
      const assistantContent = modelResult.finalResponse.text
      const assistantContentBlocks = yield* encodePartsToContentBlocks(modelResult.allContentParts)
      const modelUsageJson = yield* encodeUsageToJson(modelResult.usage)
      return {
        assistantContent,
        assistantContentBlocks,
        modelUsageJson,
        iterationsUsed: modelResult.iterationsUsed,
        toolCallsTotal: modelResult.toolCallsTotal,
        iterationStats: modelResult.iterationStats
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
                reason: `encoding_error: ${error instanceof Error ? error.message : String(error)}`
              })
            )
          )
        )
      )
    )

    const modelFinishReason = encodeFinishReason(modelResult.finalResponse.finishReason)

    yield* Activity.make({
      name: "PersistAssistantTurn",
      execute: sessionTurnPort.appendTurn(
        makeAssistantTurn(payload, {
          assistantContent: assistantResult.assistantContent,
          assistantContentBlocks: assistantResult.assistantContentBlocks,
          modelFinishReason,
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
      iterationsUsed: assistantResult.iterationsUsed,
      toolCallsTotal: assistantResult.toolCallsTotal,
      iterationStats: assistantResult.iterationStats,
      modelFinishReason,
      modelUsageJson: assistantResult.modelUsageJson
    } as const
  })
)

const processWithToolLoop = (params: {
  readonly chat: Chat.Persisted
  readonly toolRegistry: ToolRegistryService
  readonly lmLayer: Layer.Layer<any>
  readonly context: {
    readonly agentId: AgentId
    readonly sessionId: SessionId
    readonly conversationId: ConversationId
    readonly turnId: TurnId
    readonly now: Instant
  }
  readonly userPrompt: string
  readonly maxIterations: number
}): Effect.Effect<ToolLoopResult, unknown, never> =>
  Effect.suspend(function loop(
    iteration = 0,
    toolCallsTotal = 0,
    allParts: ReadonlyArray<Response.Part<any>> = [],
    usage = zeroUsage(),
    iterationStats: ReadonlyArray<TurnIterationStats> = []
  ): Effect.Effect<ToolLoopResult, unknown, never> {
    const currentIteration = iteration + 1

    return Effect.gen(function*() {
      const toolkitBundle = yield* params.toolRegistry.makeToolkit({
        ...params.context,
        iteration
      })

      const response = yield* params.chat.generateText({
        prompt: iteration === 0 ? params.userPrompt : Prompt.empty,
        toolkit: toolkitBundle.toolkit
      }).pipe(
        Effect.provide(Layer.merge(toolkitBundle.handlerLayer, params.lmLayer)),
        Effect.withSpan("TurnProcessing.generateText")
      )

      const toolCallsThisIteration = response.content.filter((part) => part.type === "tool-call").length
      const nextToolCallsTotal = toolCallsTotal + toolCallsThisIteration
      const mergedParts = [...allParts, ...response.content]
      const mergedUsage = mergeUsage(usage, response.usage)
      const mergedIterationStats = [...iterationStats, {
        iteration: currentIteration,
        finishReason: encodeFinishReason(response.finishReason),
        toolCallsThisIteration,
        toolCallsTotal: nextToolCallsTotal
      }]

      if (response.finishReason === "tool-calls" && currentIteration < params.maxIterations) {
        return yield* loop(
          currentIteration,
          nextToolCallsTotal,
          mergedParts,
          mergedUsage,
          mergedIterationStats
        )
      }

      if (response.finishReason === "tool-calls") {
        const cappedResponse = makeLoopCapResponse(params.maxIterations, mergedUsage)
        const allContentParts = [...mergedParts, ...cappedResponse.content]
        return {
          finalResponse: cappedResponse,
          allContentParts,
          iterationsUsed: currentIteration,
          toolCallsTotal: nextToolCallsTotal,
          iterationStats: mergedIterationStats,
          usage: mergedUsage
        } as const
      }

      return {
        finalResponse: response,
        allContentParts: mergedParts,
        iterationsUsed: currentIteration,
        toolCallsTotal: nextToolCallsTotal,
        iterationStats: mergedIterationStats,
        usage: mergedUsage
      } as const
    })
  })

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
    readonly modelFinishReason: ModelFinishReason
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

const toTurnModelFailure = (
  turnId: string,
  error: unknown
): TurnModelFailure =>
  error instanceof TurnModelFailure
    ? error
    : new TurnModelFailure({
      turnId,
      reason: error instanceof Error ? error.message : String(error)
    })

const zeroUsage = (): Response.Usage =>
  new Response.Usage({
    inputTokens: {
      uncached: 0,
      total: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    outputTokens: {
      total: 0,
      text: 0,
      reasoning: 0
    }
  })

const addOptional = (a: number | undefined, b: number | undefined): number =>
  (a ?? 0) + (b ?? 0)

const mergeUsage = (left: Response.Usage, right: Response.Usage): Response.Usage =>
  new Response.Usage({
    inputTokens: {
      uncached: addOptional(left.inputTokens.uncached, right.inputTokens.uncached),
      total: addOptional(left.inputTokens.total, right.inputTokens.total),
      cacheRead: addOptional(left.inputTokens.cacheRead, right.inputTokens.cacheRead),
      cacheWrite: addOptional(left.inputTokens.cacheWrite, right.inputTokens.cacheWrite)
    },
    outputTokens: {
      total: addOptional(left.outputTokens.total, right.outputTokens.total),
      text: addOptional(left.outputTokens.text, right.outputTokens.text),
      reasoning: addOptional(left.outputTokens.reasoning, right.outputTokens.reasoning)
    }
  })

const makeLoopCapResponse = (
  maxIterations: number,
  usage: Response.Usage
): LanguageModel.GenerateTextResponse<any> =>
  new LanguageModel.GenerateTextResponse([
    Response.makePart("text", {
      text: `Stopped after reaching max tool iterations (${maxIterations}).`
    }),
    Response.makePart("finish", {
      reason: "other",
      usage,
      response: undefined
    })
  ])
