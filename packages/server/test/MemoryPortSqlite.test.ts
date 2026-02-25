import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentId } from "../../domain/src/ids.js"
import type { Instant } from "../../domain/src/ports.js"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"

const AGENT_ID = "agent:mem-test" as AgentId

describe("MemoryPortSqlite", () => {
  it.effect("encodes and searches items by substring", () => {
    const dbPath = testDatabasePath("mem-search")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User's name is Alex" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "User likes pizza and pasta" },
        { tier: "EpisodicMemory", scope: "SessionScope", source: "AgentSource", content: "Discussed TypeScript patterns" }
      ], now)

      const result = yield* port.search(AGENT_ID, { query: "Alex", limit: 10 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].content).toBe("User's name is Alex")
      expect(result.totalCount).toBe(1)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("LIKE search matches substring regardless of position", () => {
    const dbPath = testDatabasePath("mem-substring")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User likes pizza and pasta" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Pizza is a food" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User hates broccoli" }
      ], now)

      const result = yield* port.search(AGENT_ID, { query: "pizza", limit: 10 })
      expect(result.items).toHaveLength(2)
      expect(result.totalCount).toBe(2)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("LIKE search is case-insensitive", () => {
    const dbPath = testDatabasePath("mem-case")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User likes PIZZA" }
      ], now)

      const result = yield* port.search(AGENT_ID, { query: "pizza", limit: 10 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].content).toBe("User likes PIZZA")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search returns cursor for pagination", () => {
    const dbPath = testDatabasePath("mem-cursor")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite

      // Insert 5 items at different times so ordering is deterministic
      for (let i = 0; i < 5; i++) {
        const time = instant(`2026-02-25T12:0${i}:00.000Z`)
        yield* port.encode(AGENT_ID, [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: `Item ${i}` }
        ], time)
      }

      // Page 1: limit 2, newest first (default sort is CreatedDesc)
      const page1 = yield* port.search(AGENT_ID, { limit: 2, sort: "CreatedAsc" })
      expect(page1.items).toHaveLength(2)
      expect(page1.cursor).not.toBeNull()
      expect(page1.totalCount).toBe(5)
      expect(page1.items[0].content).toBe("Item 0")
      expect(page1.items[1].content).toBe("Item 1")

      // Page 2: use cursor
      const page2 = yield* port.search(AGENT_ID, { limit: 2, sort: "CreatedAsc", cursor: page1.cursor! })
      expect(page2.items).toHaveLength(2)
      expect(page2.cursor).not.toBeNull()
      expect(page2.items[0].content).toBe("Item 2")
      expect(page2.items[1].content).toBe("Item 3")

      // Page 3: last item
      const page3 = yield* port.search(AGENT_ID, { limit: 2, sort: "CreatedAsc", cursor: page2.cursor! })
      expect(page3.items).toHaveLength(1)
      expect(page3.cursor).toBeNull()
      expect(page3.items[0].content).toBe("Item 4")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search returns totalCount independent of limit", () => {
    const dbPath = testDatabasePath("mem-totalcount")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Item A" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Item B" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Item C" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Item D" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Item E" }
      ], now)

      const result = yield* port.search(AGENT_ID, { limit: 2 })
      expect(result.items).toHaveLength(2)
      expect(result.totalCount).toBe(5)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search filters by source", () => {
    const dbPath = testDatabasePath("mem-source")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User said this" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "Agent inferred this" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "SystemSource", content: "System knows this" }
      ], now)

      const result = yield* port.search(AGENT_ID, { source: "AgentSource", limit: 10 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].content).toBe("Agent inferred this")
      expect(result.items[0].source).toBe("AgentSource")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search filters by tier", () => {
    const dbPath = testDatabasePath("mem-tier")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Semantic fact" },
        { tier: "EpisodicMemory", scope: "SessionScope", source: "AgentSource", content: "Episode recall" }
      ], now)

      const result = yield* port.search(AGENT_ID, { tier: "EpisodicMemory", limit: 10 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].content).toBe("Episode recall")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search sorts by CreatedAsc", () => {
    const dbPath = testDatabasePath("mem-sort")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Oldest" }
      ], instant("2026-02-25T10:00:00.000Z"))

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Newest" }
      ], instant("2026-02-25T14:00:00.000Z"))

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Middle" }
      ], instant("2026-02-25T12:00:00.000Z"))

      const asc = yield* port.search(AGENT_ID, { sort: "CreatedAsc", limit: 10 })
      expect(asc.items.map((i) => i.content)).toEqual(["Oldest", "Middle", "Newest"])

      const desc = yield* port.search(AGENT_ID, { sort: "CreatedDesc", limit: 10 })
      expect(desc.items.map((i) => i.content)).toEqual(["Newest", "Middle", "Oldest"])
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search with empty query returns all items (browse mode)", () => {
    const dbPath = testDatabasePath("mem-browse")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Fact 1" },
        { tier: "EpisodicMemory", scope: "SessionScope", source: "AgentSource", content: "Fact 2" }
      ], now)

      const result = yield* port.search(AGENT_ID, { limit: 10 })
      expect(result.items).toHaveLength(2)
      expect(result.totalCount).toBe(2)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("forget deletes items before cutoff", () => {
    const dbPath = testDatabasePath("mem-forget")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Old fact" }
      ], instant("2026-02-24T10:00:00.000Z"))

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "New fact" }
      ], instant("2026-02-25T14:00:00.000Z"))

      const deleted = yield* port.forget(AGENT_ID, instant("2026-02-25T12:00:00.000Z"))
      expect(deleted).toBe(1)

      const remaining = yield* port.search(AGENT_ID, { limit: 10 })
      expect(remaining.items).toHaveLength(1)
      expect(remaining.items[0].content).toBe("New fact")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search isolates items by agentId", () => {
    const dbPath = testDatabasePath("mem-isolation")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")
      const otherAgent = "agent:other" as AgentId

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Agent 1 fact" }
      ], now)

      yield* port.encode(otherAgent, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Agent 2 fact" }
      ], now)

      const result = yield* port.search(AGENT_ID, { limit: 10 })
      expect(result.items).toHaveLength(1)
      expect(result.items[0].content).toBe("Agent 1 fact")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

const makeMemoryLayer = (dbPath: string) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.orDie
  )
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

  return MemoryPortSqlite.layer.pipe(
    Layer.provideMerge(sqlInfrastructureLayer)
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
