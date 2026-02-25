import type { AgentId, MemoryItemId, SessionId, TurnId } from "@template/domain/ids"
import type { MemoryScope, MemorySource, MemoryTier, SensitivityLevel } from "@template/domain/memory"
import type { Instant, MemoryItemRecord, MemoryPort, MemorySearchResult } from "@template/domain/ports"
import { Effect, Layer, Option, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const InstantFromSqlString = Schema.DateTimeUtcFromString
const decodeSqlInstant = Schema.decodeUnknownSync(InstantFromSqlString)
const encodeSqlInstant = Schema.encodeSync(InstantFromSqlString)

// --- Cursor codec via Schema ---

const CursorSchema = Schema.Struct({
  createdAt: Schema.String,
  rowid: Schema.Int
})

const CursorFromJsonString = Schema.fromJsonString(CursorSchema)

export class MemoryPortSqlite extends ServiceMap.Service<MemoryPortSqlite>()(
  "server/MemoryPortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const search: MemoryPort["search"] = (agentId, query) =>
        Effect.gen(function*() {
          const conditions: Array<string> = [`agent_id = '${escapeSql(agentId)}'`]

          if (query.tier) conditions.push(`tier = '${escapeSql(query.tier)}'`)
          if (query.scope) conditions.push(`scope = '${escapeSql(query.scope)}'`)
          if (query.source) conditions.push(`source = '${escapeSql(query.source)}'`)

          if (query.query && query.query.trim().length > 0) {
            const escaped = query.query.replace(/%/g, "\\%").replace(/_/g, "\\_")
            conditions.push(`content LIKE '%${escapeSql(escaped)}%' ESCAPE '\\'`)
          }

          const cursor = query.cursor ? decodeCursor(query.cursor) : null
          if (cursor !== null) {
            const op = query.sort === "CreatedAsc" ? ">" : "<"
            conditions.push(
              `(created_at ${op} '${escapeSql(cursor.createdAt)}' OR (created_at = '${escapeSql(cursor.createdAt)}' AND rowid ${op} ${cursor.rowid}))`
            )
          }

          const whereClause = conditions.join(" AND ")
          const orderBy = query.sort === "CreatedAsc"
            ? "created_at ASC, rowid ASC"
            : "created_at DESC, rowid DESC"
          const limit = query.limit ?? 20

          // Count total matching (without cursor/limit)
          const countConditions = conditions.filter((c) => !c.startsWith("(created_at"))
          const countWhere = countConditions.join(" AND ")
          const countResult = yield* sql`
            SELECT COUNT(*) as cnt FROM memory_items
            WHERE ${sql.unsafe(countWhere)}
          `.unprepared
          const totalCount = Number(countResult[0]?.cnt ?? 0)

          // Fetch page
          const rows = yield* sql`
            SELECT rowid, memory_item_id, agent_id, tier, scope, source,
                   content, metadata_json, generated_by_turn_id,
                   session_id, sensitivity, created_at, updated_at
            FROM memory_items
            WHERE ${sql.unsafe(whereClause)}
            ORDER BY ${sql.unsafe(orderBy)}
            LIMIT ${limit}
          `.unprepared

          const items = rows.map(parseRow)
          const nextCursor = rows.length === limit
            ? encodeCursor(rows[rows.length - 1].created_at as string, Number(rows[rows.length - 1].rowid))
            : null

          return { items, cursor: nextCursor, totalCount } as MemorySearchResult
        }).pipe(Effect.orDie)

      const encode: MemoryPort["encode"] = (agentId, items, now) =>
        Effect.gen(function*() {
          const nowStr = encodeSqlInstant(now)
          const ids: Array<MemoryItemId> = []

          for (const item of items) {
            const id = (`mem:${agentId}:${crypto.randomUUID()}`) as MemoryItemId
            ids.push(id)

            yield* sql`
              INSERT INTO memory_items (
                memory_item_id, agent_id, tier, scope, source,
                content, metadata_json, generated_by_turn_id,
                session_id, sensitivity, created_at, updated_at
              ) VALUES (
                ${id}, ${agentId}, ${item.tier}, ${item.scope}, ${item.source},
                ${item.content}, ${item.metadataJson ?? null},
                ${item.generatedByTurnId ?? null}, ${item.sessionId ?? null},
                ${item.sensitivity ?? "Internal"}, ${nowStr}, ${nowStr}
              )
            `.unprepared
          }

          return ids
        }).pipe(Effect.orDie)

      const forget: MemoryPort["forget"] = (agentId, cutoff) =>
        Effect.gen(function*() {
          const cutoffStr = encodeSqlInstant(cutoff)

          const countResult = yield* sql`
            SELECT COUNT(*) as cnt FROM memory_items
            WHERE agent_id = ${agentId}
              AND created_at < ${cutoffStr}
          `.unprepared
          const count = Number(countResult[0]?.cnt ?? 0)

          yield* sql`
            DELETE FROM memory_items
            WHERE agent_id = ${agentId}
              AND created_at < ${cutoffStr}
          `.unprepared

          return count
        }).pipe(Effect.orDie)

      return {
        search,
        encode,
        forget
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const parseRow = (row: any): MemoryItemRecord => ({
  memoryItemId: row.memory_item_id as MemoryItemId,
  agentId: row.agent_id as AgentId,
  tier: row.tier as MemoryTier,
  scope: row.scope as MemoryScope,
  source: row.source as MemorySource,
  content: row.content as string,
  metadataJson: row.metadata_json as string | null,
  generatedByTurnId: row.generated_by_turn_id as TurnId | null,
  sessionId: row.session_id as SessionId | null,
  sensitivity: row.sensitivity as SensitivityLevel,
  createdAt: decodeSqlInstant(row.created_at),
  updatedAt: decodeSqlInstant(row.updated_at)
})

const encodeCursor = (createdAt: string, rowid: number): string =>
  Buffer.from(Schema.encodeSync(CursorFromJsonString)({ createdAt, rowid })).toString("base64url")

const decodeCursor = (cursor: string): { readonly createdAt: string; readonly rowid: number } | null =>
  Option.getOrNull(
    Schema.decodeOption(CursorFromJsonString)(
      Buffer.from(cursor, "base64url").toString("utf8")
    )
  )

const escapeSql = (value: string): string =>
  value.replace(/'/g, "''")
