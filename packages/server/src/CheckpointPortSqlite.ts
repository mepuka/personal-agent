import {
  CheckpointAlreadyDecided,
  CheckpointExpired,
  CheckpointNotFound
} from "@template/domain/errors"
import type { AgentId, ChannelId, CheckpointId, PolicyId, SessionId } from "@template/domain/ids"
import type { CheckpointPort, CheckpointRecord } from "@template/domain/ports"
import type { CheckpointStatus, GovernanceAction } from "@template/domain/status"
import { DateTime, Effect, Layer, Option, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

const CheckpointRowSchema = Schema.Struct({
  checkpoint_id: Schema.String,
  agent_id: Schema.String,
  session_id: Schema.String,
  channel_id: Schema.String,
  turn_id: Schema.String,
  action: Schema.String,
  policy_id: Schema.Union([Schema.String, Schema.Null]),
  reason: Schema.String,
  payload_json: Schema.String,
  payload_hash: Schema.String,
  status: Schema.String,
  requested_at: Schema.String,
  decided_at: Schema.Union([Schema.String, Schema.Null]),
  decided_by: Schema.Union([Schema.String, Schema.Null]),
  expires_at: Schema.Union([Schema.String, Schema.Null])
})
type CheckpointRow = typeof CheckpointRowSchema.Type

const CheckpointIdRequest = Schema.Struct({ checkpointId: Schema.String })
const InstantFromSqlString = Schema.DateTimeUtcFromString
const decodeSqlInstant = Schema.decodeUnknownSync(InstantFromSqlString)
const encodeSqlInstant = Schema.encodeSync(InstantFromSqlString)

const decodeCheckpointRow = (row: CheckpointRow): CheckpointRecord => ({
  checkpointId: row.checkpoint_id as CheckpointId,
  agentId: row.agent_id as AgentId,
  sessionId: row.session_id as SessionId,
  channelId: row.channel_id as ChannelId,
  turnId: row.turn_id,
  action: row.action as GovernanceAction,
  policyId: row.policy_id as PolicyId | null,
  reason: row.reason,
  payloadJson: row.payload_json,
  payloadHash: row.payload_hash,
  status: row.status as CheckpointStatus,
  requestedAt: decodeSqlInstant(row.requested_at),
  decidedAt: row.decided_at ? decodeSqlInstant(row.decided_at) : null,
  decidedBy: row.decided_by,
  expiresAt: row.expires_at ? decodeSqlInstant(row.expires_at) : null
})

export class CheckpointPortSqlite extends ServiceMap.Service<CheckpointPortSqlite>()(
  "server/CheckpointPortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findCheckpointById = SqlSchema.findOneOption({
        Request: CheckpointIdRequest,
        Result: CheckpointRowSchema,
        execute: ({ checkpointId }) =>
          sql`
            SELECT
              checkpoint_id, agent_id, session_id, channel_id, turn_id,
              action, policy_id, reason, payload_json, payload_hash,
              status, requested_at, decided_at, decided_by, expires_at
            FROM checkpoints
            WHERE checkpoint_id = ${checkpointId}
            LIMIT 1
          `.withoutTransform
      })

      const create: CheckpointPort["create"] = (record) =>
        sql`
          INSERT INTO checkpoints (
            checkpoint_id, agent_id, session_id, channel_id, turn_id,
            action, policy_id, reason, payload_json, payload_hash,
            status, requested_at, decided_at, decided_by, expires_at
          ) VALUES (
            ${record.checkpointId},
            ${record.agentId},
            ${record.sessionId},
            ${record.channelId},
            ${record.turnId},
            ${record.action},
            ${record.policyId},
            ${record.reason},
            ${record.payloadJson},
            ${record.payloadHash},
            ${record.status},
            ${encodeSqlInstant(record.requestedAt)},
            ${record.decidedAt ? encodeSqlInstant(record.decidedAt) : null},
            ${record.decidedBy},
            ${record.expiresAt ? encodeSqlInstant(record.expiresAt) : null}
          )
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const get: CheckpointPort["get"] = (checkpointId) =>
        findCheckpointById({ checkpointId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (row) => {
                const record = decodeCheckpointRow(row)
                // Lazily mark expired pending checkpoints
                if (
                  record.status === "Pending" &&
                  record.expiresAt !== null
                ) {
                  return DateTime.now.pipe(
                    Effect.flatMap((now) => {
                      if (DateTime.isGreaterThan(now, record.expiresAt!)) {
                        return sql`
                          UPDATE checkpoints
                          SET status = 'Expired'
                          WHERE checkpoint_id = ${checkpointId}
                            AND status = 'Pending'
                        `.unprepared.pipe(
                          Effect.as({ ...record, status: "Expired" as CheckpointStatus })
                        )
                      }
                      return Effect.succeed(record)
                    })
                  )
                }
                return Effect.succeed(record)
              }
            })
          ),
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const transition: CheckpointPort["transition"] = (
        checkpointId,
        toStatus,
        decidedBy,
        decidedAt
      ) =>
        Effect.gen(function*() {
          const checkpoint = yield* get(checkpointId)
          if (checkpoint === null) {
            return yield* new CheckpointNotFound({ checkpointId })
          }

          // Check valid transitions
          if (toStatus === "Consumed") {
            // Approved -> Consumed
            if (checkpoint.status !== "Approved") {
              return yield* new CheckpointAlreadyDecided({
                checkpointId,
                currentStatus: checkpoint.status
              })
            }
          } else {
            // Pending -> Approved|Rejected|Deferred
            if (checkpoint.status !== "Pending") {
              return yield* new CheckpointAlreadyDecided({
                checkpointId,
                currentStatus: checkpoint.status
              })
            }

            // Check expiry for approval attempts
            if (
              checkpoint.expiresAt !== null &&
              (toStatus === "Approved" || toStatus === "Rejected" || toStatus === "Deferred")
            ) {
              const now = yield* DateTime.now
              if (DateTime.isGreaterThan(now, checkpoint.expiresAt)) {
                // Mark as expired in DB
                yield* sql`
                  UPDATE checkpoints
                  SET status = 'Expired'
                  WHERE checkpoint_id = ${checkpointId}
                    AND status = 'Pending'
                `.unprepared.pipe(Effect.orDie)
                return yield* new CheckpointExpired({ checkpointId })
              }
            }
          }

          // CAS update
          const fromStatus = toStatus === "Consumed" ? "Approved" : "Pending"
          const decidedAtStr = encodeSqlInstant(decidedAt)

          yield* sql`
            UPDATE checkpoints
            SET status = ${toStatus},
                decided_at = ${decidedAtStr},
                decided_by = ${decidedBy}
            WHERE checkpoint_id = ${checkpointId}
              AND status = ${fromStatus}
          `.unprepared.pipe(Effect.orDie)
        }).pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError)
        )

      const listPending: CheckpointPort["listPending"] = (agentId) =>
        Effect.gen(function*() {
          const now = yield* DateTime.now
          const nowStr = encodeSqlInstant(now)
          const rows = agentId
            ? yield* sql`
                SELECT
                  checkpoint_id, agent_id, session_id, channel_id, turn_id,
                  action, policy_id, reason, payload_json, payload_hash,
                  status, requested_at, decided_at, decided_by, expires_at
                FROM checkpoints
                WHERE status = 'Pending'
                  AND agent_id = ${agentId}
                  AND (expires_at IS NULL OR expires_at > ${nowStr})
                ORDER BY requested_at ASC
              `.withoutTransform
            : yield* sql`
                SELECT
                  checkpoint_id, agent_id, session_id, channel_id, turn_id,
                  action, policy_id, reason, payload_json, payload_hash,
                  status, requested_at, decided_at, decided_by, expires_at
                FROM checkpoints
                WHERE status = 'Pending'
                  AND (expires_at IS NULL OR expires_at > ${nowStr})
                ORDER BY requested_at ASC
              `.withoutTransform

          return rows.map((row: any) => {
            const decoded = Schema.decodeUnknownSync(CheckpointRowSchema)(row)
            return decodeCheckpointRow(decoded)
          })
        }).pipe(
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      return {
        create,
        get,
        transition,
        listPending
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
