import * as Anthropic from "@effect/ai-anthropic"
import * as OpenAi from "@effect/ai-openai"
import type { SubroutineToolScope } from "@template/domain/memory"
import type { SubroutineTriggerType } from "@template/domain/status"
import { Effect, Layer, Ref, Schema, ServiceMap } from "effect"
import * as Chat from "effect/unstable/ai/Chat"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import type {
  AgentId,
  AuditEntryId,
  ConversationId,
  SessionId,
  TurnId
} from "@template/domain/ids"
import type {
  AuditEntryRecord,
  Instant
} from "@template/domain/ports"
import type { AuthorizationDecision } from "@template/domain/status"
import { AgentConfig } from "../ai/AgentConfig.js"
import { encodeUsageToJson } from "../ai/ContentBlockCodec.js"
import { ModelRegistry } from "../ai/ModelRegistry.js"
import { ToolRegistry, type ToolRegistryService, type CheckpointSignal } from "../ai/ToolRegistry.js"
import { GovernancePortTag } from "../PortTags.js"
import type { LoadedSubroutine } from "./SubroutineCatalog.js"
import {
  toProviderConfigOverride,
  zeroUsage,
  mergeUsage,
  makeLoopCapResponse
} from "../turn/TurnProcessingWorkflow.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubroutineContext {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly turnId: TurnId | null
  readonly triggerType: SubroutineTriggerType
  readonly triggerReason: string
  readonly now: Instant
  readonly runId: string
}

export const SubroutineResult = Schema.Struct({
  subroutineId: Schema.String,
  runId: Schema.String,
  success: Schema.Boolean,
  iterationsUsed: Schema.Number,
  toolCallsTotal: Schema.Number,
  assistantContent: Schema.String,
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  errorMessage: Schema.optionalKey(Schema.String)
})
export type SubroutineResult = typeof SubroutineResult.Type

export class SubroutineExecutionError extends Schema.ErrorClass<SubroutineExecutionError>(
  "SubroutineExecutionError"
)({
  _tag: Schema.tag("SubroutineExecutionError"),
  subroutineId: Schema.String,
  runId: Schema.String,
  reason: Schema.String
}) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SubroutineRunnerService {
  readonly execute: (
    subroutine: LoadedSubroutine,
    context: SubroutineContext
  ) => Effect.Effect<SubroutineResult>
}

