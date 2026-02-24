import { describe, expect, it } from "@effect/vitest"
import type { AgentId, AuditEntryId } from "@template/domain/ids"
import type { Instant } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"

describe("GovernancePortSqlite", () => {
  it.effect("persists audit entries", () => {
    const dbPath = testDatabasePath("audit-write")
    const layer = makeGovernanceLayer(dbPath)
    const now = instant("2026-02-24T12:00:00.000Z")

    return Effect.gen(function*() {
      const governance = yield* GovernancePortSqlite

      yield* governance.writeAudit({
        auditEntryId: "audit:1" as AuditEntryId,
        agentId: "agent:governance" as AgentId,
        sessionId: null,
        decision: "Allow",
        reason: "policy_allow_default",
        createdAt: now
      })

      const audits = yield* governance.listAuditEntries()
      expect(audits).toHaveLength(1)
      expect(audits[0].auditEntryId).toBe("audit:1")
      expect(audits[0].reason).toBe("policy_allow_default")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("retains audit entries across restart", () => {
    const dbPath = testDatabasePath("audit-restart")
    const firstLayer = makeGovernanceLayer(dbPath)
    const secondLayer = makeGovernanceLayer(dbPath)
    const now = instant("2026-02-24T12:00:00.000Z")

    return Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const governance = yield* GovernancePortSqlite
        yield* governance.writeAudit({
          auditEntryId: "audit:restart" as AuditEntryId,
          agentId: "agent:governance" as AgentId,
          sessionId: null,
          decision: "Allow",
          reason: "restart_probe",
          createdAt: now
        })
      }).pipe(Effect.provide(firstLayer))

      const audits = yield* Effect.gen(function*() {
        const governance = yield* GovernancePortSqlite
        return yield* governance.listAuditEntries()
      }).pipe(Effect.provide(secondLayer))

      expect(audits).toHaveLength(1)
      expect(audits[0].auditEntryId).toBe("audit:restart")
    }).pipe(
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

const makeGovernanceLayer = (dbPath: string) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.orDie
  )
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    GovernancePortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer))
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
