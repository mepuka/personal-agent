import type { Instant } from "@template/domain/ports"
import { DateTime, Effect, Layer, ServiceMap } from "effect"
import { SchedulerRuntime } from "../SchedulerRuntime.js"
import { SchedulerActionExecutor } from "./SchedulerActionExecutor.js"
import { SchedulerCommandEntity, type SchedulerExecutePayload } from "./SchedulerCommandEntity.js"

export interface SchedulerDispatchSummary {
  readonly claimed: number
  readonly dispatched: number
  readonly accepted: number
}

export class SchedulerDispatchLoop extends ServiceMap.Service<SchedulerDispatchLoop>()(
  "server/SchedulerDispatchLoop",
  {
    make: Effect.gen(function*() {
      const runtime = yield* SchedulerRuntime
      const executor = yield* SchedulerActionExecutor
      const makeClient = yield* SchedulerCommandEntity.client
      const client = makeClient("scheduler-command-lane")

      const dispatchDue = (now: Instant): Effect.Effect<SchedulerDispatchSummary> =>
        Effect.gen(function*() {
          const tickets = yield* runtime.claimDue(now)
          let accepted = 0

          for (const ticket of tickets) {
            const outcome = yield* executor.execute(ticket)
            const endedAt = yield* DateTime.now

            const payload: SchedulerExecutePayload = {
              executionId: ticket.executionId,
              scheduleId: ticket.scheduleId,
              ownerAgentId: ticket.ownerAgentId,
              dueAt: ticket.dueAt,
              triggerSource: ticket.triggerSource,
              startedAt: ticket.startedAt,
              endedAt,
              actionRef: ticket.actionRef,
              outcome,
              agentId: ticket.ownerAgentId
            }

            const result = yield* client.execute(payload).pipe(Effect.orDie)
            if (result.accepted) {
              accepted += 1
            }
          }

          return {
            claimed: tickets.length,
            dispatched: tickets.length,
            accepted
          } as const
        })

      return {
        dispatchDue
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
