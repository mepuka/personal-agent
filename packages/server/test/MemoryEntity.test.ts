import { describe, expect, it } from "@effect/vitest"
import type { AgentId } from "@template/domain/ids"
import type { Instant, MemoryPort } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { Entity, ShardingConfig } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import { MemoryEntity, layer as MemoryEntityLayer } from "../src/entities/MemoryEntity.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { MemoryPortTag } from "../src/PortTags.js"

const AGENT_ID = "agent:mem-entity" as AgentId

describe("MemoryEntity", () => {
  it.effect("store + search round-trip", () => {
    const dbPath = testDatabasePath("mem-entity-roundtrip")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)
      const now = instant("2026-02-25T12:00:00.000Z")

      const ids = yield* client.store({
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User's name is Alex" },
          { tier: "EpisodicMemory", scope: "SessionScope", source: "AgentSource", content: "Discussed TypeScript" }
        ],
        now
      })
      expect(ids).toHaveLength(2)

      const result = yield* client.search({ query: "Alex", limit: 10 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].content).toBe("User's name is Alex")
      expect(result.totalCount).toBe(1)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search with no query returns all items (browse mode)", () => {
    const dbPath = testDatabasePath("mem-entity-browse")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* client.store({
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Fact A" },
          { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "Fact B" },
          { tier: "EpisodicMemory", scope: "SessionScope", source: "SystemSource", content: "Fact C" }
        ],
        now
      })

      const result = yield* client.search({ limit: 10 })
      expect(result.items).toHaveLength(3)
      expect(result.totalCount).toBe(3)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search with pagination via cursor", () => {
    const dbPath = testDatabasePath("mem-entity-pagination")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)

      for (let i = 0; i < 5; i++) {
        yield* client.store({
          items: [
            { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: `Item ${i}` }
          ],
          now: instant(`2026-02-25T${String(10 + i).padStart(2, "0")}:00:00.000Z`)
        })
      }

      const page1 = yield* client.search({ sort: "CreatedAsc", limit: 2 })
      expect(page1.items).toHaveLength(2)
      expect(page1.cursor).not.toBeNull()
      expect(page1.items[0].content).toBe("Item 0")

      const page2 = yield* client.search({ sort: "CreatedAsc", limit: 2, cursor: page1.cursor! })
      expect(page2.items).toHaveLength(2)
      expect(page2.items[0].content).toBe("Item 2")

      const page3 = yield* client.search({ sort: "CreatedAsc", limit: 2, cursor: page2.cursor! })
      expect(page3.items).toHaveLength(1)
      expect(page3.cursor).toBeNull()
      expect(page3.items[0].content).toBe("Item 4")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("forget deletes items before cutoff", () => {
    const dbPath = testDatabasePath("mem-entity-forget")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)

      yield* client.store({
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Old fact" }
        ],
        now: instant("2026-02-24T10:00:00.000Z")
      })

      yield* client.store({
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "New fact" }
        ],
        now: instant("2026-02-25T14:00:00.000Z")
      })

      const deleted = yield* client.forget({ cutoff: instant("2026-02-25T12:00:00.000Z") })
      expect(deleted).toBe(1)

      const remaining = yield* client.search({ limit: 10 })
      expect(remaining.items).toHaveLength(1)
      expect(remaining.items[0].content).toBe("New fact")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search filters by tier and source", () => {
    const dbPath = testDatabasePath("mem-entity-filters")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* client.store({
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User fact" },
          { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "Agent fact" },
          { tier: "EpisodicMemory", scope: "SessionScope", source: "AgentSource", content: "Episode" }
        ],
        now
      })

      const byTier = yield* client.search({ tier: "EpisodicMemory", limit: 10 })
      expect(byTier.items).toHaveLength(1)
      expect(byTier.items[0].content).toBe("Episode")

      const bySource = yield* client.search({ source: "AgentSource", limit: 10 })
      expect(bySource.items).toHaveLength(2)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

const makeTestLayer = (dbPath: string) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(Layer.provide(sqliteLayer), Layer.orDie)
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

  const memorySqliteLayer = MemoryPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const memoryTagLayer = Layer.effect(
    MemoryPortTag,
    Effect.gen(function*() {
      return (yield* MemoryPortSqlite) as MemoryPort
    })
  ).pipe(Layer.provide(memorySqliteLayer))

  return Layer.mergeAll(
    memorySqliteLayer,
    memoryTagLayer,
    ShardingConfig.layer()
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
