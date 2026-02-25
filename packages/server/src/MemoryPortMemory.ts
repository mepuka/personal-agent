import type { AgentId, MemoryItemId, SessionId, TurnId } from "@template/domain/ids"
import type { MemoryScope, MemorySource, MemoryTier, SensitivityLevel } from "@template/domain/memory"
import type { MemoryItemRecord, MemoryPort, MemorySearchQuery, MemorySearchResult } from "@template/domain/ports"
import type { Instant } from "@template/domain/ports"
import { DateTime, Effect, HashMap, Layer, Option, Ref, Schema, ServiceMap } from "effect"

// --- Offset cursor codec via Schema ---

export class MemoryPortMemory extends ServiceMap.Service<MemoryPortMemory>()("server/MemoryPortMemory", {
  make: Effect.gen(function*() {
    const itemsByAgent = yield* Ref.make(HashMap.empty<AgentId, Array<MemoryItemRecord>>())

    const search: MemoryPort["search"] = (agentId, query) =>
      Ref.get(itemsByAgent).pipe(
        Effect.map((map) => {
          let items = Option.getOrElse(HashMap.get(map, agentId), () => [] as Array<MemoryItemRecord>)

          if (query.query && query.query.trim().length > 0) {
            const needle = query.query.toLowerCase()
            items = items.filter((item) => item.content.toLowerCase().includes(needle))
          }
          if (query.tier) {
            items = items.filter((item) => item.tier === query.tier)
          }
          if (query.scope) {
            items = items.filter((item) => item.scope === query.scope)
          }
          if (query.source) {
            items = items.filter((item) => item.source === query.source)
          }

          if (query.sort === "CreatedAsc") {
            items = [...items].sort((a, b) =>
              DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt)
            )
          } else {
            items = [...items].sort((a, b) =>
              DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt)
            )
          }

          const totalCount = items.length
          const limit = query.limit ?? 20
          const offset = query.cursor ? decodeMemoryCursor(query.cursor) : 0
          const paged = items.slice(offset, offset + limit)
          const nextOffset = offset + paged.length
          const nextCursor = nextOffset < totalCount ? encodeMemoryCursor(nextOffset) : null

          return { items: paged, cursor: nextCursor, totalCount } as MemorySearchResult
        })
      )

    const encode: MemoryPort["encode"] = (agentId, items, now) =>
      Ref.modify(itemsByAgent, (map) => {
        const current = Option.getOrElse(HashMap.get(map, agentId), () => [] as Array<MemoryItemRecord>)
        const newRecords: Array<MemoryItemRecord> = items.map((item) => ({
          memoryItemId: (`mem:${crypto.randomUUID()}`) as MemoryItemId,
          agentId,
          tier: item.tier as MemoryTier,
          scope: item.scope as MemoryScope,
          source: item.source as MemorySource,
          content: item.content,
          metadataJson: item.metadataJson ?? null,
          generatedByTurnId: (item.generatedByTurnId ?? null) as TurnId | null,
          sessionId: (item.sessionId ?? null) as SessionId | null,
          sensitivity: (item.sensitivity ?? "Internal") as SensitivityLevel,
          createdAt: now,
          updatedAt: now
        }))
        const ids = newRecords.map((r) => r.memoryItemId)
        return [ids, HashMap.set(map, agentId, [...current, ...newRecords])] as const
      })

    const forget: MemoryPort["forget"] = (agentId, cutoff) =>
      Ref.modify(itemsByAgent, (map) => {
        const current = Option.getOrElse(HashMap.get(map, agentId), () => [] as Array<MemoryItemRecord>)
        const cutoffEpochMillis = DateTime.toEpochMillis(cutoff)
        const retained = current.filter((item) => DateTime.toEpochMillis(item.createdAt) >= cutoffEpochMillis)
        const deletedCount = current.length - retained.length
        return [deletedCount, HashMap.set(map, agentId, retained)] as const
      })

    return {
      search,
      encode,
      forget
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}

const encodeMemoryCursor = (offset: number): string =>
  Buffer.from(String(offset)).toString("base64url")

const decodeMemoryCursor = (cursor: string): number => {
  const str = Buffer.from(cursor, "base64url").toString("utf8")
  const opt = Schema.decodeOption(Schema.FiniteFromString)(str)
  if (Option.isNone(opt)) return 0
  const n = opt.value
  return Number.isInteger(n) && n >= 0 ? n : 0
}
