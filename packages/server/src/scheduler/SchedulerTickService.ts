import { SCHEDULER_TICK_SECONDS } from "@template/domain/system-defaults"
import { DateTime, Duration, Effect, Layer, Schedule, ServiceMap } from "effect"
import { SchedulerDispatchLoop } from "./SchedulerDispatchLoop.js"

export class SchedulerTickService extends ServiceMap.Service<SchedulerTickService>()(
  "server/SchedulerTickService",
  {
    make: Effect.gen(function*() {
      const dispatchLoop = yield* SchedulerDispatchLoop

      const tick = Effect.gen(function*() {
        const now = yield* DateTime.now
        const summary = yield* dispatchLoop.dispatchDue(now)
        yield* Effect.log("Scheduler tick", {
          claimed: summary.claimed,
          dispatched: summary.dispatched,
          accepted: summary.accepted
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.log("Scheduler tick failed", { cause }).pipe(
            Effect.annotateLogs("level", "error")
          )
        )
      )

      const loop = Effect.repeat(tick, Schedule.spaced(Duration.seconds(SCHEDULER_TICK_SECONDS)))
      yield* Effect.forkScoped(loop)

      return {} as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