export class SubroutineRunner extends ServiceMap.Service<SubroutineRunner>()(
  "server/memory/SubroutineRunner",
  {
    make: Effect.gen(function*() {
      const toolRegistry = yield* ToolRegistry
      const chatPersistence = yield* Chat.Persistence
      const agentConfig = yield* AgentConfig
      const modelRegistry = yield* ModelRegistry
      const governancePort = yield* GovernancePortTag

      const execute: SubroutineRunnerService["execute"] = (subroutine, context) =>
        Effect.gen(function*() {
          // Use originating turnId for audit correlation when available;
          // fall back to synthetic for scheduled/idle triggers where turnId is null.
          const effectiveTurnId = context.turnId ?? (`turn:subroutine:${context.runId}` as TurnId)
          const syntheticChannelId = `channel:subroutine:${context.sessionId}`
          // Always use synthetic conversationId to isolate chat history from user session
          const syntheticConversationId = `conversation:subroutine:${context.runId}` as ConversationId
          const chatSessionKey = `subroutine:${context.runId}`

          // Audit: started
          yield* writeSubroutineAudit(
            governancePort,
            context,
            subroutine,
            "memory_subroutine_started"
          )

          // Resolve model
          const profile = yield* agentConfig.getAgent(context.agentId)
          const modelProvider = subroutine.config.model?.provider ?? profile.model.provider
          const modelId = subroutine.config.model?.modelId ?? profile.model.modelId
          const lmLayer = yield* modelRegistry.get(modelProvider, modelId)

          // Build generation config
          const effectiveGenerationConfig = {
            temperature: profile.generation.temperature,
            maxOutputTokens: profile.generation.maxOutputTokens,
            ...(profile.generation.topP !== undefined ? { topP: profile.generation.topP } : {})
          }

          // Set up isolated chat
          const chat = yield* chatPersistence.getOrCreate(chatSessionKey)
          const currentHistory = yield* Ref.get(chat.history)
          const withSystem = Prompt.setSystem(currentHistory, subroutine.prompt)
          yield* Ref.set(chat.history, withSystem)

          // Build user prompt
          const userPrompt = buildTriggerPrompt(context)

          // Run bounded tool loop
          const loopResult = yield* subroutineToolLoop({
            chat,
            toolRegistry,
            lmLayer,
            resolvedProvider: modelProvider,
            effectiveGenerationConfig,
            context: {
              agentId: context.agentId,
              sessionId: context.sessionId,
              conversationId: syntheticConversationId,
              turnId: effectiveTurnId,
              now: context.now,
              channelId: syntheticChannelId
            },
            userPrompt,
            maxIterations: subroutine.config.maxIterations,
            toolScope: subroutine.resolvedToolScope
          })

          // Extract assistant text
          const assistantContent = loopResult.allContentParts
            .filter((part) => part.type === "text")
            .map((part) => (part as { readonly text: string }).text)
            .join("")

          // Encode usage
          const modelUsageJson = yield* encodeUsageToJson(loopResult.usage).pipe(
            Effect.catch(() => Effect.succeed(null))
          )

          // Audit: completed
          yield* writeSubroutineAudit(
            governancePort,
            context,
            subroutine,
            "memory_subroutine_completed"
          )

          return {
            subroutineId: subroutine.config.id,
            runId: context.runId,
            success: true,
            iterationsUsed: loopResult.iterationsUsed,
            toolCallsTotal: loopResult.toolCallsTotal,
            assistantContent,
            modelUsageJson
          } satisfies SubroutineResult
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function*() {
              // Audit: failed
              yield* writeSubroutineAudit(
                governancePort,
                context,
                subroutine,
                "memory_subroutine_failed"
              ).pipe(Effect.ignore)

              const reason = error instanceof Error
                ? error.message
                : typeof error === "object" && error !== null && "message" in error
                  && typeof (error as { message?: unknown }).message === "string"
                  ? (error as { message: string }).message
                  : String(error)

              return {
                subroutineId: subroutine.config.id,
                runId: context.runId,
                success: false,
                iterationsUsed: 0,
                toolCallsTotal: 0,
                assistantContent: "",
                modelUsageJson: null,
                errorMessage: reason
              } satisfies SubroutineResult
            })
          )
        )

      return { execute } satisfies SubroutineRunnerService
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

// ---------------------------------------------------------------------------
// Bounded Tool Loop (adapted from TurnProcessingWorkflow.processWithToolLoop)
// ---------------------------------------------------------------------------

interface SubroutineToolLoopResult {
  readonly allContentParts: ReadonlyArray<Response.Part<any>>
  readonly iterationsUsed: number
  readonly toolCallsTotal: number
  readonly usage: Response.Usage
}

const subroutineToolLoop = (params: {
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
  }
  readonly userPrompt: string
  readonly maxIterations: number
  readonly toolScope: SubroutineToolScope
}): Effect.Effect<SubroutineToolLoopResult, unknown, never> => {
  const checkpointSignalsRef = Ref.makeUnsafe<ReadonlyArray<CheckpointSignal>>([])

  return Effect.suspend(function loop(
    iteration = 0,
    toolCallsTotal = 0,
    allParts: ReadonlyArray<Response.Part<any>> = [],
    usage = zeroUsage()
  ): Effect.Effect<SubroutineToolLoopResult, unknown, never> {
    const currentIteration = iteration + 1

    return Effect.gen(function*() {
      const toolkitBundle = yield* params.toolRegistry.makeToolkit(
        { ...params.context, iteration },
        checkpointSignalsRef,
        params.toolScope
      )

      const generateTextEffect = params.chat.generateText({
        prompt: iteration === 0 ? params.userPrompt : Prompt.empty,
        toolkit: toolkitBundle.toolkit
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
        Effect.withSpan("SubroutineRunner.generateText")
      )

      const toolCallsThisIteration = response.content.filter((part) => part.type === "tool-call").length
      const nextToolCallsTotal = toolCallsTotal + toolCallsThisIteration
      const mergedParts = [...allParts, ...response.content]
      const mergedUsage = mergeUsage(usage, response.usage)

      if (response.finishReason === "tool-calls" && currentIteration < params.maxIterations) {
        return yield* loop(
          currentIteration,
          nextToolCallsTotal,
          mergedParts,
          mergedUsage
        )
      }

      if (response.finishReason === "tool-calls") {
        const cappedResponse = makeLoopCapResponse(params.maxIterations, mergedUsage)
        const allContentParts = [...mergedParts, ...cappedResponse.content]
        return {
          allContentParts,
          iterationsUsed: currentIteration,
          toolCallsTotal: nextToolCallsTotal,
          usage: mergedUsage
        } as const
      }

      return {
        allContentParts: mergedParts,
        iterationsUsed: currentIteration,
        toolCallsTotal: nextToolCallsTotal,
        usage: mergedUsage
      } as const
    })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SubroutineAuditReason =
  | "memory_subroutine_started"
  | "memory_subroutine_completed"
  | "memory_subroutine_failed"

const writeSubroutineAudit = (
  governancePort: {
    readonly writeAudit: (entry: AuditEntryRecord) => Effect.Effect<void>
  },
  context: SubroutineContext,
  subroutine: LoadedSubroutine,
  reason: SubroutineAuditReason,
  decision: AuthorizationDecision = "Allow"
) =>
  governancePort.writeAudit({
    auditEntryId: `audit:subroutine:${context.runId}:${reason}` as AuditEntryId,
    agentId: context.agentId,
    sessionId: context.sessionId,
    decision,
    reason: `${reason}:${subroutine.config.id}`,
    createdAt: context.now
  })

export const buildTriggerPrompt = (context: SubroutineContext): string => {
  const parts = [
    "Execute your memory routine.",
    `Trigger: ${context.triggerType}`,
    `Session: ${context.sessionId}`,
    `Time: ${context.now.toJSON()}`
  ]
  if (context.triggerReason) {
    parts.push(`Reason: ${context.triggerReason}`)
  }
  return parts.join(" | ")
}
