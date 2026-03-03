import { Effect, Layer, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type {
  Instant,
  PostCommitTaskRecord,
  TurnPostCommitPort
} from "../../domain/src/ports.js"

// ---------------------------------------------------------------------------
// Row Schema
// ---------------------------------------------------------------------------

const TaskRowSchema = Schema.Struct({
  task_id: Schema.String,
  turn_id: Schema.String,
  agent_id: Schema.String,
  session_id: Schema.String,
  conversation_id: Schema.String,
  created_at: Schema.String,
  status: Schema.String,
  attempts: Schema.Number,
  next_attempt_at: Schema.String,
  claimed_at: Schema.Union([Schema.String, Schema.Null]),
  claim_owner: Schema.Union([Schema.String, Schema.Null]),
  completed_at: Schema.Union([Schema.String, Schema.Null]),
  last_error_code: Schema.Union([Schema.String, Schema.Null]),
  last_error_message: Schema.Union([Schema.String, Schema.Null]),
  payload_json: Schema.String
})
type TaskRow = typeof TaskRowSchema.Type

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

const InstantFromSqlString = Schema.DateTimeUtcFromString
const decodeSqlInstant = Schema.decodeUnknownSync(InstantFromSqlString)
const encodeSqlInstant = Schema.encodeSync(InstantFromSqlString)

const decodeTaskRowSchema = Schema.decodeUnknownSync(TaskRowSchema)

// ---------------------------------------------------------------------------
// Row <-> Record
// ---------------------------------------------------------------------------

const decodeTaskRow = (row: TaskRow): PostCommitTaskRecord => {
  const decoded = decodeTaskRowSchema(row)
  return {
    taskId: decoded.task_id as PostCommitTaskRecord["taskId"],
    turnId: decoded.turn_id as PostCommitTaskRecord["turnId"],
    agentId: decoded.agent_id as PostCommitTaskRecord["agentId"],
    sessionId: decoded.session_id as PostCommitTaskRecord["sessionId"],
    conversationId: decoded.conversation_id as PostCommitTaskRecord["conversationId"],
    createdAt: decodeSqlInstant(decoded.created_at),
    status: decoded.status as PostCommitTaskRecord["status"],
    attempts: decoded.attempts,
    nextAttemptAt: decodeSqlInstant(decoded.next_attempt_at),
    claimedAt: decoded.claimed_at ? decodeSqlInstant(decoded.claimed_at) : null,
    claimOwner: decoded.claim_owner,
    completedAt: decoded.completed_at ? decodeSqlInstant(decoded.completed_at) : null,
    lastErrorCode: decoded.last_error_code,
    lastErrorMessage: decoded.last_error_message,
    payloadJson: decoded.payload_json
  }
}

const toSqlInstant = (instant: Instant): string => encodeSqlInstant(instant)

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TurnPostCommitPortSqlite extends ServiceMap.Service<TurnPostCommitPortSqlite>()(
  "server/TurnPostCommitPortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findDueTasks = SqlSchema.findAll({
        Request: Schema.Struct({
          now: Schema.String,
          limit: Schema.Number
        }),
        Result: TaskRowSchema,
        execute: ({ now, limit }) =>
          sql`
            SELECT
              task_id, turn_id, agent_id, session_id, conversation_id,
              created_at, status, attempts, next_attempt_at,
              claimed_at, claim_owner, completed_at,
              last_error_code, last_error_message, payload_json
            FROM turn_post_commit_tasks
            WHERE status IN ('Pending', 'Retry')
              AND next_attempt_at <= ${now}
            ORDER BY next_attempt_at ASC
            LIMIT ${limit}
          `.withoutTransform
      })

      // Idempotent insert (turn_id UNIQUE constraint)
      const enqueue: TurnPostCommitPort["enqueue"] = (task) =>
        sql`
          INSERT INTO turn_post_commit_tasks (
            task_id, turn_id, agent_id, session_id, conversation_id,
            created_at, status, attempts, next_attempt_at,
            claimed_at, claim_owner, completed_at,
            last_error_code, last_error_message, payload_json
          ) VALUES (
            ${task.taskId},
            ${task.turnId},
            ${task.agentId},
            ${task.sessionId},
            ${task.conversationId},
            ${toSqlInstant(task.createdAt)},
            ${task.status},
            ${task.attempts},
            ${toSqlInstant(task.nextAttemptAt)},
            ${task.claimedAt ? toSqlInstant(task.claimedAt) : null},
            ${task.claimOwner},
            ${task.completedAt ? toSqlInstant(task.completedAt) : null},
            ${task.lastErrorCode},
            ${task.lastErrorMessage},
            ${task.payloadJson}
          )
          ON CONFLICT(turn_id) DO NOTHING
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      // Claim due tasks atomically: SELECT matching rows then UPDATE ownership
      const claimDue: TurnPostCommitPort["claimDue"] = (now, limit, workerId, claimLeaseSeconds) =>
        sql.withTransaction(
          Effect.gen(function*() {
            const nowStr = toSqlInstant(now)
            const rows = yield* findDueTasks({ now: nowStr, limit }).pipe(
              Effect.tapDefect(Effect.logError),
              Effect.orDie
            )

            if (rows.length === 0) return [] as ReadonlyArray<PostCommitTaskRecord>

            const leaseExpiryMs = claimLeaseSeconds * 1000
            const claimedAtStr = nowStr

            const claimed: PostCommitTaskRecord[] = []
            for (const row of rows) {
              // Check for stale claims: if already claimed but lease expired, reclaim
              if (row.status === "Claimed" && row.claimed_at) {
                const claimedTime = decodeSqlInstant(row.claimed_at)
                const elapsedMs = new Date(toSqlInstant(now)).getTime() - new Date(toSqlInstant(claimedTime)).getTime()
                if (elapsedMs < leaseExpiryMs) continue // still held
              }

              yield* sql`
                UPDATE turn_post_commit_tasks
                SET status = 'Claimed',
                    claimed_at = ${claimedAtStr},
                    claim_owner = ${workerId}
                WHERE task_id = ${row.task_id}
                  AND (status IN ('Pending', 'Retry')
                       OR (status = 'Claimed' AND claimed_at <= ${claimedAtStr}))
              `.unprepared

              claimed.push({
                ...decodeTaskRow(row),
                status: "Claimed",
                claimedAt: decodeSqlInstant(claimedAtStr),
                claimOwner: workerId
              })
            }

            return claimed
          })
        ).pipe(
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const markSucceeded: TurnPostCommitPort["markSucceeded"] = (taskId, completedAt) =>
        sql`
          UPDATE turn_post_commit_tasks
          SET status = 'Succeeded',
              completed_at = ${toSqlInstant(completedAt)}
          WHERE task_id = ${taskId}
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const markRetry: TurnPostCommitPort["markRetry"] = (
        taskId,
        now,
        errorCode,
        errorMessage,
        nextAttemptAt
      ) =>
        sql`
          UPDATE turn_post_commit_tasks
          SET status = 'Retry',
              attempts = attempts + 1,
              next_attempt_at = ${toSqlInstant(nextAttemptAt)},
              last_error_code = ${errorCode},
              last_error_message = ${errorMessage},
              claimed_at = NULL,
              claim_owner = NULL
          WHERE task_id = ${taskId}
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const markFailedPermanent: TurnPostCommitPort["markFailedPermanent"] = (
        taskId,
        now,
        errorCode,
        errorMessage
      ) =>
        sql`
          UPDATE turn_post_commit_tasks
          SET status = 'FailedPermanent',
              attempts = attempts + 1,
              completed_at = ${toSqlInstant(now)},
              last_error_code = ${errorCode},
              last_error_message = ${errorMessage}
          WHERE task_id = ${taskId}
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      return {
        enqueue,
        claimDue,
        markSucceeded,
        markRetry,
        markFailedPermanent
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
