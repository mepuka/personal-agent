import type { AuditEntryRecord, GovernancePort, PolicyDecision } from "@template/domain/ports"
import { DateTime, Effect, Layer, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

interface AuditEntryRow {
  readonly audit_entry_id: string
  readonly agent_id: string
  readonly session_id: string | null
  readonly decision: AuditEntryRecord["decision"]
  readonly reason: string
  readonly created_at: string
}

export class GovernancePortSqlite extends ServiceMap.Service<GovernancePortSqlite>()(
  "server/GovernancePortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const evaluatePolicy: GovernancePort["evaluatePolicy"] = (_input) =>
        Effect.succeed<PolicyDecision>({
          decision: "Allow",
          policyId: null,
          reason: "mvp_default_allow"
        })

      const checkToolQuota: GovernancePort["checkToolQuota"] = (_agentId, _toolName, _now) => Effect.void

      const writeAudit: GovernancePort["writeAudit"] = (entry) =>
        sql`
          INSERT OR REPLACE INTO audit_entries (
            audit_entry_id,
            agent_id,
            session_id,
            decision,
            reason,
            created_at
          ) VALUES (
            ${entry.auditEntryId},
            ${entry.agentId},
            ${entry.sessionId},
            ${entry.decision},
            ${entry.reason},
            ${DateTime.formatIso(entry.createdAt)}
          )
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.orDie
        )

      const enforceSandbox: GovernancePort["enforceSandbox"] = (_agentId, effect) => effect

      const listAuditEntries = () =>
        sql<AuditEntryRow>`
          SELECT
            audit_entry_id,
            agent_id,
            session_id,
            decision,
            reason,
            created_at
          FROM audit_entries
          ORDER BY created_at ASC, audit_entry_id ASC
        `.withoutTransform.pipe(
          Effect.map((rows) =>
            rows.map((row): AuditEntryRecord => ({
              auditEntryId: row.audit_entry_id as AuditEntryRecord["auditEntryId"],
              agentId: row.agent_id as AuditEntryRecord["agentId"],
              sessionId: row.session_id as AuditEntryRecord["sessionId"],
              decision: row.decision,
              reason: row.reason,
              createdAt: DateTime.fromDateUnsafe(new Date(row.created_at))
            }))
          ),
          Effect.orDie
        )

      return {
        evaluatePolicy,
        checkToolQuota,
        writeAudit,
        enforceSandbox,
        listAuditEntries
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
