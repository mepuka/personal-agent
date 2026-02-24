import { Effect, Layer, Option, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type { ScheduledExecutionId, ScheduleId } from "../../domain/src/ids.js"
import {
  type DueScheduleRecord,
  type Instant,
  type ScheduledExecutionRecord,
  type SchedulePort,
  type ScheduleRecord,
  ScheduleSkipReason,
  type Trigger,
  TriggerSource
} from "../../domain/src/ports.js"
import { ConcurrencyPolicy, ExecutionOutcome, ScheduleStatus } from "../../domain/src/status.js"
import {
  dueWindows,
  executionFinishedAt,
  nextExecutionAfterRecord,
  triggerSourceFromTrigger
} from "./scheduler/ScheduleDue.js"

const ScheduleRowSchema = Schema.Struct({
  schedule_id: Schema.String,
  owner_agent_id: Schema.String,
  recurrence_label: Schema.String,
  cron_expression: Schema.Union([Schema.String, Schema.Null]),
  interval_seconds: Schema.Union([Schema.Number, Schema.Null]),
  trigger_tag: Schema.Literals(["CronTrigger", "IntervalTrigger", "EventTrigger"]),
  action_ref: Schema.String,
  schedule_status: ScheduleStatus,
  concurrency_policy: ConcurrencyPolicy,
  allows_catch_up: Schema.Number,
  auto_disable_after_run: Schema.Number,
  catch_up_window_seconds: Schema.Number,
  max_catch_up_runs_per_tick: Schema.Number,
  last_execution_at: Schema.Union([Schema.String, Schema.Null]),
  next_execution_at: Schema.Union([Schema.String, Schema.Null])
})
type ScheduleRow = typeof ScheduleRowSchema.Type

const ExecutionRowSchema = Schema.Struct({
  execution_id: Schema.String,
  schedule_id: Schema.String,
  due_at: Schema.String,
  trigger_source: TriggerSource,
  outcome: ExecutionOutcome,
  started_at: Schema.String,
  ended_at: Schema.Union([Schema.String, Schema.Null]),
  skip_reason: Schema.Union([ScheduleSkipReason, Schema.Null])
})
type ExecutionRow = typeof ExecutionRowSchema.Type

const ScheduleIdRequest = Schema.Struct({ scheduleId: Schema.String })
const DueAtRequest = Schema.Struct({ dueAtIso: Schema.String })
const EmptyRequest = Schema.Struct({})
const InstantFromSqlString = Schema.DateTimeUtcFromString
const decodeSqlInstant = Schema.decodeUnknownSync(InstantFromSqlString)
const encodeSqlInstant = Schema.encodeSync(InstantFromSqlString)

export class SchedulePortSqlite extends ServiceMap.Service<SchedulePortSqlite>()(
  "server/SchedulePortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findScheduleById = SqlSchema.findOneOption({
        Request: ScheduleIdRequest,
        Result: ScheduleRowSchema,
        execute: ({ scheduleId }) =>
          sql`
            SELECT
              schedule_id,
              owner_agent_id,
              recurrence_label,
              cron_expression,
              interval_seconds,
              trigger_tag,
              action_ref,
              schedule_status,
              concurrency_policy,
              allows_catch_up,
              auto_disable_after_run,
              catch_up_window_seconds,
              max_catch_up_runs_per_tick,
              last_execution_at,
              next_execution_at
            FROM schedules
            WHERE schedule_id = ${scheduleId}
            LIMIT 1
          `.withoutTransform
      })

      const findDueSchedules = SqlSchema.findAll({
        Request: DueAtRequest,
        Result: ScheduleRowSchema,
        execute: ({ dueAtIso }) =>
          sql`
            SELECT
              schedule_id,
              owner_agent_id,
              recurrence_label,
              cron_expression,
              interval_seconds,
              trigger_tag,
              action_ref,
              schedule_status,
              concurrency_policy,
              allows_catch_up,
              auto_disable_after_run,
              catch_up_window_seconds,
              max_catch_up_runs_per_tick,
              last_execution_at,
              next_execution_at
            FROM schedules
            WHERE schedule_status = 'ScheduleActive'
              AND next_execution_at IS NOT NULL
              AND next_execution_at <= ${dueAtIso}
              AND (cron_expression IS NOT NULL OR interval_seconds IS NOT NULL)
          `.withoutTransform
      })

      const findAllExecutions = SqlSchema.findAll({
        Request: EmptyRequest,
        Result: ExecutionRowSchema,
        execute: () =>
          sql`
            SELECT
              execution_id,
              schedule_id,
              due_at,
              trigger_source,
              outcome,
              started_at,
              ended_at,
              skip_reason
            FROM scheduled_executions
            ORDER BY created_at ASC, execution_id ASC
          `.withoutTransform
      })

      const getScheduleRow = (
        scheduleId: ScheduleId
      ): Effect.Effect<ScheduleRecord | null, SqlError | Schema.SchemaError> =>
        findScheduleById({ scheduleId }).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: decodeScheduleRow
            })
          )
        )

      const upsertSchedule: SchedulePort["upsertSchedule"] = (schedule) =>
        sql`
          INSERT INTO schedules (
            schedule_id,
            owner_agent_id,
            recurrence_label,
            cron_expression,
            interval_seconds,
            trigger_tag,
            action_ref,
            schedule_status,
            concurrency_policy,
            allows_catch_up,
            auto_disable_after_run,
            catch_up_window_seconds,
            max_catch_up_runs_per_tick,
            last_execution_at,
            next_execution_at
          ) VALUES (
            ${schedule.scheduleId},
            ${schedule.ownerAgentId},
            ${schedule.recurrencePattern.label},
            ${schedule.recurrencePattern.cronExpression},
            ${schedule.recurrencePattern.intervalSeconds},
            ${schedule.trigger._tag},
            ${schedule.actionRef},
            ${schedule.scheduleStatus},
            ${schedule.concurrencyPolicy},
            ${toSqlBoolean(schedule.allowsCatchUp)},
            ${toSqlBoolean(schedule.autoDisableAfterRun)},
            ${schedule.catchUpWindowSeconds},
            ${schedule.maxCatchUpRunsPerTick},
            ${toSqlInstant(schedule.lastExecutionAt)},
            ${toSqlInstant(schedule.nextExecutionAt)}
          )
          ON CONFLICT(schedule_id) DO UPDATE SET
            owner_agent_id = excluded.owner_agent_id,
            recurrence_label = excluded.recurrence_label,
            cron_expression = excluded.cron_expression,
            interval_seconds = excluded.interval_seconds,
            trigger_tag = excluded.trigger_tag,
            action_ref = excluded.action_ref,
            schedule_status = excluded.schedule_status,
            concurrency_policy = excluded.concurrency_policy,
            allows_catch_up = excluded.allows_catch_up,
            auto_disable_after_run = excluded.auto_disable_after_run,
            catch_up_window_seconds = excluded.catch_up_window_seconds,
            max_catch_up_runs_per_tick = excluded.max_catch_up_runs_per_tick,
            last_execution_at = excluded.last_execution_at,
            next_execution_at = excluded.next_execution_at
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.orDie
        )

      const listDue: SchedulePort["listDue"] = (now) =>
        findDueSchedules({ dueAtIso: toRequiredSqlInstant(now) }).pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => {
              const schedule = decodeScheduleRow(row)
              return dueWindows(schedule, now).map(
                (dueAt): DueScheduleRecord => ({
                  schedule,
                  dueAt,
                  triggerSource: triggerSourceFromTrigger(schedule.trigger)
                })
              )
            })
          ),
          Effect.orDie
        )

      const recordExecution: SchedulePort["recordExecution"] = (record) =>
        sql.withTransaction(
          Effect.gen(function*() {
            yield* sql`
              INSERT OR REPLACE INTO scheduled_executions (
                execution_id,
                schedule_id,
                due_at,
                trigger_source,
                outcome,
                started_at,
                ended_at,
                skip_reason
              ) VALUES (
                ${record.executionId},
                ${record.scheduleId},
                ${toSqlInstant(record.dueAt)},
                ${record.triggerSource},
                ${record.outcome},
                ${toSqlInstant(record.startedAt)},
                ${toSqlInstant(record.endedAt)},
                ${record.skipReason}
              )
            `.unprepared

            const current = yield* getScheduleRow(record.scheduleId)
            if (current === null) {
              return
            }

            if (current.autoDisableAfterRun) {
              yield* sql`
                UPDATE schedules
                SET
                  last_execution_at = ${toSqlInstant(executionFinishedAt(record))},
                  schedule_status = 'ScheduleDisabled',
                  next_execution_at = NULL
                WHERE schedule_id = ${record.scheduleId}
              `.unprepared
              return
            }

            yield* sql`
              UPDATE schedules
              SET
                last_execution_at = ${toSqlInstant(executionFinishedAt(record))},
                next_execution_at = ${toSqlInstant(nextExecutionAfterRecord(current, record))}
              WHERE schedule_id = ${record.scheduleId}
            `.unprepared
          })
        ).pipe(
          Effect.asVoid,
          Effect.orDie
        )

      const getSchedule = (scheduleId: ScheduleId) =>
        getScheduleRow(scheduleId).pipe(
          Effect.map((row) => row === null ? null : row),
          Effect.orDie
        )

      const listExecutions = () =>
        findAllExecutions({}).pipe(
          Effect.map((rows) => rows.map(decodeExecutionRow)),
          Effect.orDie
        )

      return {
        upsertSchedule,
        listDue,
        recordExecution,
        getSchedule,
        listExecutions
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const decodeScheduleRow = (row: ScheduleRow): ScheduleRecord => ({
  scheduleId: row.schedule_id as ScheduleId,
  ownerAgentId: row.owner_agent_id as ScheduleRecord["ownerAgentId"],
  recurrencePattern: {
    label: row.recurrence_label,
    cronExpression: row.cron_expression,
    intervalSeconds: row.interval_seconds
  },
  trigger: decodeTrigger(row.trigger_tag),
  actionRef: row.action_ref,
  scheduleStatus: row.schedule_status,
  concurrencyPolicy: row.concurrency_policy,
  allowsCatchUp: row.allows_catch_up === 1,
  autoDisableAfterRun: row.auto_disable_after_run === 1,
  catchUpWindowSeconds: row.catch_up_window_seconds,
  maxCatchUpRunsPerTick: row.max_catch_up_runs_per_tick,
  lastExecutionAt: fromSqlInstant(row.last_execution_at),
  nextExecutionAt: fromSqlInstant(row.next_execution_at)
})

const decodeExecutionRow = (row: ExecutionRow): ScheduledExecutionRecord => ({
  executionId: row.execution_id as ScheduledExecutionId,
  scheduleId: row.schedule_id as ScheduleId,
  dueAt: fromRequiredSqlInstant(row.due_at),
  triggerSource: row.trigger_source,
  outcome: row.outcome,
  startedAt: fromRequiredSqlInstant(row.started_at),
  endedAt: fromSqlInstant(row.ended_at),
  skipReason: row.skip_reason
})

const decodeTrigger = (tag: ScheduleRow["trigger_tag"]): Trigger => {
  switch (tag) {
    case "CronTrigger": {
      return { _tag: "CronTrigger" }
    }
    case "EventTrigger": {
      return { _tag: "EventTrigger" }
    }
    case "IntervalTrigger":
    default: {
      return { _tag: "IntervalTrigger" }
    }
  }
}

const toSqlBoolean = (value: boolean): number => value ? 1 : 0

const toRequiredSqlInstant = (instant: Instant): string => encodeSqlInstant(instant)

const toSqlInstant = (instant: Instant | null): string | null => instant === null ? null : encodeSqlInstant(instant)

const fromRequiredSqlInstant = (value: string): Instant => decodeSqlInstant(value)

const fromSqlInstant = (value: string | null): Instant | null => value === null ? null : fromRequiredSqlInstant(value)
