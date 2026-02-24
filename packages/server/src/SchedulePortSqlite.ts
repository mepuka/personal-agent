import type { ScheduledExecutionId, ScheduleId } from "@template/domain/ids"
import type {
  DueScheduleRecord,
  Instant,
  ScheduledExecutionRecord,
  SchedulePort,
  ScheduleRecord,
  Trigger,
  TriggerSource
} from "@template/domain/ports"
import { DateTime, Effect, Layer, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  dueWindows,
  executionFinishedAt,
  nextExecutionAfterRecord,
  triggerSourceFromTrigger
} from "./scheduler/ScheduleDue.js"

interface ScheduleRow {
  readonly schedule_id: string
  readonly owner_agent_id: string
  readonly recurrence_label: string
  readonly cron_expression: string | null
  readonly interval_seconds: number | null
  readonly trigger_tag: string
  readonly action_ref: string
  readonly schedule_status: ScheduleRecord["scheduleStatus"]
  readonly concurrency_policy: ScheduleRecord["concurrencyPolicy"]
  readonly allows_catch_up: number
  readonly auto_disable_after_run: number
  readonly catch_up_window_seconds: number
  readonly max_catch_up_runs_per_tick: number
  readonly last_execution_at: string | null
  readonly next_execution_at: string | null
}

interface ExecutionRow {
  readonly execution_id: string
  readonly schedule_id: string
  readonly due_at: string
  readonly trigger_source: TriggerSource
  readonly outcome: ScheduledExecutionRecord["outcome"]
  readonly started_at: string
  readonly ended_at: string | null
  readonly skip_reason: ScheduledExecutionRecord["skipReason"]
}

export class SchedulePortSqlite extends ServiceMap.Service<SchedulePortSqlite>()(
  "server/SchedulePortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

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
        sql<ScheduleRow>`
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
            AND next_execution_at <= ${toSqlInstant(now)}
            AND (cron_expression IS NOT NULL OR interval_seconds IS NOT NULL)
        `.withoutTransform.pipe(
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

            const current = yield* getScheduleRow(sql, record.scheduleId)
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
        getScheduleRow(sql, scheduleId).pipe(
          Effect.map((row) => row === null ? null : row),
          Effect.orDie
        )

      const listExecutions = () =>
        sql<ExecutionRow>`
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
        `.withoutTransform.pipe(
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

const getScheduleRow = (
  sql: SqlClient.SqlClient,
  scheduleId: ScheduleId
): Effect.Effect<ScheduleRecord | null, SqlError> =>
  sql<ScheduleRow>`
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
  `.withoutTransform.pipe(
    Effect.map((rows) => rows[0] === undefined ? null : decodeScheduleRow(rows[0]))
  )

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

const decodeTrigger = (tag: string): Trigger => {
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

const toSqlInstant = (instant: Instant | null): string | null => instant === null ? null : DateTime.formatIso(instant)

const fromRequiredSqlInstant = (value: string): Instant => DateTime.fromDateUnsafe(new Date(value))

const fromSqlInstant = (value: string | null): Instant | null => value === null ? null : fromRequiredSqlInstant(value)
