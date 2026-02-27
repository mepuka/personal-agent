import { ChannelNotFound, ChannelTypeMismatch } from "@template/domain/errors"
import type { TurnStreamEvent } from "@template/domain/events"
import type { AgentId, ChannelId, ConversationId, SessionId } from "@template/domain/ids"
import type { AgentState, ContentBlock, TurnRecord } from "@template/domain/ports"
import type { ChannelCapability, ChannelType } from "@template/domain/status"
import { Cause, DateTime, Effect, Layer, ServiceMap, Stream } from "effect"
import { Sharding } from "effect/unstable/cluster"
import { SessionEntity } from "./entities/SessionEntity.js"
import { AgentStatePortTag, ChannelPortTag, SessionTurnPortTag } from "./PortTags.js"
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
      const runtime = yield* TurnProcessingRuntime
      const sharding = yield* Sharding.Sharding

      const ensureAgentState = (agentId: AgentId) =>
        Effect.gen(function*() {
          const existing = yield* agentStatePort.get(agentId)
          if (existing !== null) {
            return
          }

          yield* agentStatePort.upsert(
            {
              agentId,
              permissionMode: "Standard",
              tokenBudget: 200_000,
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

          yield* sessionTurnPort.startSession({
            sessionId,
            conversationId,
            tokenCapacity: 200_000,
            tokensUsed: 0
          })

          yield* channelPort.create({
            channelId: params.channelId,
            channelType: params.channelType,
            agentId: params.agentId,
            activeSessionId: sessionId,
            activeConversationId: conversationId,
            capabilities: params.capabilities,
            createdAt: now
          })
        })

      const buildTurnPayload = (params: {
        readonly channelId: ChannelId
        readonly content: string
        readonly contentBlocks: ReadonlyArray<ContentBlock>
        readonly userId: string
      }) =>
        Effect.gen(function*() {
          const channel = yield* channelPort.get(params.channelId)
          if (channel === null) {
            return yield* new ChannelNotFound({ channelId: params.channelId })
          }

          const turnId = `turn:${crypto.randomUUID()}`
          const now = yield* DateTime.now

          return {
            turnId,
            sessionId: channel.activeSessionId,
            conversationId: channel.activeConversationId,
            agentId: channel.agentId,
            userId: params.userId,
            content: params.content,
            contentBlocks: params.contentBlocks,
            createdAt: now,
            inputTokens: 0
          } satisfies ProcessTurnPayload
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
                    `session_entity_stream_error: ${Cause.pretty(cause)}`
                  )
                )
              )
            ),
            Effect.catchCause((cause) =>
              Effect.succeed(
                failWithModelFailure(
                  `session_entity_client_error: ${Cause.pretty(cause)}`
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

      return {
        initializeChannel,
        buildTurnPayload,
        processTurn,
        getHistory
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
  }) => Effect.Effect<ProcessTurnPayload, ChannelNotFound>

  readonly processTurn: (
    turnPayload: ProcessTurnPayload
  ) => Stream.Stream<TurnStreamEvent, TurnProcessingError>

  readonly getHistory: (
    channelId: ChannelId
  ) => Effect.Effect<ReadonlyArray<TurnRecord>, ChannelNotFound>
}
