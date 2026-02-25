import { describe, expect, it } from "@effect/vitest"
import type { GovernancePort, Instant } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { Entity, ShardingConfig } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GovernanceEntity, layer as GovernanceEntityLayer } from "../src/entities/GovernanceEntity.js"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { GovernancePortTag } from "../src/PortTags.js"

describe("GovernanceEntity", () => {
  it.effect("evaluatePolicy returns allow by default", () => {
    const dbPath = testDatabasePath("governance-entity-policy")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(GovernanceEntity, GovernanceEntityLayer)
      const client = yield* makeClient("agent:policy-test")

      const decision = yield* client.evaluatePolicy({
        agentId: "agent:policy-test",
        sessionId: "session:policy-test",
        action: "ReadMemory"
      })

      expect(decision.decision).toBe("Allow")
      expect(decision.reason).toBe("mvp_default_allow")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("writeAudit persists an audit entry via entity", () => {
    const dbPath = testDatabasePath("governance-entity-audit")
    return Effect.gen(function*() {
      const now = instant("2026-02-24T12:00:00.000Z")
      const makeClient = yield* Entity.makeTestClient(GovernanceEntity, GovernanceEntityLayer)
      const client = yield* makeClient("agent:audit-test")

      yield* client.writeAudit({
        auditEntryId: "audit:entity-test" as unknown as string,
        agentId: "agent:audit-test",
        sessionId: "session:audit-test",
        decision: "Allow",
        reason: "test_reason",
        createdAt: now
      })

      const port = yield* GovernancePortSqlite
      const entries = yield* port.listAuditEntries()
      expect(entries.length).toBe(1)
      expect(entries[0]?.reason).toBe("test_reason")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("checkToolQuota succeeds with default quota", () => {
    const dbPath = testDatabasePath("governance-entity-quota")
    return Effect.gen(function*() {
      const now = instant("2026-02-24T12:00:00.000Z")
      const makeClient = yield* Entity.makeTestClient(GovernanceEntity, GovernanceEntityLayer)
      const client = yield* makeClient("agent:quota-test")

      yield* client.checkToolQuota({
        agentId: "agent:quota-test",
        toolName: "test-tool",
        now
      })
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

  const governanceSqliteLayer = GovernancePortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const governanceTagLayer = Layer.effect(
    GovernancePortTag,
    Effect.gen(function*() {
      return (yield* GovernancePortSqlite) as GovernancePort
    })
  ).pipe(Layer.provide(governanceSqliteLayer))

  return Layer.mergeAll(
    governanceSqliteLayer,
    governanceTagLayer,
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
