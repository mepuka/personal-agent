import type { AgentId, MemoryItemId, SessionId, TurnId } from "@template/domain/ids"
import { Effect, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { MemoryPortTag } from "../PortTags.js"

const MemoryQueryFields = {
  agentId: Schema.String,
  sessionId: Schema.String,
  text: Schema.String,
  limit: Schema.Number
} as const

const MemoryItemSchema = Schema.Struct({
  memoryItemId: Schema.String,
  agentId: Schema.String,
  tier: Schema.Literals(["WorkingMemory", "EpisodicMemory", "SemanticMemory", "ProceduralMemory"]),
  content: Schema.String,
  generatedByTurnId: Schema.Union([Schema.String, Schema.Null]),
  createdAt: Schema.DateTimeUtc
})

const RetrieveRpc = Rpc.make("retrieve", {
  payload: MemoryQueryFields,
  success: Schema.Array(MemoryItemSchema),
  primaryKey: ({ agentId }) => `retrieve:${agentId}`
}).annotate(ClusterSchema.Persisted, true)

const EncodeRpc = Rpc.make("encode", {
  payload: {
    items: Schema.Array(MemoryItemSchema),
    now: Schema.DateTimeUtc
  },
  success: Schema.Array(Schema.String),
  primaryKey: ({ items }) => `encode:${items.length > 0 ? items[0]?.agentId : "empty"}`
}).annotate(ClusterSchema.Persisted, true)

const ForgetRpc = Rpc.make("forget", {
  payload: {
    agentId: Schema.String,
    cutoff: Schema.DateTimeUtc
  },
  success: Schema.Number,
  primaryKey: ({ agentId }) => `forget:${agentId}`
}).annotate(ClusterSchema.Persisted, true)

export const MemoryEntity = Entity.make("Memory", [
  RetrieveRpc,
  EncodeRpc,
  ForgetRpc
])

export const layer = MemoryEntity.toLayer(Effect.gen(function*() {
  const port = yield* MemoryPortTag

  return {
    retrieve: ({ payload }) =>
      port.retrieve({
        agentId: payload.agentId as AgentId,
        sessionId: payload.sessionId as SessionId,
        text: payload.text,
        limit: payload.limit
      }),

    encode: ({ payload }) =>
      port.encode(
        payload.items.map((item) => ({
          ...item,
          memoryItemId: item.memoryItemId as MemoryItemId,
          agentId: item.agentId as AgentId,
          generatedByTurnId: item.generatedByTurnId as TurnId | null
        })),
        payload.now
      ),

    forget: ({ payload }) =>
      port.forget(
        payload.agentId as AgentId,
        payload.cutoff
      )
  }
}))
