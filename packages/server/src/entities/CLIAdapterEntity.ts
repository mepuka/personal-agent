import { ChannelNotFound } from "@template/domain/errors"
import { TurnStreamEvent } from "@template/domain/events"
import type { AgentId, ChannelId } from "@template/domain/ids"
import { TurnRecord } from "@template/domain/ports"
import { ChannelType } from "@template/domain/status"
import { Effect, Schema, Stream } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { ChannelCore } from "../ChannelCore.js"
import { TurnProcessingError } from "../turn/TurnProcessingWorkflow.js"

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
  success: Schema.Array(TurnRecord),
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
        channelType: "CLI",
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
