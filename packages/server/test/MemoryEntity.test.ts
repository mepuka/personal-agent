import { describe, expect, it } from "@effect/vitest"
import { MemoryAccessDenied } from "@template/domain/errors"
import type { AgentId } from "@template/domain/ids"
import type { GovernancePort, Instant, MemoryPort } from "@template/domain/ports"
import type { AuthorizationDecision } from "@template/domain/status"
import { DateTime, Effect, Layer } from "effect"
import { Entity, ShardingConfig, SingleRunner } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import { MemoryEntity, layer as MemoryEntityLayer } from "../src/entities/MemoryEntity.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { GovernancePortTag, MemoryPortTag } from "../src/PortTags.js"

const AGENT_ID = "agent:mem-entity" as AgentId

describe("MemoryEntity", () => {
  it.effect("store + search round-trip", () => {
    const dbPath = testDatabasePath("mem-entity-roundtrip")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)

      const ids = yield* client.store({
        requestId: "store:roundtrip",
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User's name is Alex" },
          { tier: "EpisodicMemory", scope: "SessionScope", source: "AgentSource", content: "Discussed TypeScript" }
        ]
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

  it.live("store timestamps items with server clock", () => {
    const dbPath = testDatabasePath("mem-entity-server-clock")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)

      const before = yield* DateTime.now

      yield* client.store({
        requestId: "store:server-clock",
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Fact A" }
        ]
      })
      const after = yield* DateTime.now

      const result = yield* client.search({ query: "Fact A", limit: 10 })
      expect(result.items).toHaveLength(1)
      const createdAt = DateTime.toEpochMillis(result.items[0].createdAt)
      expect(createdAt).toBeGreaterThanOrEqual(DateTime.toEpochMillis(before))
      expect(createdAt).toBeLessThanOrEqual(DateTime.toEpochMillis(after))
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
          requestId: `store:page:${i}`,
          items: [
            { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: `Item ${i}` }
          ]
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

  it.live("store is idempotent for the same requestId", () => {
    const dbPath = testDatabasePath("mem-entity-store-idempotent")
    const layer = makeClusterLayer(dbPath)
    return Effect.gen(function*() {
      const makeClient = yield* MemoryEntity.client
      const client = makeClient(AGENT_ID)

      const first = yield* client.store({
        requestId: "store:idempotent",
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Idempotent fact" }
        ]
      })

      const second = yield* client.store({
        requestId: "store:idempotent",
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Idempotent fact" }
        ]
      })

      const result = yield* client.search({ query: "Idempotent fact", limit: 10 })
      expect(result.items).toHaveLength(1)
      expect(second).toEqual(first)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.live("forget is idempotent for the same requestId", () => {
    const dbPath = testDatabasePath("mem-entity-forget-idempotent")
    const layer = makeClusterLayer(dbPath)
    return Effect.gen(function*() {
      const makeClient = yield* MemoryEntity.client
      const client = makeClient(AGENT_ID)

      yield* client.store({
        requestId: "store:forget-idempotent",
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Old fact" },
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "New fact" }
        ]
      })

      const cutoff = instant("2100-01-01T00:00:00.000Z")

      const firstDelete = yield* client.forget({
        requestId: "forget:idempotent",
        cutoff
      })
      const secondDelete = yield* client.forget({
        requestId: "forget:idempotent",
        cutoff
      })

      const remaining = yield* client.search({ limit: 10 })
      expect(firstDelete).toBe(2)
      expect(secondDelete).toBe(firstDelete)
      expect(remaining.items).toHaveLength(0)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("store and forget allow audits do not collide when requestId is reused", () => {
    const dbPath = testDatabasePath("mem-entity-audit-id-scope")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)
      const governance = yield* GovernancePortSqlite

      yield* client.store({
        requestId: "shared-request",
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "Scoped audit memory" }
        ]
      })
      yield* client.forget({
        requestId: "shared-request",
        cutoff: instant("2100-01-01T00:00:00.000Z")
      })

      const audits = yield* governance.listAuditEntries()
      const allowAudits = audits.filter((entry) => entry.decision === "Allow")
      expect(allowAudits.filter((entry) => entry.reason === "memory_store_allowed")).toHaveLength(1)
      expect(allowAudits.filter((entry) => entry.reason === "memory_forget_allowed")).toHaveLength(1)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("governance deny blocks search/store/forget and writes audit", () => {
    const dbPath = testDatabasePath("mem-entity-governance-deny")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(AGENT_ID)
      const governance = yield* GovernancePortSqlite
      const memoryPort = yield* MemoryPortSqlite

      const storeError = yield* client.store({
        requestId: "store:deny",
        items: [
          { tier: "SemanticMemory", scope: "GlobalScope", source: "UserSource", content: "User fact" },
          { tier: "SemanticMemory", scope: "GlobalScope", source: "AgentSource", content: "Agent fact" }
        ]
      }).pipe(Effect.flip)
      const searchError = yield* client.search({ limit: 10 }).pipe(Effect.flip)
      const forgetError = yield* client.forget({
        requestId: "forget:deny",
        cutoff: instant("2100-01-01T00:00:00.000Z")
      }).pipe(Effect.flip)

      expect(storeError).toBeInstanceOf(MemoryAccessDenied)
      expect(searchError).toBeInstanceOf(MemoryAccessDenied)
      expect(forgetError).toBeInstanceOf(MemoryAccessDenied)
      expect(storeError.decision).toBe("Deny")
      expect(searchError.decision).toBe("Deny")
      expect(forgetError.decision).toBe("Deny")

      const persistedItems = yield* memoryPort.search(AGENT_ID, { limit: 10 })
      expect(persistedItems.items).toHaveLength(0)

      const audits = yield* governance.listAuditEntries()
      expect(audits.some((entry) => entry.reason.startsWith("memory_store_denied"))).toBe(true)
      expect(audits.some((entry) => entry.reason.startsWith("memory_search_denied"))).toBe(true)
      expect(audits.some((entry) => entry.reason.startsWith("memory_forget_denied"))).toBe(true)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath, "Deny")),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

const makeTestLayer = (
  dbPath: string,
  forcedDecision: AuthorizationDecision = "Allow"
) => {
  const sqlInfrastructureLayer = makeSqlInfrastructureLayer(dbPath)
  const {
    governanceSqliteLayer,
    governanceTagLayer,
    memorySqliteLayer,
    memoryTagLayer
  } = makeMemoryGovernanceLayers(sqlInfrastructureLayer, forcedDecision)

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    governanceSqliteLayer,
    governanceTagLayer,
    memorySqliteLayer,
    memoryTagLayer,
    ShardingConfig.layer()
  )
}

const makeClusterLayer = (
  dbPath: string,
  forcedDecision: AuthorizationDecision = "Allow"
) => {
  const sqlInfrastructureLayer = makeSqlInfrastructureLayer(dbPath)
  const {
    governanceSqliteLayer,
    governanceTagLayer,
    memorySqliteLayer,
    memoryTagLayer
  } = makeMemoryGovernanceLayers(sqlInfrastructureLayer, forcedDecision)

  const clusterLayer = SingleRunner.layer().pipe(
    Layer.provide(sqlInfrastructureLayer),
    Layer.orDie
  )

  const memoryEntityLayer = MemoryEntityLayer.pipe(
    Layer.provide(clusterLayer),
    Layer.provide(memoryTagLayer),
    Layer.provide(governanceTagLayer)
  )

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    governanceSqliteLayer,
    governanceTagLayer,
    memorySqliteLayer,
    memoryTagLayer,
    memoryEntityLayer
  ).pipe(
    Layer.provideMerge(clusterLayer)
  )
}

const makeSqlInfrastructureLayer = (dbPath: string) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.orDie
  )
  return Layer.mergeAll(sqliteLayer, migrationLayer)
}

const makeMemoryGovernanceLayers = (
  sqlInfrastructureLayer: ReturnType<typeof makeSqlInfrastructureLayer>,
  forcedDecision: AuthorizationDecision
) => {
  const governanceSqliteLayer = GovernancePortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const governanceTagLayer = Layer.effect(
    GovernancePortTag,
    Effect.gen(function*() {
      const governance = yield* GovernancePortSqlite
      if (forcedDecision === "Allow") {
        return governance as GovernancePort
      }
      return {
        ...governance,
        evaluatePolicy: (_input) =>
          Effect.succeed({
            decision: forcedDecision,
            policyId: null,
            reason: `forced_${forcedDecision.toLowerCase()}`
          })
      } as GovernancePort
    })
  ).pipe(Layer.provide(governanceSqliteLayer))

  const memorySqliteLayer = MemoryPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const memoryTagLayer = Layer.effect(
    MemoryPortTag,
    Effect.gen(function*() {
      return (yield* MemoryPortSqlite) as MemoryPort
    })
  ).pipe(Layer.provide(memorySqliteLayer))

  return {
    governanceSqliteLayer,
    governanceTagLayer,
    memorySqliteLayer,
    memoryTagLayer
  } as const
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
