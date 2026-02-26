import { ChannelNotFound } from "@template/domain/errors"
import { TurnStreamEvent } from "@template/domain/events"
import type { AgentId, ChannelId } from "@template/domain/ids"
import { ContentBlock } from "@template/domain/ports"
import { ChannelType, ModelFinishReason } from "@template/domain/status"
import { Effect, Schema, Stream } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { ChannelCore } from "../ChannelCore.js"
import { TurnProcessingError } from "../turn/TurnProcessingWorkflow.js"

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
  modelFinishReason: Schema.Union([ModelFinishReason, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  createdAt: Schema.DateTimeUtcFromString
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

export const CLIAdapterEntity = Entity.make("CLIAdapter", [
  CreateChannelRpc,
  SendMessageRpc,
  GetHistoryRpc
])

export const layer = CLIAdapterEntity.toLayer(Effect.gen(function*() {
  const channelCore = yield* ChannelCore

  return {
    createChannel: (request) =>
      channelCore.initializeChannel({
        channelId: String(request.address.entityId) as ChannelId,
        channelType: request.payload.channelType,
        agentId: request.payload.agentId as AgentId,
        capabilities: ["SendText"]
      }),

    sendMessage: (request) => {
      const channelId = String(request.address.entityId) as ChannelId
      return Stream.unwrap(
        channelCore.buildTurnPayload({
          channelId,
          content: request.payload.content,
          contentBlocks: [{ contentBlockType: "TextBlock" as const, text: request.payload.content }]
        }).pipe(
          Effect.map((turnPayload) => channelCore.processTurn(turnPayload))
        )
      )
    },

    getHistory: (request) =>
      channelCore.getHistory(String(request.address.entityId) as ChannelId)
  }
}))
