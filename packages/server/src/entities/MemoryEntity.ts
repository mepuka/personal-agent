import type { AgentId } from "@template/domain/ids"
import { DateTime, Effect, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { MemoryPortSqlite } from "../MemoryPortSqlite.js"

const MemoryItemInputFields = {
  tier: Schema.Literals(["WorkingMemory", "EpisodicMemory", "SemanticMemory", "ProceduralMemory"]),
  scope: Schema.Literals(["SessionScope", "GlobalScope"]),
  source: Schema.Literals(["UserSource", "SystemSource", "AgentSource"]),
  content: Schema.String,
  metadataJson: Schema.optional(Schema.String),
  generatedByTurnId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  sensitivity: Schema.optional(Schema.Literals(["Public", "Internal", "Confidential", "Restricted"]))
} as const

const MemoryItemResultSchema = Schema.Struct({
  memoryItemId: Schema.String,
  agentId: Schema.String,
  tier: Schema.String,
  scope: Schema.String,
  source: Schema.String,
  content: Schema.String,
  metadataJson: Schema.Union([Schema.String, Schema.Null]),
  generatedByTurnId: Schema.Union([Schema.String, Schema.Null]),
  sessionId: Schema.Union([Schema.String, Schema.Null]),
  sensitivity: Schema.String,
  wasGeneratedBy: Schema.Union([Schema.String, Schema.Null]),
  wasAttributedTo: Schema.Union([Schema.String, Schema.Null]),
  governedByRetention: Schema.Union([Schema.String, Schema.Null]),
  lastAccessTime: Schema.Union([Schema.DateTimeUtc, Schema.Null]),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})

const StoreRpc = Rpc.make("store", {
  payload: { items: Schema.Array(Schema.Struct(MemoryItemInputFields)) },
  success: Schema.Struct({ storedIds: Schema.Array(Schema.String) }),
  primaryKey: () => `store:${Date.now()}`
}).annotate(ClusterSchema.Persisted, true)

const RetrieveRpc = Rpc.make("retrieve", {
  payload: {
    query: Schema.String,
    tier: Schema.optional(Schema.Literals(["WorkingMemory", "EpisodicMemory", "SemanticMemory", "ProceduralMemory"])),
    scope: Schema.optional(Schema.Literals(["SessionScope", "GlobalScope"])),
    limit: Schema.optional(Schema.Number)
  },
  success: Schema.Array(MemoryItemResultSchema)
})

const ForgetRpc = Rpc.make("forget", {
  payload: {
    cutoffDate: Schema.optional(Schema.DateTimeUtc),
    scope: Schema.optional(Schema.Literals(["SessionScope", "GlobalScope"])),
    itemIds: Schema.optional(Schema.Array(Schema.String))
  },
  success: Schema.Struct({ deletedCount: Schema.Number }),
  primaryKey: () => `forget:${Date.now()}`
}).annotate(ClusterSchema.Persisted, true)

const ListItemsRpc = Rpc.make("listItems", {
  payload: {
    tier: Schema.optional(Schema.Literals(["WorkingMemory", "EpisodicMemory", "SemanticMemory", "ProceduralMemory"])),
    scope: Schema.optional(Schema.Literals(["SessionScope", "GlobalScope"])),
    limit: Schema.optional(Schema.Number)
  },
  success: Schema.Array(MemoryItemResultSchema)
})

export const MemoryEntity = Entity.make("Memory", [
  StoreRpc,
  RetrieveRpc,
  ForgetRpc,
  ListItemsRpc
])

export const layer = MemoryEntity.toLayer(Effect.gen(function*() {
  const port = yield* MemoryPortSqlite

  return {
    store: ({ address, payload }) => {
      const agentId = String(address.entityId) as AgentId
      return Effect.gen(function*() {
        const now = yield* DateTime.now
        const storedIds = yield* port.encode(agentId, payload.items, now)
        return { storedIds }
      })
    },

    retrieve: ({ address, payload }) => {
      const agentId = String(address.entityId) as AgentId
      return port.retrieve(agentId, {
        query: payload.query,
        tier: payload.tier,
        scope: payload.scope,
        limit: payload.limit ?? 10
      })
    },

    forget: ({ address, payload }) => {
      const agentId = String(address.entityId) as AgentId
      return port.forget(agentId, {
        cutoffDate: payload.cutoffDate,
        scope: payload.scope,
        itemIds: payload.itemIds
      }).pipe(Effect.map((deletedCount) => ({ deletedCount })))
    },

    listItems: ({ address, payload }) => {
      const agentId = String(address.entityId) as AgentId
      return port.listAll(agentId, {
        tier: payload.tier,
        scope: payload.scope,
        limit: payload.limit ?? 50
      })
    }
  }
}))
