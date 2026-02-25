import { describe, expect, it } from "@effect/vitest"
import type { AgentId } from "@template/domain/ids"
import type { Instant } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { Entity, ShardingConfig } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import { MemoryEntity, layer as MemoryEntityLayer } from "../src/entities/MemoryEntity.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"

describe("MemoryEntity", () => {
  it.effect("store + retrieve round-trip via entity RPCs", () => {
    const dbPath = testDatabasePath("memory-entity-roundtrip")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient("agent:entity-test")

      const storeResult = yield* client.store({
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "User's name is Alex" }
        ]
      })
      expect(storeResult.storedIds).toHaveLength(1)

      const results = yield* client.retrieve({ query: "Alex", limit: 10 })
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].content).toContain("Alex")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("forget removes items via entity RPC", () => {
    const dbPath = testDatabasePath("memory-entity-forget")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const port = yield* MemoryPortSqlite
      const agentId = "agent:entity-forget" as AgentId
      const client = yield* makeClient(agentId)

      yield* port.encode(agentId, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "old memory" }
      ], instant("2026-01-01T00:00:00.000Z"))

      const result = yield* client.forget({ cutoffDate: instant("2026-02-25T12:00:00.000Z") })
      expect(result.deletedCount).toBe(1)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("listItems returns all items for agent", () => {
    const dbPath = testDatabasePath("memory-entity-list")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient("agent:entity-list")

      yield* client.store({
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "fact" },
          { tier: "EpisodicMemory", scope: "SessionScope", source: "SystemSource", content: "event" }
        ]
      })

      const all = yield* client.listItems({ limit: 10 })
      expect(all).toHaveLength(2)
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

  const memoryPortSqliteLayer = MemoryPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )

  return Layer.mergeAll(
    memoryPortSqliteLayer,
    ShardingConfig.layer()
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))
const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)
const cleanupDatabase = (path: string) =>
  Effect.sync(() => { rmSync(path, { force: true }) })
