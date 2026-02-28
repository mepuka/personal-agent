import { ChannelNotFound, ChannelTypeMismatch } from "@template/domain/errors"
import type { CheckpointAlreadyDecided, CheckpointExpired, CheckpointNotFound } from "@template/domain/errors"
import type { TurnStreamEvent } from "@template/domain/events"
import type { AgentId, ChannelId, CheckpointId, ConversationId, SessionId } from "@template/domain/ids"
import {
  InvokeToolReplayPayload,
  ReadMemoryReplayPayload,
  type AgentState,
  type CheckpointRecord,
  type ContentBlock,
  type TurnRecord
} from "@template/domain/ports"
import type { ChannelCapability, ChannelType } from "@template/domain/status"
import { Cause, DateTime, Effect, Layer, Option, Schema, ServiceMap, Stream } from "effect"
import { Sharding } from "effect/unstable/cluster"
import { SessionEntity } from "./entities/SessionEntity.js"
import { AgentConfig } from "./ai/AgentConfig.js"
import { ToolRegistry } from "./ai/ToolRegistry.js"
import { AgentStatePortTag, ChannelPortTag, CheckpointPortTag, SessionTurnPortTag } from "./PortTags.js"
import { TurnProcessingRuntime } from "./turn/TurnProcessingRuntime.js"
import type { ProcessTurnPayload, TurnProcessingError } from "./turn/TurnProcessingWorkflow.js"
import { TurnModelFailure } from "./turn/TurnProcessingWorkflow.js"

const toSessionId = (channelId: ChannelId): SessionId => (`session:${channelId}`) as SessionId

const toConversationId = (channelId: ChannelId): ConversationId => (`conv:${channelId}`) as ConversationId

