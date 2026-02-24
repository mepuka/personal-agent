import type { ScheduledExecutionId, ScheduleId } from "@template/domain/ids"
import type { Instant, ScheduleRecord, ScheduleSkipReason, TriggerSource } from "@template/domain/ports"
import type { ExecutionOutcome } from "@template/domain/status"
import { DateTime, Effect, HashMap, HashSet, Layer, Option, Ref, ServiceMap } from "effect"
import { SchedulePortTag } from "./PortTags.js"

export interface ExecutionTicket {
  readonly executionId: ScheduledExecutionId
  readonly scheduleId: ScheduleId
  readonly dueAt: Instant
  readonly triggerSource: TriggerSource
  readonly startedAt: Instant
  readonly actionRef: string
}

export class SchedulerRuntime extends ServiceMap.Service<SchedulerRuntime>()(
  "server/SchedulerRuntime",
  {
    make: Effect.gen(function*() {
      const schedulePort = yield* SchedulePortTag
      const inFlightBySchedule = yield* Ref.make(
        HashMap.empty<ScheduleId, ReadonlyArray<ExecutionTicket>>()
      )
      const replacedExecutionIds = yield* Ref.make(
        HashSet.empty<ScheduledExecutionId>()
      )

      const claimDue = (now: Instant) =>
        Effect.gen(function*() {
          const due = yield* schedulePort.listDue(now)
          const sorted = [...due].sort(compareDueCandidates)
          const claimed: Array<ExecutionTicket> = []

          for (const candidate of sorted) {
            const ticket = yield* claimCandidate(
              candidate.schedule,
              candidate.dueAt,
              candidate.triggerSource,
              now
            )
            if (ticket !== null) {
              claimed.push(ticket)
            }
          }

          return claimed as ReadonlyArray<ExecutionTicket>
        })

      const triggerNow = (schedule: ScheduleRecord, now: Instant) =>
        Effect.gen(function*() {
          if (schedule.scheduleStatus !== "ScheduleActive") {
            yield* recordSkippedExecution({
              scheduleId: schedule.scheduleId,
              dueAt: now,
              triggerSource: "Manual",
              startedAt: now,
              endedAt: now,
              reason: "ManualTriggerInactive"
            })
            return null
          }

          return yield* claimCandidate(schedule, now, "Manual", now)
        })

      const completeExecution = (
        ticket: ExecutionTicket,
        outcome: ExecutionOutcome,
        endedAt: Instant
      ) =>
        Effect.gen(function*() {
          const isReplaced = yield* Ref.get(replacedExecutionIds).pipe(
            Effect.map((set) => HashSet.has(set, ticket.executionId))
          )
          if (isReplaced) {
            return false
          }

          const map = yield* Ref.get(inFlightBySchedule)
          const inFlight = Option.getOrElse(
            HashMap.get(map, ticket.scheduleId),
            () => [] as ReadonlyArray<ExecutionTicket>
          )
          const isInFlight = inFlight.some(
            (current) => current.executionId === ticket.executionId
          )
          if (!isInFlight) {
            return false
          }

          const remaining = inFlight.filter(
            (current) => current.executionId !== ticket.executionId
          )
          yield* Ref.set(
            inFlightBySchedule,
            HashMap.set(map, ticket.scheduleId, remaining)
          )
          yield* schedulePort.recordExecution({
            executionId: ticket.executionId,
            scheduleId: ticket.scheduleId,
            dueAt: ticket.dueAt,
            triggerSource: ticket.triggerSource,
            outcome,
            startedAt: ticket.startedAt,
            endedAt,
            skipReason: null
          })

          return true
        })

      const claimCandidate = (
        schedule: ScheduleRecord,
        dueAt: Instant,
        triggerSource: TriggerSource,
        now: Instant
      ) =>
        Effect.gen(function*() {
          const map = yield* Ref.get(inFlightBySchedule)
          const inFlight = Option.getOrElse(
            HashMap.get(map, schedule.scheduleId),
            () => [] as ReadonlyArray<ExecutionTicket>
          )

          switch (schedule.concurrencyPolicy) {
            case "ConcurrencyAllow": {
              const ticket = createExecutionTicket(
                schedule.scheduleId,
                dueAt,
                triggerSource,
                now,
                schedule.actionRef
              )
              yield* Ref.set(
                inFlightBySchedule,
                HashMap.set(map, schedule.scheduleId, [...inFlight, ticket])
              )
              return ticket
            }
            case "ConcurrencyForbid": {
              if (inFlight.length > 0) {
                yield* recordSkippedExecution({
                  scheduleId: schedule.scheduleId,
                  dueAt,
                  triggerSource,
                  startedAt: now,
                  endedAt: now,
                  reason: "ConcurrencyForbid"
                })
                return null
              }

              const ticket = createExecutionTicket(
                schedule.scheduleId,
                dueAt,
                triggerSource,
                now,
                schedule.actionRef
              )
              yield* Ref.set(
                inFlightBySchedule,
                HashMap.set(map, schedule.scheduleId, [...inFlight, ticket])
              )
              return ticket
            }
            case "ConcurrencyReplace": {
              if (inFlight.length > 0) {
                for (const existing of inFlight) {
                  yield* Ref.update(replacedExecutionIds, (set) => HashSet.add(set, existing.executionId))
                  yield* recordSkippedExecution({
                    scheduleId: schedule.scheduleId,
                    dueAt: existing.dueAt,
                    triggerSource: existing.triggerSource,
                    startedAt: existing.startedAt,
                    endedAt: now,
                    reason: "ConcurrencyReplace",
                    executionId: existing.executionId
                  })
                }
              }

              const ticket = createExecutionTicket(
                schedule.scheduleId,
                dueAt,
                triggerSource,
                now,
                schedule.actionRef
              )
              yield* Ref.set(
                inFlightBySchedule,
                HashMap.set(map, schedule.scheduleId, [ticket])
              )
              return ticket
            }
          }
        })

      const recordSkippedExecution = ({
        dueAt,
        endedAt,
        executionId,
        reason,
        scheduleId,
        startedAt,
        triggerSource
      }: {
        readonly scheduleId: ScheduleId
        readonly dueAt: Instant
        readonly triggerSource: TriggerSource
        readonly startedAt: Instant
        readonly endedAt: Instant
        readonly reason: ScheduleSkipReason
        readonly executionId?: ScheduledExecutionId
      }) =>
        schedulePort.recordExecution({
          executionId: executionId ?? makeExecutionId(),
          scheduleId,
          dueAt,
          triggerSource,
          outcome: "ExecutionSkipped",
          startedAt,
          endedAt,
          skipReason: reason
        })

      return {
        claimDue,
        triggerNow,
        completeExecution
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const compareDueCandidates = (
  left: {
    readonly schedule: ScheduleRecord
    readonly dueAt: Instant
  },
  right: {
    readonly schedule: ScheduleRecord
    readonly dueAt: Instant
  }
): number => {
  const dueDiff = DateTime.toEpochMillis(left.dueAt) - DateTime.toEpochMillis(right.dueAt)
  if (dueDiff !== 0) {
    return dueDiff
  }
  return String(left.schedule.scheduleId).localeCompare(
    String(right.schedule.scheduleId)
  )
}

const createExecutionTicket = (
  scheduleId: ScheduleId,
  dueAt: Instant,
  triggerSource: TriggerSource,
  startedAt: Instant,
  actionRef: string
): ExecutionTicket => ({
  executionId: makeExecutionId(),
  scheduleId,
  dueAt,
  triggerSource,
  startedAt,
  actionRef
})

const makeExecutionId = (): ScheduledExecutionId => crypto.randomUUID() as ScheduledExecutionId
