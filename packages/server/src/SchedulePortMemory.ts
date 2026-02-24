import type { ScheduleId } from "@template/domain/ids"
import type { ScheduledExecutionRecord, SchedulePort, ScheduleRecord } from "@template/domain/ports"
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
          Array.from(HashMap.values(map)).filter((schedule) =>
            schedule.scheduleStatus === "ScheduleActive" &&
            schedule.nextExecutionAt !== null &&
            DateTime.toEpochMillis(schedule.nextExecutionAt) <= DateTime.toEpochMillis(now)
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
              scheduleStatus: "ScheduleDisabled",
              nextExecutionAt: null
            })
          }
          return map
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