export class ChannelCore extends ServiceMap.Service<ChannelCore>()(
  "server/ChannelCore",
  {
    make: Effect.gen(function*() {
      const channelPort = yield* ChannelPortTag
      const agentStatePort = yield* AgentStatePortTag
      const sessionTurnPort = yield* SessionTurnPortTag
      const checkpointPort = yield* CheckpointPortTag
      const runtime = yield* TurnProcessingRuntime
      const sharding = yield* Sharding.Sharding
      const agentConfig = yield* AgentConfig
      const toolRegistry = yield* ToolRegistry

      const decodeReplayPayloadJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
      const decodeInvokeToolReplayPayload = Schema.decodeUnknownOption(InvokeToolReplayPayload)
      const decodeReadMemoryReplayPayload = Schema.decodeUnknownOption(ReadMemoryReplayPayload)

      const replayFailureStream = (
        turnId: string,
        reason: string
      ): Stream.Stream<TurnStreamEvent, TurnProcessingError> =>
        Stream.fail(
          new TurnModelFailure({
            turnId,
            reason
          })
        )

      const withConsumedTransition = (
        checkpointId: CheckpointId,
        decidedBy: string,
        stream: Stream.Stream<TurnStreamEvent, TurnProcessingError>
      ): Stream.Stream<TurnStreamEvent, TurnProcessingError> =>
        Stream.concat(
          stream,
          Stream.fromEffect(
            DateTime.now.pipe(
              Effect.flatMap((consumedAt) =>
                checkpointPort.transition(
                  checkpointId,
                  "Consumed",
                  decidedBy,
                  consumedAt
                )
              ),
              Effect.catchCause(() => Effect.void)
            )
          ).pipe(Stream.drain)
        )

      const toInvokeToolReplayStream = (params: {
        readonly turnId: string
        readonly sessionId: SessionId
        readonly createdAt: ProcessTurnPayload["createdAt"]
        readonly toolName: string
        readonly inputJson: string
        readonly outputJson: string
        readonly isError: boolean
      }): Stream.Stream<TurnStreamEvent, TurnProcessingError> => {
        const toolCallId = `toolcall:${params.turnId}:replay`
        const baseEvents: ReadonlyArray<TurnStreamEvent> = [
          {
            type: "turn.started",
            sequence: 1,
            turnId: params.turnId,
            sessionId: params.sessionId,
            createdAt: params.createdAt
          },
          {
            type: "tool.call",
            sequence: 2,
            turnId: params.turnId,
            sessionId: params.sessionId,
            toolCallId,
            toolName: params.toolName,
            inputJson: params.inputJson
          },
          {
            type: "tool.result",
            sequence: 3,
            turnId: params.turnId,
            sessionId: params.sessionId,
            toolCallId,
            toolName: params.toolName,
            outputJson: params.outputJson,
            isError: params.isError
          }
        ]

        if (params.isError) {
          return Stream.concat(
            Stream.fromIterable(baseEvents),
            replayFailureStream(
              params.turnId,
              `checkpoint_tool_replay_failed:${params.toolName}`
            )
          )
        }

        const completedEvent: TurnStreamEvent = {
          type: "turn.completed",
          sequence: 4,
          turnId: params.turnId,
          sessionId: params.sessionId,
          accepted: true,
          auditReasonCode: "turn_processing_accepted",
          iterationsUsed: 1,
          toolCallsTotal: 1,
          modelFinishReason: "tool-calls",
          modelUsageJson: null
        }

        return Stream.fromIterable([...baseEvents, completedEvent])
      }

      const ensureAgentState = (agentId: AgentId) =>
        Effect.gen(function*() {
          const existing = yield* agentStatePort.get(agentId)
          if (existing !== null) {
            return
          }

          const profile = yield* agentConfig.getAgent(agentId as string).pipe(Effect.orDie)
          yield* agentStatePort.upsert(
            {
              agentId,
              permissionMode: "Standard",
              tokenBudget: profile.runtime.tokenBudget,
              maxToolIterations: profile.runtime.maxToolIterations,
              quotaPeriod: "Daily",
              tokensConsumed: 0,
              budgetResetAt: null
            } satisfies AgentState
          )
        })

      const initializeChannel = (params: {
        readonly channelId: ChannelId
        readonly channelType: ChannelType
        readonly agentId: AgentId
        readonly capabilities: ReadonlyArray<ChannelCapability>
      }) =>
        Effect.gen(function*() {
          const existing = yield* channelPort.get(params.channelId)
          if (existing !== null) {
            if (existing.channelType !== params.channelType) {
              return yield* new ChannelTypeMismatch({
                channelId: params.channelId,
                existingType: existing.channelType,
                requestedType: params.channelType
              })
            }
            if (existing.agentId !== params.agentId) {
              return yield* new ChannelTypeMismatch({
                channelId: params.channelId,
                existingType: existing.agentId,
                requestedType: params.agentId
              })
            }
            yield* ensureAgentState(existing.agentId)
            return
          }

          const sessionId = toSessionId(params.channelId)
          const conversationId = toConversationId(params.channelId)
          const now = yield* DateTime.now

          yield* ensureAgentState(params.agentId)

          const profile = yield* agentConfig.getAgent(params.agentId as string).pipe(Effect.orDie)
          yield* sessionTurnPort.startSession({
            sessionId,
            conversationId,
            tokenCapacity: profile.runtime.tokenBudget,
            tokensUsed: 0
          })

          yield* channelPort.create({
            channelId: params.channelId,
            channelType: params.channelType,
            agentId: params.agentId,
            activeSessionId: sessionId,
            activeConversationId: conversationId,
            capabilities: params.capabilities,
            modelOverride: null,
            generationConfigOverride: null,
            createdAt: now
          })
        })

      const buildTurnPayload = (params: {
        readonly channelId: ChannelId
        readonly content: string
        readonly contentBlocks: ReadonlyArray<ContentBlock>
        readonly userId: string
        readonly modelOverride?: { readonly provider: string; readonly modelId: string } | undefined
        readonly generationConfigOverride?: {
          readonly temperature?: number
          readonly maxOutputTokens?: number
          readonly topP?: number
        } | undefined
      }) =>
        Effect.gen(function*() {
          const channel = yield* channelPort.get(params.channelId)
          if (channel === null) {
            return yield* new ChannelNotFound({ channelId: params.channelId })
          }

          const turnId = `turn:${crypto.randomUUID()}`
          const now = yield* DateTime.now

          // Precedence: per-request > session-level (channel) > profile default (resolved in workflow)
          const effectiveModelOverride = params.modelOverride ?? (channel.modelOverride ?? undefined)

          // Merge generation config field-by-field: request > session > (profile resolved in workflow)
          const requestGen = params.generationConfigOverride
          const sessionGen = channel.generationConfigOverride
          const effectiveGenerationConfig = (requestGen || sessionGen)
            ? { ...(sessionGen ?? {}), ...(requestGen ?? {}) }
            : undefined

          const payload: ProcessTurnPayload = {
            turnId,
            sessionId: channel.activeSessionId,
            conversationId: channel.activeConversationId,
            agentId: channel.agentId,
            userId: params.userId,
            channelId: params.channelId,
            content: params.content,
            contentBlocks: params.contentBlocks,
            createdAt: now,
            inputTokens: estimateInputTokens(params.content, params.contentBlocks),
            ...(effectiveModelOverride ? { modelOverride: effectiveModelOverride } : {}),
            ...(effectiveGenerationConfig ? { generationConfigOverride: effectiveGenerationConfig } : {})
          }

          return payload
        })

      const canUseSessionClient = typeof (sharding as { makeClient?: unknown }).makeClient === "function"

      const processTurn = (
        turnPayload: ProcessTurnPayload
      ): Stream.Stream<TurnStreamEvent, TurnProcessingError> => {
        const failWithModelFailure = (reason: string): Stream.Stream<TurnStreamEvent, TurnProcessingError> =>
          Stream.fail(
            new TurnModelFailure({
              turnId: turnPayload.turnId,
              reason
            })
          )

        // Entity.makeTestClient mock sharding does not expose makeClient.
        if (!canUseSessionClient) {
          return runtime.processTurnStream(turnPayload)
        }

        return Stream.unwrap(
          SessionEntity.client.pipe(
            Effect.map((makeSessionClient) =>
              makeSessionClient(turnPayload.sessionId).processTurn(turnPayload).pipe(
                Stream.catchTags({
                  MailboxFull: () => failWithModelFailure("session_entity_mailbox_full"),
                  AlreadyProcessingMessage: () => failWithModelFailure("session_entity_already_processing"),
                  PersistenceError: (error) =>
                    failWithModelFailure(
                      `session_entity_persistence_error: ${error.message ?? String(error)}`
                    )
                }),
                Stream.catchCause((cause) =>
                  failWithModelFailure(
                    describeSessionEntityCause("session_entity_stream_error", cause)
                  )
                )
              )
            ),
            Effect.catchCause((cause) =>
              Effect.succeed(
                failWithModelFailure(
                  describeSessionEntityCause("session_entity_client_error", cause)
                )
              )
            )
          )
        ) as Stream.Stream<TurnStreamEvent, TurnProcessingError>
      }

      const getHistory = (channelId: ChannelId) =>
        Effect.gen(function*() {
          const channel = yield* channelPort.get(channelId)
          if (channel === null) {
            return yield* new ChannelNotFound({ channelId })
          }
          return yield* sessionTurnPort.listTurns(channel.activeSessionId)
        })

      const setModelPreference = (params: {
        readonly channelId: ChannelId
        readonly modelOverride?: { readonly provider: string; readonly modelId: string } | null | undefined
        readonly generationConfigOverride?: {
          readonly temperature?: number
          readonly maxOutputTokens?: number
          readonly topP?: number
        } | null | undefined
      }) =>
        Effect.gen(function*() {
          const channel = yield* channelPort.get(params.channelId)
          if (channel === null) {
            return yield* new ChannelNotFound({ channelId: params.channelId })
          }
          const update: Record<string, unknown> = {}
          if ("modelOverride" in params) update.modelOverride = params.modelOverride ?? null
          if ("generationConfigOverride" in params) update.generationConfigOverride = params.generationConfigOverride ?? null
          yield* channelPort.updateModelPreference(params.channelId, update as any)
        })

      const listPendingCheckpoints = (agentId?: AgentId) =>
        checkpointPort.listPending(agentId)

      const getCheckpoint = (checkpointId: CheckpointId) =>
        checkpointPort.get(checkpointId)

      const decideCheckpoint = (params: {
        readonly checkpointId: CheckpointId
        readonly decision: "Approved" | "Rejected" | "Deferred"
        readonly decidedBy: string
      }) =>
        Effect.gen(function*() {
          const now = yield* DateTime.now
          yield* checkpointPort.transition(
            params.checkpointId,
            params.decision,
            params.decidedBy,
            now
          )

          if (params.decision !== "Approved") {
            return { ok: true as const, kind: "ack" as const }
          }

          // Approved: load checkpoint and replay
          const checkpoint = yield* checkpointPort.get(params.checkpointId)
          if (checkpoint === null) {
            return {
              ok: true as const,
              kind: "stream" as const,
              stream: replayFailureStream(
                `turn:replay:${crypto.randomUUID()}`,
                "checkpoint_not_found_after_transition"
              )
            }
          }

          if (checkpoint.action === "InvokeTool") {
            const parsedJson = decodeReplayPayloadJson(checkpoint.payloadJson)
            if (parsedJson._tag === "None") {
              return {
                ok: true as const,
                kind: "stream" as const,
                stream: replayFailureStream(
                  `turn:replay:${crypto.randomUUID()}`,
                  "checkpoint_payload_invalid_json"
                )
              }
            }
            const decodedPayload = decodeInvokeToolReplayPayload(parsedJson.value)
            if (decodedPayload._tag === "None") {
              return {
                ok: true as const,
                kind: "stream" as const,
                stream: replayFailureStream(
                  `turn:replay:${crypto.randomUUID()}`,
                  "checkpoint_payload_invalid_invoke_tool"
                )
              }
            }

            const toolReplay = yield* toolRegistry.executeApprovedCheckpointTool({
              checkpointId: params.checkpointId,
              payloadJson: checkpoint.payloadJson,
              agentId: checkpoint.agentId,
              sessionId: checkpoint.sessionId,
              conversationId: decodedPayload.value.turnContext.conversationId as ConversationId,
              channelId: decodedPayload.value.turnContext.channelId as ChannelId,
              decidedBy: params.decidedBy,
              now
            })

            return {
              ok: true as const,
              kind: "stream" as const,
              stream: withConsumedTransition(
                params.checkpointId,
                params.decidedBy,
                toInvokeToolReplayStream({
                  turnId: toolReplay.turnId,
                  sessionId: checkpoint.sessionId,
                  createdAt: toolReplay.createdAt,
                  toolName: toolReplay.toolName,
                  inputJson: toolReplay.inputJson,
                  outputJson: toolReplay.outputJson,
                  isError: toolReplay.isError
                })
              )
            }
          }

          if (checkpoint.action === "ReadMemory") {
            const parsedJson = decodeReplayPayloadJson(checkpoint.payloadJson)
            if (parsedJson._tag === "None") {
              return {
                ok: true as const,
                kind: "stream" as const,
                stream: replayFailureStream(
                  `turn:replay:${crypto.randomUUID()}`,
                  "checkpoint_payload_invalid_json"
                )
              }
            }
            const decodedPayload = decodeReadMemoryReplayPayload(parsedJson.value)
            if (decodedPayload._tag === "None") {
              return {
                ok: true as const,
                kind: "stream" as const,
                stream: replayFailureStream(
                  `turn:replay:${crypto.randomUUID()}`,
                  "checkpoint_payload_invalid_read_memory"
                )
              }
            }

            const replayTurnId = `turn:replay:${crypto.randomUUID()}`
            const replayPayload: ProcessTurnPayload = {
              turnId: replayTurnId,
              sessionId: checkpoint.sessionId,
              conversationId: decodedPayload.value.turnContext.conversationId,
              agentId: checkpoint.agentId,
              userId: params.decidedBy,
              channelId: checkpoint.channelId,
              content: decodedPayload.value.content,
              contentBlocks: decodedPayload.value.contentBlocks,
              createdAt: now,
              inputTokens: estimateInputTokens(
                decodedPayload.value.content,
                decodedPayload.value.contentBlocks
              ),
              checkpointId: params.checkpointId
            }

            return {
              ok: true as const,
              kind: "stream" as const,
              stream: withConsumedTransition(
                params.checkpointId,
                params.decidedBy,
                processTurn(replayPayload)
              )
            }
          }

          return {
            ok: true as const,
            kind: "stream" as const,
            stream: replayFailureStream(
              `turn:replay:${crypto.randomUUID()}`,
              `unsupported_checkpoint_action:${checkpoint.action}`
            )
          }
        })

      return {
        initializeChannel,
        buildTurnPayload,
        processTurn,
        getHistory,
        setModelPreference,
        listPendingCheckpoints,
        getCheckpoint,
        decideCheckpoint
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

export type ChannelCoreService = {
  readonly initializeChannel: (params: {
    readonly channelId: ChannelId
    readonly channelType: ChannelType
    readonly agentId: AgentId
    readonly capabilities: ReadonlyArray<ChannelCapability>
  }) => Effect.Effect<void, ChannelTypeMismatch>

  readonly buildTurnPayload: (params: {
    readonly channelId: ChannelId
    readonly content: string
    readonly contentBlocks: ReadonlyArray<ContentBlock>
    readonly userId: string
    readonly modelOverride?: { readonly provider: string; readonly modelId: string } | undefined
    readonly generationConfigOverride?: {
      readonly temperature?: number
      readonly maxOutputTokens?: number
      readonly topP?: number
    } | undefined
  }) => Effect.Effect<ProcessTurnPayload, ChannelNotFound>

  readonly processTurn: (
    turnPayload: ProcessTurnPayload
  ) => Stream.Stream<TurnStreamEvent, TurnProcessingError>

  readonly getHistory: (
    channelId: ChannelId
  ) => Effect.Effect<ReadonlyArray<TurnRecord>, ChannelNotFound>

  readonly setModelPreference: (params: {
    readonly channelId: ChannelId
    readonly modelOverride?: { readonly provider: string; readonly modelId: string } | null | undefined
    readonly generationConfigOverride?: {
      readonly temperature?: number
      readonly maxOutputTokens?: number
      readonly topP?: number
    } | null | undefined
  }) => Effect.Effect<void, ChannelNotFound>

  readonly listPendingCheckpoints: (
    agentId?: AgentId
  ) => Effect.Effect<ReadonlyArray<CheckpointRecord>>

  readonly getCheckpoint: (
    checkpointId: CheckpointId
  ) => Effect.Effect<CheckpointRecord | null>

  readonly decideCheckpoint: (params: {
    readonly checkpointId: CheckpointId
    readonly decision: "Approved" | "Rejected" | "Deferred"
    readonly decidedBy: string
  }) => Effect.Effect<
    | { readonly ok: true; readonly kind: "ack" }
    | { readonly ok: true; readonly kind: "stream"; readonly stream: Stream.Stream<TurnStreamEvent, TurnProcessingError> },
    CheckpointNotFound | CheckpointAlreadyDecided | CheckpointExpired
  >
}

const estimateInputTokens = (
  content: string,
  contentBlocks: ReadonlyArray<ContentBlock>
): number => {
  let estimate = estimateTextTokens(content)
  for (const block of contentBlocks) {
    switch (block.contentBlockType) {
      case "TextBlock": {
        estimate += estimateTextTokens(block.text)
        break
      }
      case "ToolUseBlock": {
        estimate += estimateTextTokens(block.toolName)
        estimate += estimateTextTokens(block.inputJson)
        break
      }
      case "ToolResultBlock": {
        estimate += estimateTextTokens(block.toolName)
        estimate += estimateTextTokens(block.outputJson)
        break
      }
      case "ImageBlock": {
        estimate += 64
        break
      }
    }
  }
  return Math.max(estimate, 1)
}

const estimateTextTokens = (text: string): number => {
  const normalized = text.trim()
  if (normalized.length === 0) {
    return 0
  }
  return Math.ceil(normalized.length / 4)
}

const describeSessionEntityCause = (
  prefix: "session_entity_stream_error" | "session_entity_client_error",
  cause: Cause.Cause<unknown>
): string => {
  const typedError = Cause.findErrorOption(cause)
  if (Option.isSome(typedError)) {
    const taggedFailure = typedError.value as Record<string, unknown>
    if (
      typeof taggedFailure === "object" &&
      taggedFailure !== null &&
      taggedFailure._tag === "TurnModelFailure" &&
      typeof taggedFailure.reason === "string" &&
      taggedFailure.reason.length > 0
    ) {
      return taggedFailure.reason
    }

    const message = extractErrorMessage(typedError.value)
    if (message.length > 0) {
      return `${prefix}: ${message}`
    }
  }

  const squashed = Cause.squash(cause)
  const squashedMessage = extractErrorMessage(squashed)
  if (squashedMessage.length > 0) {
    return `${prefix}: ${squashedMessage}`
  }

  return `${prefix}: ${Cause.pretty(cause)}`
}

const extractErrorMessage = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }
  if (value instanceof Error) {
    return value.message
  }
  if (typeof value === "object" && value !== null) {
    if ("reason" in value && typeof value.reason === "string") {
      return value.reason
    }
    if ("message" in value && typeof value.message === "string") {
      return value.message
    }
  }
  return ""
}
