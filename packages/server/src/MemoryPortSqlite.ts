import { DateTime, Effect, Layer, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { AgentId, MemoryItemId } from "../../domain/src/ids.js"
import type { Instant } from "../../domain/src/ports.js"
import type { MemoryScope, MemoryTier } from "../../domain/src/status.js"

interface StoreInput {
  readonly tier: MemoryTier
  readonly scope: MemoryScope
  readonly source: "UserSource" | "SystemSource" | "AgentSource"
  readonly content: string
  readonly metadataJson?: string
  readonly generatedByTurnId?: string
  readonly sessionId?: string
  readonly sensitivity?: "Public" | "Internal" | "Confidential" | "Restricted"
}

interface RetrieveFilters {
  readonly query: string
  readonly tier?: MemoryTier
  readonly scope?: MemoryScope
  readonly limit: number
}

interface ForgetFilters {
  readonly cutoffDate?: Instant
  readonly scope?: MemoryScope
  readonly itemIds?: ReadonlyArray<string>
}

interface ListFilters {
  readonly tier?: MemoryTier
  readonly scope?: MemoryScope
  readonly limit: number
}

export interface MemoryItemRow {
  readonly memoryItemId: string
  readonly agentId: string
  readonly tier: string
  readonly scope: string
  readonly source: string
  readonly content: string
  readonly metadataJson: string | null
  readonly generatedByTurnId: string | null
  readonly sessionId: string | null
  readonly sensitivity: string
  readonly wasGeneratedBy: string | null
  readonly wasAttributedTo: string | null
  readonly governedByRetention: string | null
  readonly lastAccessTime: Instant | null
  readonly createdAt: Instant
  readonly updatedAt: Instant
}

export class MemoryPortSqlite extends ServiceMap.Service<MemoryPortSqlite>()(
  "server/MemoryPortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const encode = (
        agentId: AgentId,
        items: ReadonlyArray<StoreInput>,
        now: Instant
      ): Effect.Effect<ReadonlyArray<MemoryItemId>> =>
        Effect.gen(function*() {
          const nowStr = DateTime.formatIso(now)
          const ids: MemoryItemId[] = []

          for (const item of items) {
            const id = `memory:${crypto.randomUUID()}` as MemoryItemId
            ids.push(id)

            yield* sql`
              INSERT INTO memory_items (
                memory_item_id, agent_id, tier, scope, source,
                content, metadata_json, generated_by_turn_id, session_id,
                sensitivity, was_generated_by, was_attributed_to,
                governed_by_retention, last_access_time, created_at, updated_at
              ) VALUES (
                ${id}, ${agentId}, ${item.tier}, ${item.scope}, ${item.source},
                ${item.content}, ${item.metadataJson ?? null},
                ${item.generatedByTurnId ?? null}, ${item.sessionId ?? null},
                ${item.sensitivity ?? "Internal"}, ${agentId}, ${agentId},
                ${null}, ${null}, ${nowStr}, ${nowStr}
              )
            `.unprepared
          }

          return ids
        })

      const retrieve = (
        agentId: AgentId,
        filters: RetrieveFilters
      ): Effect.Effect<ReadonlyArray<MemoryItemRow>> =>
        Effect.gen(function*() {
          const { query, tier, scope, limit } = filters
          const conditions = [`m.agent_id = '${agentId}'`]
          if (tier) conditions.push(`m.tier = '${tier}'`)
          if (scope) conditions.push(`m.scope = '${scope}'`)
          const whereClause = conditions.join(" AND ")

          if (query && query.trim().length > 0) {
            const rows = yield* sql`
              SELECT m.memory_item_id, m.agent_id, m.tier, m.scope, m.source,
                     m.content, m.metadata_json, m.generated_by_turn_id,
                     m.session_id, m.sensitivity, m.was_generated_by,
                     m.was_attributed_to, m.governed_by_retention,
                     m.last_access_time, m.created_at, m.updated_at
              FROM memory_items m
              JOIN memory_items_fts f ON m.rowid = f.rowid
              WHERE f.memory_items_fts MATCH ${query}
                AND ${sql.unsafe(whereClause)}
              ORDER BY f.rank
              LIMIT ${limit}
            `.unprepared
            return rows.map(parseRow)
          }

          const rows = yield* sql`
            SELECT memory_item_id, agent_id, tier, scope, source,
                   content, metadata_json, generated_by_turn_id,
                   session_id, sensitivity, was_generated_by,
                   was_attributed_to, governed_by_retention,
                   last_access_time, created_at, updated_at
            FROM memory_items m
            WHERE ${sql.unsafe(whereClause)}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `.unprepared
          return rows.map(parseRow)
        })

      const forget = (
        agentId: AgentId,
        filters: ForgetFilters
      ): Effect.Effect<number> =>
        Effect.gen(function*() {
          const conditions = [`agent_id = '${agentId}'`]
          if (filters.cutoffDate) {
            conditions.push(`created_at < '${DateTime.formatIso(filters.cutoffDate)}'`)
          }
          if (filters.scope) {
            conditions.push(`scope = '${filters.scope}'`)
          }
          if (filters.itemIds && filters.itemIds.length > 0) {
            const idList = filters.itemIds.map((id) => `'${id}'`).join(",")
            conditions.push(`memory_item_id IN (${idList})`)
          }
          const whereClause = conditions.join(" AND ")

          const countResult = yield* sql`
            SELECT COUNT(*) as cnt FROM memory_items WHERE ${sql.unsafe(whereClause)}
          `.unprepared
          const count = Number(countResult[0]?.cnt ?? 0)

          if (count > 0) {
            yield* sql`
              DELETE FROM memory_items WHERE ${sql.unsafe(whereClause)}
            `.unprepared
          }

          return count
        })

      const listAll = (
        agentId: AgentId,
        filters: ListFilters
      ): Effect.Effect<ReadonlyArray<MemoryItemRow>> =>
        Effect.gen(function*() {
          const conditions = [`agent_id = '${agentId}'`]
          if (filters.tier) conditions.push(`tier = '${filters.tier}'`)
          if (filters.scope) conditions.push(`scope = '${filters.scope}'`)
          const whereClause = conditions.join(" AND ")

          const rows = yield* sql`
            SELECT memory_item_id, agent_id, tier, scope, source,
                   content, metadata_json, generated_by_turn_id,
                   session_id, sensitivity, was_generated_by,
                   was_attributed_to, governed_by_retention,
                   last_access_time, created_at, updated_at
            FROM memory_items
            WHERE ${sql.unsafe(whereClause)}
            ORDER BY created_at DESC
            LIMIT ${filters.limit}
          `.unprepared
          return rows.map(parseRow)
        })

      return { encode, retrieve, forget, listAll } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const parseRow = (row: any): MemoryItemRow => ({
  memoryItemId: row.memory_item_id as string,
  agentId: row.agent_id as string,
  tier: row.tier as string,
  scope: row.scope as string,
  source: row.source as string,
  content: row.content as string,
  metadataJson: row.metadata_json as string | null,
  generatedByTurnId: row.generated_by_turn_id as string | null,
  sessionId: row.session_id as string | null,
  sensitivity: row.sensitivity as string,
  wasGeneratedBy: row.was_generated_by as string | null,
  wasAttributedTo: row.was_attributed_to as string | null,
  governedByRetention: row.governed_by_retention as string | null,
  lastAccessTime: row.last_access_time
    ? DateTime.fromDateUnsafe(new Date(row.last_access_time as string))
    : null,
  createdAt: DateTime.fromDateUnsafe(new Date(row.created_at as string)),
  updatedAt: DateTime.fromDateUnsafe(new Date(row.updated_at as string))
})
