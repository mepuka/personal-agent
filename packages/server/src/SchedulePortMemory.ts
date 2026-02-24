import type { ScheduleId } from "@template/domain/ids"
import type { DueScheduleRecord, ScheduledExecutionRecord, SchedulePort, ScheduleRecord } from "@template/domain/ports"
import { Effect, HashMap, Layer, Option, Ref, ServiceMap } from "effect"
import {
  dueWindows,
  executionFinishedAt,
  nextExecutionAfterRecord,
  triggerSourceFromTrigger
} from "./scheduler/ScheduleDue.js"

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

    const getSchedule = (scheduleId: ScheduleId) =>
      Ref.get(schedules).pipe(
        Effect.map((map) => Option.getOrNull(HashMap.get(map, scheduleId)))
      )

    const listExecutions = () => Ref.get(executions)

    return {
      upsertSchedule,
      listDue,
      recordExecution,
      getSchedule,
      listExecutions
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
