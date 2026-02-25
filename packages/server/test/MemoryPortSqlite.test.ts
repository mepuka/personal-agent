import { describe, expect, it } from "@effect/vitest"
import type { AgentId } from "@template/domain/ids"
import type { Instant } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"

describe("MemoryPortSqlite", () => {
  it.effect("encode + retrieve round-trip", () => {
    const dbPath = testDatabasePath("memory-roundtrip")
    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")
      const agentId = "agent:mem-test" as AgentId

      const ids = yield* port.encode(agentId, [
        {
          tier: "SemanticMemory",
          scope: "GlobalScope",
          source: "AgentSource",
          content: "User's name is Alex"
        },
        {
          tier: "SemanticMemory",
          scope: "GlobalScope",
          source: "AgentSource",
          content: "User prefers TypeScript"
        }
      ], now)

      expect(ids).toHaveLength(2)

      const results = yield* port.retrieve(agentId, { query: "Alex", limit: 10 })
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].content).toContain("Alex")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("retrieve filters by tier", () => {
    const dbPath = testDatabasePath("memory-tier-filter")
    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")
      const agentId = "agent:tier-test" as AgentId

      yield* port.encode(agentId, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "semantic fact" },
        { tier: "EpisodicMemory", scope: "SessionScope", source: "SystemSource", content: "episodic event" }
      ], now)

      const semanticOnly = yield* port.retrieve(agentId, { query: "", tier: "SemanticMemory", limit: 10 })
      expect(semanticOnly).toHaveLength(1)
      expect(semanticOnly[0].tier).toBe("SemanticMemory")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("forget removes items by cutoff date", () => {
    const dbPath = testDatabasePath("memory-forget")
    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const agentId = "agent:forget-test" as AgentId
      const old = instant("2026-01-01T00:00:00.000Z")
      const recent = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(agentId, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "old fact" }
      ], old)
      yield* port.encode(agentId, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "new fact" }
      ], recent)

      const deleted = yield* port.forget(agentId, { cutoffDate: instant("2026-02-01T00:00:00.000Z") })
      expect(deleted).toBe(1)

      const remaining = yield* port.retrieve(agentId, { query: "", limit: 10 })
      expect(remaining).toHaveLength(1)
      expect(remaining[0].content).toBe("new fact")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("FTS5 ranks relevant results higher", () => {
    const dbPath = testDatabasePath("memory-fts-rank")
    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")
      const agentId = "agent:fts-test" as AgentId

      yield* port.encode(agentId, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "User likes pizza and pasta" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "The weather is sunny today" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "User's favorite pizza is margherita" }
      ], now)

      const results = yield* port.retrieve(agentId, { query: "pizza", limit: 10 })
      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(results.every((r) => r.content.includes("pizza"))).toBe(true)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("listAll returns items for agent", () => {
    const dbPath = testDatabasePath("memory-list")
    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")
      const agentId = "agent:list-test" as AgentId

      yield* port.encode(agentId, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "fact one" },
        { tier: "EpisodicMemory", scope: "SessionScope", source: "SystemSource", content: "event one" }
      ], now)

      const all = yield* port.listAll(agentId, { limit: 10 })
      expect(all).toHaveLength(2)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("provenance fields round-trip as null when not provided", () => {
    const dbPath = testDatabasePath("memory-provenance")
    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")
      const agentId = "agent:prov-test" as AgentId

      yield* port.encode(agentId, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "a fact" }
      ], now)

      const results = yield* port.retrieve(agentId, { query: "fact", limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0].wasGeneratedBy).toBe(agentId)
      expect(results[0].wasAttributedTo).toBe(agentId)
      expect(results[0].governedByRetention).toBeNull()
      expect(results[0].lastAccessTime).toBeNull()
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
  return MemoryPortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer))
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => { rmSync(path, { force: true }) })
