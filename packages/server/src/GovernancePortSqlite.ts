import { Effect, Layer, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type { AuditEntryRecord, GovernancePort, PolicyDecision } from "../../domain/src/ports.js"
import { AuthorizationDecision } from "../../domain/src/status.js"

const AuditEntryRowSchema = Schema.Struct({
  audit_entry_id: Schema.String,
  agent_id: Schema.String,
  session_id: Schema.Union([Schema.String, Schema.Null]),
  decision: AuthorizationDecision,
  reason: Schema.String,
  created_at: Schema.String
})

const EmptyRequest = Schema.Struct({})
const InstantFromSqlString = Schema.DateTimeUtcFromString
const decodeSqlInstant = Schema.decodeUnknownSync(InstantFromSqlString)
const encodeSqlInstant = Schema.encodeSync(InstantFromSqlString)

export class GovernancePortSqlite extends ServiceMap.Service<GovernancePortSqlite>()(
  "server/GovernancePortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findAllAuditEntries = SqlSchema.findAll({
        Request: EmptyRequest,
        Result: AuditEntryRowSchema,
        execute: () =>
          sql`
            SELECT
              audit_entry_id,
              agent_id,
              session_id,
              decision,
              reason,
              created_at
            FROM audit_entries
            ORDER BY created_at ASC, audit_entry_id ASC
          `.withoutTransform
      })

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
            ${toSqlInstant(entry.createdAt)}
          )
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.orDie
        )

      const enforceSandbox: GovernancePort["enforceSandbox"] = (_agentId, effect) => effect

      const listAuditEntries = () =>
        findAllAuditEntries({}).pipe(
          Effect.map((rows) =>
            rows.map((row): AuditEntryRecord => ({
              auditEntryId: row.audit_entry_id as AuditEntryRecord["auditEntryId"],
              agentId: row.agent_id as AuditEntryRecord["agentId"],
              sessionId: row.session_id as AuditEntryRecord["sessionId"],
              decision: row.decision,
              reason: row.reason,
              createdAt: fromRequiredSqlInstant(row.created_at)
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

const fromRequiredSqlInstant = (value: string) => decodeSqlInstant(value)

const toSqlInstant = (value: AuditEntryRecord["createdAt"]) => encodeSqlInstant(value)
