import type { AgentId, SessionId, TurnId } from "@template/domain/ids"
import { MemoryScope, MemorySource, MemoryTier, SensitivityLevel } from "@template/domain/memory"
import type { MemorySearchQuery } from "@template/domain/ports"
import { MemorySortOrder } from "@template/domain/status"
import { Effect, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { MemoryPortTag } from "../PortTags.js"

const MemoryItemResultSchema = Schema.Struct({
  memoryItemId: Schema.String,
  agentId: Schema.String,
  tier: MemoryTier,
  scope: MemoryScope,
  source: MemorySource,
  content: Schema.String,
  metadataJson: Schema.Union([Schema.String, Schema.Null]),
  generatedByTurnId: Schema.Union([Schema.String, Schema.Null]),
  sessionId: Schema.Union([Schema.String, Schema.Null]),
  sensitivity: SensitivityLevel,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})

const SearchResultSchema = Schema.Struct({
  items: Schema.Array(MemoryItemResultSchema),
  cursor: Schema.Union([Schema.String, Schema.Null]),
  totalCount: Schema.Number
})

const SearchRpc = Rpc.make("search", {
  payload: {
    query: Schema.optional(Schema.String),
    tier: Schema.optional(MemoryTier),
    scope: Schema.optional(MemoryScope),
    source: Schema.optional(MemorySource),
    sort: Schema.optional(MemorySortOrder),
    limit: Schema.optional(Schema.Number),
    cursor: Schema.optional(Schema.String)
  },
  success: SearchResultSchema
})

const StoreItemFields = {
  tier: MemoryTier,
  scope: MemoryScope,
  source: MemorySource,
  content: Schema.String,
  metadataJson: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  generatedByTurnId: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  sessionId: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  sensitivity: Schema.optional(SensitivityLevel)
} as const

const StoreRpc = Rpc.make("store", {
  payload: {
    items: Schema.Array(Schema.Struct(StoreItemFields)),
    now: Schema.DateTimeUtc
  },
  success: Schema.Array(Schema.String),
  primaryKey: () => "store"
}).annotate(ClusterSchema.Persisted, true)

const ForgetRpc = Rpc.make("forget", {
  payload: {
    cutoff: Schema.DateTimeUtc
  },
  success: Schema.Number,
  primaryKey: () => "forget"
}).annotate(ClusterSchema.Persisted, true)

export const MemoryEntity = Entity.make("Memory", [
  SearchRpc,
  StoreRpc,
  ForgetRpc
])

export const layer = MemoryEntity.toLayer(Effect.gen(function*() {
  const port = yield* MemoryPortTag

  return {
    search: ({ address, payload }) => {
      const agentId = String(address.entityId) as AgentId
      const query = Object.fromEntries(
        Object.entries({
          query: payload.query,
          tier: payload.tier,
          scope: payload.scope,
          source: payload.source,
          sort: payload.sort,
          limit: payload.limit ?? 20,
          cursor: payload.cursor
        }).filter(([, v]) => v !== undefined)
      ) as MemorySearchQuery
      return port.search(agentId, query)
    },

    store: ({ address, payload }) => {
      const agentId = String(address.entityId) as AgentId
      return port.encode(
        agentId,
        payload.items.map((item) => {
          const base = {
            tier: item.tier,
            scope: item.scope,
            source: item.source,
            content: item.content,
            metadataJson: item.metadataJson ?? null,
            generatedByTurnId: (item.generatedByTurnId ?? null) as TurnId | null,
            sessionId: (item.sessionId ?? null) as SessionId | null
          }
          return item.sensitivity !== undefined
            ? { ...base, sensitivity: item.sensitivity }
            : base
        }),
        payload.now
      )
    },

    forget: ({ address, payload }) => {
      const agentId = String(address.entityId) as AgentId
      return port.forget(agentId, payload.cutoff)
    }
  }
}))
