import { describe, expect, it } from "@effect/vitest"
import fc from "fast-check"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
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

  it.effect("cursor pagination works with non-monotonic created_at", () => {
    const dbPath = testDatabasePath("mem-nonmono")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite

      // Insert out of order: newest first by created_at, but oldest rowid
      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Newest" }
      ], instant("2026-02-25T14:00:00.000Z"))

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Oldest" }
      ], instant("2026-02-25T10:00:00.000Z"))

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Middle" }
      ], instant("2026-02-25T12:00:00.000Z"))

      // CreatedAsc: should be Oldest, Middle, Newest regardless of rowid order
      const page1 = yield* port.search(AGENT_ID, { sort: "CreatedAsc", limit: 2 })
      expect(page1.items.map((i) => i.content)).toEqual(["Oldest", "Middle"])
      expect(page1.cursor).not.toBeNull()

      const page2 = yield* port.search(AGENT_ID, { sort: "CreatedAsc", limit: 2, cursor: page1.cursor! })
      expect(page2.items.map((i) => i.content)).toEqual(["Newest"])
      expect(page2.cursor).toBeNull()

      // CreatedDesc: should be Newest, Middle, Oldest
      const descPage1 = yield* port.search(AGENT_ID, { sort: "CreatedDesc", limit: 2 })
      expect(descPage1.items.map((i) => i.content)).toEqual(["Newest", "Middle"])
      expect(descPage1.cursor).not.toBeNull()

      const descPage2 = yield* port.search(AGENT_ID, { sort: "CreatedDesc", limit: 2, cursor: descPage1.cursor! })
      expect(descPage2.items.map((i) => i.content)).toEqual(["Oldest"])
      expect(descPage2.cursor).toBeNull()
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("malformed cursor is ignored (treated as no cursor)", () => {
    const dbPath = testDatabasePath("mem-badcursor")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Item A" },
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Item B" }
      ], now)

      // Garbage cursor
      const result1 = yield* port.search(AGENT_ID, { limit: 10, cursor: "not-valid-base64!!!" })
      expect(result1.items).toHaveLength(2)

      // Empty string cursor
      const result2 = yield* port.search(AGENT_ID, { limit: 10, cursor: "" })
      expect(result2.items).toHaveLength(2)

      // Valid base64 but wrong JSON shape
      const badJson = Buffer.from('{"wrong":"shape"}').toString("base64url")
      const result3 = yield* port.search(AGENT_ID, { limit: 10, cursor: badJson })
      expect(result3.items).toHaveLength(2)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("encode generates unique IDs across same-millisecond calls", () => {
    const dbPath = testDatabasePath("mem-ids")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      const ids1 = yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "First" }
      ], now)

      const ids2 = yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Second" }
      ], now)

      expect(ids1[0]).not.toBe(ids2[0])

      const result = yield* port.search(AGENT_ID, { limit: 10 })
      expect(result.items).toHaveLength(2)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("CreatedDesc cursor walk returns all items", () => {
    const dbPath = testDatabasePath("mem-desc-walk")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite

      for (let i = 0; i < 5; i++) {
        yield* port.encode(AGENT_ID, [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: `Item ${i}` }
        ], instant(`2026-02-25T1${i}:00:00.000Z`))
      }

      // Walk all pages with limit 2, CreatedDesc
      const allItems: Array<string> = []
      let cursor: string | null = null
      for (let page = 0; page < 5; page++) {
        const result = yield* port.search(AGENT_ID, {
          sort: "CreatedDesc",
          limit: 2,
          ...(cursor ? { cursor } : {})
        })
        allItems.push(...result.items.map((i) => i.content))
        cursor = result.cursor
        if (cursor === null) break
      }

      expect(allItems).toEqual(["Item 4", "Item 3", "Item 2", "Item 1", "Item 0"])
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

describe("MemoryPortSqlite property-based tests", () => {
  const CursorSchema = Schema.Struct({
    createdAt: Schema.String,
    rowid: Schema.Int
  })
  const CursorFromJsonString = Schema.fromJsonString(CursorSchema)

  it("cursor roundtrip: encode → decode is identity for arbitrary CursorData", () => {
    const arb = Schema.toArbitrary(CursorSchema)

    fc.assert(
      fc.property(arb, (data) => {
        const json = Schema.encodeSync(CursorFromJsonString)(data)
        const base64 = Buffer.from(json).toString("base64url")
        const decoded = Option.getOrNull(
          Schema.decodeOption(CursorFromJsonString)(
            Buffer.from(base64, "base64url").toString("utf8")
          )
        )
        expect(decoded).not.toBeNull()
        expect(decoded!.createdAt).toBe(data.createdAt)
        expect(decoded!.rowid).toBe(data.rowid)
      }),
      { numRuns: 200 }
    )
  })

  it("malformed cursors never crash, always decode to null", () => {
    fc.assert(
      fc.property(fc.string(), (randomString) => {
        const decoded = Option.getOrNull(
          Schema.decodeOption(CursorFromJsonString)(
            Buffer.from(randomString, "base64url").toString("utf8")
          )
        )
        // Either null (invalid) or a valid cursor shape
        if (decoded !== null) {
          expect(typeof decoded.createdAt).toBe("string")
          expect(Number.isInteger(decoded.rowid)).toBe(true)
        }
      }),
      { numRuns: 500 }
    )
  })

  it.effect("pagination completeness: walking all pages yields all items for any limit", () => {
    const dbPath = testDatabasePath("mem-prop-pagination")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const itemCount = 10

      for (let i = 0; i < itemCount; i++) {
        yield* port.encode(AGENT_ID, [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: `PropItem ${i}` }
        ], instant(`2026-02-25T${String(10 + i).padStart(2, "0")}:00:00.000Z`))
      }

      for (const limit of [1, 2, 3, 5, 7, 10, 20]) {
        for (const sort of ["CreatedAsc", "CreatedDesc"] as const) {
          const allItems: Array<string> = []
          let cursor: string | null = null
          let pages = 0

          do {
            const result = yield* port.search(AGENT_ID, {
              sort,
              limit,
              ...(cursor ? { cursor } : {})
            })
            allItems.push(...result.items.map((i) => i.content))
            cursor = result.cursor
            pages++
            if (pages > 20) break
          } while (cursor !== null)

          expect(allItems).toHaveLength(itemCount)
          expect(new Set(allItems).size).toBe(itemCount)
        }
      }
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("search handles arbitrary cursor strings without crashing", () => {
    const dbPath = testDatabasePath("mem-prop-fuzz-cursor")
    const layer = makeMemoryLayer(dbPath)

    return Effect.gen(function*() {
      const port = yield* MemoryPortSqlite
      const now = instant("2026-02-25T12:00:00.000Z")

      yield* port.encode(AGENT_ID, [
        { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Test item" }
      ], now)

      const samples = fc.sample(fc.string(), 100)
      for (const randomCursor of samples) {
        const result = yield* port.search(AGENT_ID, { limit: 10, cursor: randomCursor })
        expect(result.items.length).toBeGreaterThanOrEqual(0)
        expect(result.totalCount).toBeGreaterThanOrEqual(0)
      }
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
