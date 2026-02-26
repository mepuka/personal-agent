import { ChannelNotFound } from "@template/domain/errors"
import type { AgentId, ChannelId } from "@template/domain/ids"
import { Effect, Stream } from "effect"
import { Entity } from "effect/unstable/cluster"
import { ChannelCore } from "../ChannelCore.js"
import { ChannelPortTag } from "../PortTags.js"
import { GetHistoryRpc, GetStatusRpc, InitializeRpc, ReceiveMessageRpc } from "./AdapterProtocol.js"

export const WebChatAdapterEntity = Entity.make("WebChatAdapter", [
  InitializeRpc,
  ReceiveMessageRpc,
  GetHistoryRpc,
  GetStatusRpc
])

export const layer = WebChatAdapterEntity.toLayer(Effect.gen(function*() {
  const channelCore = yield* ChannelCore
  const channelPort = yield* ChannelPortTag

  return {
    initialize: (request) =>
      channelCore.initializeChannel({
        channelId: String(request.address.entityId) as ChannelId,
        channelType: "WebChat",
        agentId: request.payload.agentId as AgentId,
        capabilities: ["SendText", "Typing", "StreamingDelivery"]
      }),

    receiveMessage: (request) => {
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
      channelCore.getHistory(String(request.address.entityId) as ChannelId),

    getStatus: (request) =>
      Effect.gen(function*() {
        const channelId = String(request.address.entityId) as ChannelId
        const channel = yield* channelPort.get(channelId)
        if (channel === null) {
          return yield* new ChannelNotFound({ channelId })
        }
        return {
          channelId: channel.channelId,
          channelType: channel.channelType,
          capabilities: [...channel.capabilities],
          activeSessionId: channel.activeSessionId,
          activeConversationId: channel.activeConversationId,
          createdAt: channel.createdAt
        }
      })
  }
}))
