import * as Anthropic from "@effect/ai-anthropic"
import * as OpenAi from "@effect/ai-openai"
import { DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
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
  ChannelId,
  CheckpointId,
  ConversationId,
  MessageId,
  PolicyId,
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
import { ToolRegistry, type ToolRegistryService, type CheckpointSignal } from "../ai/ToolRegistry.js"
import { SubroutineControlPlane } from "../memory/SubroutineControlPlane.js"
import { TranscriptProjector } from "../memory/TranscriptProjector.js"
import {
  AgentStatePortTag,
  CheckpointPortTag,
  GovernancePortTag,
  SessionTurnPortTag
} from "../PortTags.js"


export const TurnAuditReasonCode = Schema.Literals([
  "turn_processing_accepted",
  "turn_processing_policy_denied",
  "turn_processing_requires_approval",
  "turn_processing_checkpoint_required",
  "turn_processing_token_budget_exceeded",
  "turn_processing_provider_credit_exhausted",
  "turn_processing_model_error"
])
export type TurnAuditReasonCode = typeof TurnAuditReasonCode.Type

export const ProcessTurnPayload = Schema.Struct({
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  agentId: Schema.String,
  userId: Schema.String,
  channelId: Schema.String,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlockSchema),
  createdAt: Schema.DateTimeUtc,
  inputTokens: Schema.Number,
  checkpointId: Schema.optionalKey(Schema.String),
  modelOverride: Schema.optionalKey(Schema.Struct({
    provider: Schema.String,
    modelId: Schema.String
  })),
  generationConfigOverride: Schema.optionalKey(Schema.Struct({
    temperature: Schema.optionalKey(Schema.Number),
    maxOutputTokens: Schema.optionalKey(Schema.Number),
    topP: Schema.optionalKey(Schema.Number)
  }))
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
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  checkpointId: Schema.optionalKey(Schema.String),
  checkpointAction: Schema.optionalKey(Schema.String),
  checkpointReason: Schema.optionalKey(Schema.String)
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

export const toProviderConfigOverride = (
  provider: string,
  config: {
    readonly temperature?: number
    readonly maxOutputTokens?: number
    readonly topP?: number
  }
): Record<string, unknown> => {
  const overrides: Record<string, unknown> = {}
  if (config.temperature !== undefined) overrides.temperature = config.temperature
  if (config.topP !== undefined) overrides.top_p = config.topP

  switch (provider) {
    case "anthropic":
      if (config.maxOutputTokens !== undefined) overrides.max_tokens = config.maxOutputTokens
      break
    case "openai":
    case "openrouter":
    case "google":
      if (config.maxOutputTokens !== undefined) overrides.max_output_tokens = config.maxOutputTokens
      break
  }
  return overrides
}

export const inferToolChoice = (
  rawUserContent: string
): { readonly toolChoice: { readonly tool: "shell_execute" } } | {} => {
  const normalized = rawUserContent.trim().toLowerCase()
  if (normalized.length === 0) return {}

  if (
    normalized.startsWith("run ")
    || normalized.startsWith("execute ")
    || /^ls(\s|$)/.test(normalized)
    || /^pwd(\s|$)/.test(normalized)
    || /^cat(\s|$)/.test(normalized)
    || /^echo(\s|$)/.test(normalized)
  ) {
    return { toolChoice: { tool: "shell_execute" } }
  }

  return {}
}

const makePayloadHash = (
  action: string,
  toolName: string,
  canonicalInputJson: string
): Effect.Effect<string> =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${action}:${toolName}:${canonicalInputJson}`)
    )
  ).pipe(
    Effect.map((buffer) => {
      const hex = Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("")
      return hex
    })
  )

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
    const agentConfig = yield* AgentConfig
    const modelRegistry = yield* ModelRegistry
    const checkpointPort = yield* CheckpointPortTag
    const subroutineControlPlane = yield* SubroutineControlPlane
    const transcriptProjector = yield* TranscriptProjector

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
      if (payload.checkpointId !== undefined) {
        // Replay path: validate approved checkpoint
        const checkpoint = yield* checkpointPort.get(payload.checkpointId as CheckpointId)
        if (checkpoint === null || checkpoint.status !== "Approved" || checkpoint.action !== "ReadMemory") {
          return yield* new TurnPolicyDenied({
            turnId: payload.turnId,
            reason: `checkpoint not valid for ReadMemory bypass (status: ${checkpoint?.status ?? "not found"}, action: ${checkpoint?.action ?? "unknown"})`
          })
        }
        const expectedHash = yield* makePayloadHash("ReadMemory", "", "")
        if (expectedHash !== checkpoint.payloadHash) {
          return yield* new TurnPolicyDenied({
            turnId: payload.turnId,
            reason: "checkpoint_payload_mismatch"
          })
        }
        // Checkpoint valid — bypass the gate and continue processing
      } else {
        // First run: create a Pending checkpoint and return non-accepted result.
        const checkpointPayload = Schema.encodeSync(Schema.UnknownFromJsonString)({
          kind: "ReadMemory",
          content: payload.content,
          contentBlocks: payload.contentBlocks,
          turnContext: {
            agentId: payload.agentId,
            sessionId: payload.sessionId,
            conversationId: payload.conversationId,
            channelId: payload.channelId,
            turnId: payload.turnId,
            createdAt: DateTime.formatIso(payload.createdAt)
          }
        })
        const newCheckpointId = (`checkpoint:${crypto.randomUUID()}`) as CheckpointId
        yield* checkpointPort.create({
          checkpointId: newCheckpointId,
          agentId: payload.agentId as AgentId,
          sessionId: payload.sessionId as SessionId,
          channelId: payload.channelId as ChannelId,
          turnId: payload.turnId,
          action: "ReadMemory",
          policyId: policy.policyId as PolicyId | null,
          reason: policy.reason,
          payloadJson: checkpointPayload,
          payloadHash: yield* makePayloadHash("ReadMemory", "", ""),
          status: "Pending",
          requestedAt: payload.createdAt,
          decidedAt: null,
          decidedBy: null,
          consumedAt: null,
          consumedBy: null,
          expiresAt: null
        })
        yield* writeAuditEntry(
          governancePort,
          payload,
          "RequireApproval",
          "turn_processing_checkpoint_required"
        )
        return {
          turnId: payload.turnId,
          accepted: false,
          auditReasonCode: "turn_processing_checkpoint_required",
          assistantContent: "",
          assistantContentBlocks: [],
          iterationsUsed: 0,
          toolCallsTotal: 0,
          iterationStats: [],
          modelFinishReason: null,
          modelUsageJson: null,
          checkpointId: newCheckpointId,
          checkpointAction: "ReadMemory",
          checkpointReason: policy.reason
        } satisfies ProcessTurnResult
      }
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

    const checkpointSignalsRef = yield* Ref.make<ReadonlyArray<CheckpointSignal>>([])

    const modelOutcome = yield* Effect.gen(function*() {
      // Resolve agent profile and model layer
      const profile = yield* agentConfig.getAgent(payload.agentId)

      // Resolve model: per-request override > agent profile default
      const modelProvider = payload.modelOverride?.provider ?? profile.model.provider
      const modelId = payload.modelOverride?.modelId ?? profile.model.modelId
      const lmLayer = yield* modelRegistry.get(modelProvider, modelId)

      // Build effective generation config: profile baseline + overrides
      const effectiveGenerationConfig = {
        temperature: payload.generationConfigOverride?.temperature ?? profile.generation.temperature,
        maxOutputTokens: payload.generationConfigOverride?.maxOutputTokens ?? profile.generation.maxOutputTokens,
        ...(payload.generationConfigOverride?.topP !== undefined
          ? { topP: payload.generationConfigOverride.topP }
          : profile.generation.topP !== undefined
          ? { topP: profile.generation.topP }
          : {})
      }

      const chat = yield* chatPersistence.getOrCreate(payload.sessionId)

      const baseSystemPrompt = profile.persona.systemPrompt

      const currentHistory = yield* Ref.get(chat.history)
      const withSystem = Prompt.setSystem(currentHistory, baseSystemPrompt)
      yield* Ref.set(chat.history, withSystem)

      const userPrompt = toPromptText(payload.content, payload.contentBlocks)

      const loopResultOption = yield* processWithToolLoop({
        chat,
        toolRegistry,
        lmLayer,
        resolvedProvider: modelProvider,
        effectiveGenerationConfig,
        context: {
          agentId: payload.agentId as AgentId,
          sessionId: payload.sessionId as SessionId,
          conversationId: payload.conversationId as ConversationId,
          turnId: payload.turnId as TurnId,
          now: payload.createdAt,
          channelId: payload.channelId,
          userId: payload.userId,
          ...(payload.checkpointId !== undefined
            ? {
              checkpointId: payload.checkpointId,
              checkpointAction: "ReadMemory" as const
            }
            : {})
        },
        rawUserContent: payload.content,
        userPrompt,
        maxIterations: maxToolIterations,
        checkpointSignalsRef
      }).pipe(
        Effect.timeoutOption(`${TURN_LOOP_TIMEOUT_SECONDS} seconds`)
      )

      if (Option.isNone(loopResultOption)) {
        return yield* new TurnModelFailure({
          turnId: payload.turnId,
          reason: "tool_loop_timeout"
        })
      }

      return { _outcome: "success" as const, result: loopResultOption.value }
    }).pipe(
      Effect.catch((error) => {
        // Tool governance RequiresApproval — the @effect/ai framework does not
        // catch tool handler failures, so they propagate here. When a tool needed
        // approval, a checkpoint signal was already stored in checkpointSignalsRef.
        // Return it as a checkpoint outcome instead of failing the turn.
        const isRequiresApproval = typeof error === "object" && error !== null
          && "errorCode" in error && (error as any).errorCode === "RequiresApproval"

        if (isRequiresApproval) {
          return Ref.get(checkpointSignalsRef).pipe(
            Effect.flatMap((signals) => {
              if (signals.length > 0) {
                return Effect.succeed({
                  _outcome: "checkpoint" as const,
                  signals
                })
              }
              // No signals despite RequiresApproval — treat as model error
              const modelFailure = toTurnModelFailure(payload.turnId, error)
              return writeAuditEntry(
                governancePort,
                payload,
                "Deny",
                toModelFailureAuditReason(modelFailure.reason)
              ).pipe(
                Effect.andThen(Effect.fail(modelFailure))
              )
            })
          )
        }

        const modelFailure = toTurnModelFailure(payload.turnId, error)
        return writeAuditEntry(
          governancePort,
          payload,
          "Deny",
          toModelFailureAuditReason(modelFailure.reason)
        ).pipe(
          Effect.andThen(Effect.fail(modelFailure))
        )
      })
    )

    // Tool governance checkpoint — return early with checkpoint result
    if (modelOutcome._outcome === "checkpoint") {
      const firstSignal = modelOutcome.signals[0]!
      yield* writeAuditEntry(
        governancePort,
        payload,
        "RequireApproval",
        "turn_processing_checkpoint_required"
      )
      return {
        turnId: payload.turnId,
        accepted: false,
        auditReasonCode: "turn_processing_checkpoint_required",
        assistantContent: "",
        assistantContentBlocks: [],
        iterationsUsed: 0,
        toolCallsTotal: 0,
        iterationStats: [],
        modelFinishReason: null,
        modelUsageJson: null,
        checkpointId: firstSignal.checkpointId,
        checkpointAction: firstSignal.action,
        checkpointReason: firstSignal.reason
      } satisfies ProcessTurnResult
    }

    const modelResult = modelOutcome.result

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

    // 7b: Tool-loop signal drain — check if any tool required approval during the loop
    const checkpointSignals = yield* Ref.get(checkpointSignalsRef)
    if (checkpointSignals.length > 0) {
      const firstSignal = checkpointSignals[0]
      yield* writeAuditEntry(
        governancePort,
        payload,
        "RequireApproval",
        "turn_processing_checkpoint_required"
      )
      return {
        turnId: payload.turnId,
        accepted: false,
        auditReasonCode: "turn_processing_checkpoint_required",
        assistantContent: assistantResult.assistantContent,
        assistantContentBlocks: assistantResult.assistantContentBlocks,
        iterationsUsed: assistantResult.iterationsUsed,
        toolCallsTotal: assistantResult.toolCallsTotal,
        iterationStats: assistantResult.iterationStats,
        modelFinishReason,
        modelUsageJson: assistantResult.modelUsageJson,
        checkpointId: firstSignal.checkpointId,
        checkpointAction: firstSignal.action,
        checkpointReason: firstSignal.reason
      } satisfies ProcessTurnResult
    }

    yield* writeAuditEntry(
      governancePort,
      payload,
      "Allow",
      "turn_processing_accepted"
    )

    // Dispatch post-turn memory subroutines (fire-and-forget)
    yield* subroutineControlPlane.dispatchByTrigger("PostTurn", {
      agentId: payload.agentId as AgentId,
      sessionId: payload.sessionId as SessionId,
      conversationId: payload.conversationId as ConversationId,
      turnId: payload.turnId as TurnId,
      now: payload.createdAt
    }).pipe(Effect.ignore)

    // Project transcript for accepted turn (fire-and-forget)
    yield* transcriptProjector.appendTurn(
      payload.agentId as AgentId,
      payload.sessionId as SessionId,
      makeAssistantTurn(payload, {
        assistantContent: assistantResult.assistantContent,
        assistantContentBlocks: assistantResult.assistantContentBlocks,
        modelFinishReason,
        modelUsageJson: assistantResult.modelUsageJson
      })
    ).pipe(Effect.ignore)

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
  readonly resolvedProvider: string
  readonly effectiveGenerationConfig: {
    readonly temperature?: number
    readonly maxOutputTokens?: number
    readonly topP?: number
  }
  readonly context: {
    readonly agentId: AgentId
    readonly sessionId: SessionId
    readonly conversationId: ConversationId
    readonly turnId: TurnId
    readonly now: Instant
    readonly channelId: string
    readonly checkpointId?: string
    readonly checkpointAction?: string
    readonly userId?: string
  }
  readonly rawUserContent: string
  readonly userPrompt: string
  readonly maxIterations: number
  readonly checkpointSignalsRef: Ref.Ref<ReadonlyArray<CheckpointSignal>>
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
      const toolkitBundle = yield* params.toolRegistry.makeToolkit(
        { ...params.context, iteration },
        params.checkpointSignalsRef
      )

      const generateTextEffect = params.chat.generateText({
        prompt: iteration === 0 ? params.userPrompt : Prompt.empty,
        toolkit: toolkitBundle.toolkit,
        ...(iteration === 0
          ? inferToolChoice(params.rawUserContent)
          : {})
      })

      // Apply generation config via provider-specific withConfigOverride
      const providerOverrides = toProviderConfigOverride(
        params.resolvedProvider,
        params.effectiveGenerationConfig
      )
      const configuredEffect = Object.keys(providerOverrides).length > 0
        ? (params.resolvedProvider === "anthropic"
            ? Anthropic.AnthropicLanguageModel.withConfigOverride(providerOverrides as any)(generateTextEffect)
            : OpenAi.OpenAiLanguageModel.withConfigOverride(providerOverrides as any)(generateTextEffect))
        : generateTextEffect

      const response = yield* configuredEffect.pipe(
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

export const makeUserTurn = (payload: ProcessTurnPayload): TurnRecord => ({
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

export const makeAssistantTurn = (
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

export const toPromptText = (
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

export const toTurnModelFailure = (
  turnId: string,
  error: unknown
): TurnModelFailure =>
  error instanceof TurnModelFailure
    ? new TurnModelFailure({
      turnId: error.turnId,
      reason: normalizeModelFailureReason(error.reason)
    })
    : new TurnModelFailure({
      turnId,
      reason: normalizeModelFailureReason(toModelFailureMessage(error))
    })

export const toModelFailureMessage = (error: unknown): string => {
  if (typeof error === "string") {
    return error
  }
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "object" && error !== null) {
    if ("reason" in error && typeof error.reason === "string" && error.reason.length > 0) {
      return error.reason
    }
    if ("message" in error && typeof error.message === "string" && error.message.length > 0) {
      return error.message
    }
  }
  return String(error)
}

export const toModelFailureAuditReason = (
  reason: string
): TurnAuditReasonCode =>
  isProviderCreditExhaustedReason(reason)
    ? "turn_processing_provider_credit_exhausted"
    : "turn_processing_model_error"

export const isProviderCreditExhaustedReason = (reason: string): boolean =>
  reason.startsWith("provider_credit_exhausted:")

export const normalizeModelFailureReason = (reason: string): string => {
  const trimmed = reason.trim()
  if (trimmed.length === 0) {
    return "model_error"
  }
  if (isProviderCreditExhaustedReason(trimmed)) {
    return trimmed
  }
  return looksLikeProviderCreditExhausted(trimmed)
    ? `provider_credit_exhausted: ${trimmed}`
    : trimmed
}

export const looksLikeProviderCreditExhausted = (reason: string): boolean => {
  const normalized = reason.toLowerCase()
  return normalized.includes("credit balance is too low")
    || normalized.includes("insufficient credits")
    || normalized.includes("insufficient_quota")
    || normalized.includes("billing")
}

export const zeroUsage = (): Response.Usage =>
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

export const addOptional = (a: number | undefined, b: number | undefined): number =>
  (a ?? 0) + (b ?? 0)

export const mergeUsage = (left: Response.Usage, right: Response.Usage): Response.Usage =>
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

export const makeLoopCapResponse = (
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
