import { ChannelNotFound } from "@template/domain/errors"
import { TurnStreamEvent } from "@template/domain/events"
import type { AgentId, ChannelId, ConversationId, SessionId } from "@template/domain/ids"
import { ContentBlock } from "@template/domain/ports"
import { ChannelType } from "@template/domain/status"
import { Cause, DateTime, Effect, Schema, Stream } from "effect"
import { ClusterSchema, Entity, Sharding } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { ChannelPortTag, SessionTurnPortTag } from "../PortTags.js"
import { TurnProcessingRuntime } from "../turn/TurnProcessingRuntime.js"
import { TurnModelFailure, TurnProcessingError } from "../turn/TurnProcessingWorkflow.js"
import { SessionEntity } from "./SessionEntity.js"

// TODO: Extract to domain package as a proper Schema.Class alongside TurnRecord interface
// to prevent drift between this inline schema and the domain type.
const TurnRecordSchema = Schema.Struct({
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  turnIndex: Schema.Number,
  participantRole: Schema.String,
  participantAgentId: Schema.Union([Schema.String, Schema.Null]),
  message: Schema.Struct({
    messageId: Schema.String,
    role: Schema.String,
    content: Schema.String,
    contentBlocks: Schema.Array(ContentBlock)
  }),
  modelFinishReason: Schema.Union([Schema.String, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  createdAt: Schema.DateTimeUtc
})

const CreateChannelRpc = Rpc.make("createChannel", {
  payload: {
    channelType: ChannelType,
    agentId: Schema.String
  },
  success: Schema.Void,
  primaryKey: ({ agentId }) => `create:${agentId}`
}).annotate(ClusterSchema.Persisted, true)

const SendMessageRpc = Rpc.make("sendMessage", {
  payload: {
    content: Schema.String
  },
  success: TurnStreamEvent,
  error: Schema.Union([ChannelNotFound, TurnProcessingError]),
  stream: true
})

const GetHistoryRpc = Rpc.make("getHistory", {
  payload: {},
  success: Schema.Array(TurnRecordSchema),
  error: ChannelNotFound
})

export const ChannelEntity = Entity.make("Channel", [
  CreateChannelRpc,
  SendMessageRpc,
  GetHistoryRpc
])

const toErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const layer = ChannelEntity.toLayer(Effect.gen(function*() {
  const channelPort = yield* ChannelPortTag
  const sessionTurnPort = yield* SessionTurnPortTag
  const runtime = yield* TurnProcessingRuntime

  return {
    createChannel: (request) =>
      Effect.gen(function*() {
        const channelId = String(request.address.entityId) as ChannelId
        const existing = yield* channelPort.get(channelId)
        if (existing !== null) return

        const agentId = request.payload.agentId as AgentId
        const sessionId = `session:${crypto.randomUUID()}` as SessionId
        const conversationId = `conv:${crypto.randomUUID()}` as ConversationId
        const now = yield* DateTime.now

        yield* channelPort.create({
          channelId,
          channelType: request.payload.channelType,
          agentId,
          activeSessionId: sessionId,
          activeConversationId: conversationId,
          createdAt: now
        })

        yield* sessionTurnPort.startSession({
          sessionId,
          conversationId,
          tokenCapacity: 200_000,
          tokensUsed: 0
        })
      }),

    sendMessage: (request) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const channelId = String(request.address.entityId) as ChannelId
          const channel = yield* channelPort.get(channelId)
          if (channel === null) {
            return Stream.fail(new ChannelNotFound({ channelId })) as Stream.Stream<
              TurnStreamEvent,
              ChannelNotFound | TurnProcessingError
            >
          }

          const turnId = `turn:${crypto.randomUUID()}`
          const now = yield* DateTime.now
          const turnPayload = {
            turnId,
            sessionId: channel.activeSessionId,
            conversationId: channel.activeConversationId,
            agentId: channel.agentId,
            content: request.payload.content,
            contentBlocks: [{ contentBlockType: "TextBlock" as const, text: request.payload.content }],
            createdAt: now,
            inputTokens: 0
          }

          const failWithModelFailure = (reason: string): Stream.Stream<TurnStreamEvent, TurnProcessingError> =>
            Stream.fail(
              new TurnModelFailure({
                turnId,
                reason
              })
            )

          const sharding = yield* Sharding.Sharding
          const canUseSessionClient = typeof (sharding as { makeClient?: unknown }).makeClient === "function"

          // Entity.makeTestClient mock sharding does not expose makeClient.
          if (!canUseSessionClient) {
            return runtime.processTurnStream(turnPayload)
          }

          const stream = yield* SessionEntity.client.pipe(
            Effect.map((makeSessionClient) =>
              makeSessionClient(channel.activeSessionId).processTurn(turnPayload).pipe(
                Stream.catchTags({
                  MailboxFull: () => failWithModelFailure("session_entity_mailbox_full"),
                  AlreadyProcessingMessage: () => failWithModelFailure("session_entity_already_processing"),
                  PersistenceError: (error) =>
                    failWithModelFailure(
                      `session_entity_persistence_error: ${toErrorMessage(error)}`
                    )
                }),
                Stream.catchCause((cause) =>
                  failWithModelFailure(
                    `session_entity_stream_error: ${toErrorMessage(Cause.squash(cause))}`
                  )
                )
              )
            ),
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause)
              return Effect.succeed(
                failWithModelFailure(
                  `session_entity_client_error: ${toErrorMessage(error)}`
                )
              )
            })
          )

          return stream as Stream.Stream<TurnStreamEvent, ChannelNotFound | TurnProcessingError>
        })
      ),

    getHistory: (request) =>
      Effect.gen(function*() {
        const channelId = String(request.address.entityId) as ChannelId
        const channel = yield* channelPort.get(channelId)
        if (channel === null) {
          return yield* new ChannelNotFound({ channelId })
        }
        return yield* sessionTurnPort.listTurns(channel.activeSessionId)
      })
  }
}))
