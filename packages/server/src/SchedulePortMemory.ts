import type { ScheduleId } from "@template/domain/ids"
import type {
  DueScheduleRecord,
  Instant,
  ScheduledExecutionRecord,
  SchedulePort,
  ScheduleRecord,
  Trigger,
  TriggerSource
} from "@template/domain/ports"
import { DateTime, Effect, HashMap, Layer, Option, Ref, ServiceMap } from "effect"

export class SchedulePortMemory extends ServiceMap.Service<SchedulePortMemory>()("server/SchedulePortMemory", {
  make: Effect.gen(function*() {
    const schedules = yield* Ref.make(HashMap.empty<ScheduleId, ScheduleRecord>())
    const executions = yield* Ref.make(Array<ScheduledExecutionRecord>())

    const upsertSchedule: SchedulePort["upsertSchedule"] = (schedule) =>
      Ref.update(schedules, HashMap.set(schedule.scheduleId, schedule))

    const listDue: SchedulePort["listDue"] = (now) =>
      Ref.get(schedules).pipe(
        Effect.map((map) =>
          Array.from(HashMap.values(map)).flatMap((schedule) =>
            dueWindows(schedule, now).map(
              (dueAt): DueScheduleRecord => ({
                schedule,
                dueAt,
                triggerSource: triggerSourceFromTrigger(schedule.trigger)
              })
            )
          )
        )
      )

    const recordExecution: SchedulePort["recordExecution"] = (record) =>
      Effect.all([
        Ref.update(executions, (all) => [...all, record]),
        Ref.update(schedules, (map) => {
          const current = HashMap.get(map, record.scheduleId)
          if (Option.isNone(current)) {
            return map
          }

          if (current.value.autoDisableAfterRun) {
            return HashMap.set(map, record.scheduleId, {
              ...current.value,
              lastExecutionAt: executionFinishedAt(record),
              scheduleStatus: "ScheduleDisabled",
              nextExecutionAt: null
            })
          }

          return HashMap.set(map, record.scheduleId, {
            ...current.value,
            lastExecutionAt: executionFinishedAt(record),
            nextExecutionAt: nextExecutionAfterRecord(current.value, record)
          })
        })
      ]).pipe(Effect.asVoid)

    return {
      upsertSchedule,
      listDue,
      recordExecution
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}

const dueWindows = (schedule: ScheduleRecord, now: Instant): ReadonlyArray<Instant> => {
  if (schedule.scheduleStatus !== "ScheduleActive") {
    return []
  }
  if (schedule.nextExecutionAt === null) {
    return []
  }
  if (!isRecurrencePatternValid(schedule)) {
    return []
  }
  if (DateTime.toEpochMillis(schedule.nextExecutionAt) > DateTime.toEpochMillis(now)) {
    return []
  }

  const intervalSeconds = schedule.recurrencePattern.intervalSeconds
  if (intervalSeconds === null || intervalSeconds <= 0) {
    return [schedule.nextExecutionAt]
  }

  const allDue = intervalDueWindows(schedule.nextExecutionAt, now, intervalSeconds)
  const boundedByWindow = boundedByCatchUpWindow(allDue, schedule, now)
  if (schedule.allowsCatchUp) {
    const maxRuns = Math.max(schedule.maxCatchUpRunsPerTick, 0)
    return boundedByWindow.slice(0, maxRuns)
  }

  const latest = boundedByWindow.at(-1)
  return latest === undefined ? [] : [latest]
}

const intervalDueWindows = (
  firstDueAt: Instant,
  now: Instant,
  intervalSeconds: number
): ReadonlyArray<Instant> => {
  const windows: Array<Instant> = []
  const nowEpochMillis = DateTime.toEpochMillis(now)
  let cursor = firstDueAt

  while (DateTime.toEpochMillis(cursor) <= nowEpochMillis) {
    windows.push(cursor)
    cursor = DateTime.add(cursor, { seconds: intervalSeconds })
  }

  return windows
}

const boundedByCatchUpWindow = (
  dueWindows: ReadonlyArray<Instant>,
  schedule: ScheduleRecord,
  now: Instant
): ReadonlyArray<Instant> => {
  const catchUpWindowMillis = Math.max(schedule.catchUpWindowSeconds, 0) * 1000
  if (catchUpWindowMillis === 0) {
    return dueWindows
  }

  const cutoffEpochMillis = DateTime.toEpochMillis(now) - catchUpWindowMillis
  return dueWindows.filter((dueAt) => DateTime.toEpochMillis(dueAt) >= cutoffEpochMillis)
}

const executionFinishedAt = (record: ScheduledExecutionRecord): Instant => record.endedAt ?? record.startedAt

const nextExecutionAfterRecord = (
  schedule: ScheduleRecord,
  record: ScheduledExecutionRecord
): Instant | null => {
  const intervalSeconds = schedule.recurrencePattern.intervalSeconds
  if (intervalSeconds !== null && intervalSeconds > 0) {
    return DateTime.add(record.dueAt, { seconds: intervalSeconds })
  }

  if (schedule.nextExecutionAt === null) {
    return null
  }

  const existingNextEpochMillis = DateTime.toEpochMillis(schedule.nextExecutionAt)
  const dueAtEpochMillis = DateTime.toEpochMillis(record.dueAt)
  return existingNextEpochMillis > dueAtEpochMillis ? schedule.nextExecutionAt : null
}

const triggerSourceFromTrigger = (trigger: Trigger): TriggerSource => {
  switch (trigger._tag) {
    case "CronTrigger": {
      return "CronTick"
    }
    case "IntervalTrigger": {
      return "IntervalTick"
    }
    case "EventTrigger": {
      return "Event"
    }
  }
}

const isRecurrencePatternValid = (schedule: ScheduleRecord): boolean =>
  schedule.recurrencePattern.cronExpression !== null ||
  schedule.recurrencePattern.intervalSeconds !== null
