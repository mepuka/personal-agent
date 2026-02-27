import { ChannelNotFound } from "@template/domain/errors"
import type { AgentId, ChannelId } from "@template/domain/ids"
import { Effect, Stream } from "effect"
import { Entity } from "effect/unstable/cluster"
import { ChannelCore } from "../ChannelCore.js"
import { ChannelPortTag } from "../PortTags.js"
import { GetHistoryRpc, GetStatusRpc, InitializeRpc, ReceiveMessageRpc, SetModelPreferenceRpc } from "./AdapterProtocol.js"

export const WebChatAdapterEntity = Entity.make("WebChatAdapter", [
  InitializeRpc,
  ReceiveMessageRpc,
  GetHistoryRpc,
  GetStatusRpc,
  SetModelPreferenceRpc
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
      }).pipe(
        Effect.withSpan("WebChatAdapterEntity.initialize"),
        Effect.annotateLogs({ module: "WebChatAdapterEntity", entityId: request.address.entityId })
      ),

    receiveMessage: (request) => {
      const channelId = String(request.address.entityId) as ChannelId
      return Stream.unwrap(
        channelCore.buildTurnPayload({
          channelId,
          content: request.payload.content,
          contentBlocks: [{ contentBlockType: "TextBlock" as const, text: request.payload.content }],
          userId: request.payload.userId,
          modelOverride: request.payload.modelOverride,
          generationConfigOverride: request.payload.generationConfigOverride
        }).pipe(
          Effect.map((turnPayload) => channelCore.processTurn(turnPayload))
        )
      ).pipe(
        Stream.withSpan("WebChatAdapterEntity.receiveMessage")
      )
    },

    getHistory: (request) =>
      channelCore.getHistory(String(request.address.entityId) as ChannelId).pipe(
        Effect.withSpan("WebChatAdapterEntity.getHistory"),
        Effect.annotateLogs({ module: "WebChatAdapterEntity", entityId: request.address.entityId })
      ),

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
          modelOverride: channel.modelOverride,
          generationConfigOverride: channel.generationConfigOverride,
          createdAt: channel.createdAt
        }
      }).pipe(
        Effect.withSpan("WebChatAdapterEntity.getStatus"),
        Effect.annotateLogs({ module: "WebChatAdapterEntity", entityId: request.address.entityId })
      ),

    setModelPreference: (request) =>
      channelCore.setModelPreference({
        channelId: String(request.address.entityId) as ChannelId,
        ...("modelOverride" in request.payload ? { modelOverride: request.payload.modelOverride } : {}),
        ...("generationConfigOverride" in request.payload ? { generationConfigOverride: request.payload.generationConfigOverride } : {})
      }).pipe(
        Effect.withSpan("WebChatAdapterEntity.setModelPreference"),
        Effect.annotateLogs({ module: "WebChatAdapterEntity", entityId: request.address.entityId })
      )
  }
}))
