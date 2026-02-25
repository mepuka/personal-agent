import type { ExecutionOutcome } from "@template/domain/status"
import { Effect, Layer, ServiceMap } from "effect"
import { GovernancePortTag } from "../PortTags.js"
import type { ExecutionTicket } from "../SchedulerRuntime.js"

export class SchedulerActionExecutor extends ServiceMap.Service<SchedulerActionExecutor>()(
  "server/SchedulerActionExecutor",
  {
    make: Effect.gen(function*() {
      const governance = yield* GovernancePortTag

      const execute = (ticket: ExecutionTicket): Effect.Effect<ExecutionOutcome> =>
        Effect.gen(function*() {
          const policy = yield* governance.evaluatePolicy({
            agentId: ticket.ownerAgentId,
            sessionId: null,
            action: "ExecuteSchedule"
          })

          if (policy.decision !== "Allow") {
            yield* Effect.log("Scheduled action denied by governance", {
              scheduleId: ticket.scheduleId,
              actionRef: ticket.actionRef,
              decision: policy.decision,
              reason: policy.reason
            })
            return "ExecutionSkipped" as const
          }

          return yield* dispatchAction(ticket).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function*() {
                yield* Effect.log("Scheduled action failed", {
                  scheduleId: ticket.scheduleId,
                  actionRef: ticket.actionRef,
                  cause: String(cause)
                })
                return "ExecutionFailed" as const
              })
            )
          )
        })

      return { execute } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const dispatchAction = (ticket: ExecutionTicket): Effect.Effect<ExecutionOutcome> => {
  switch (ticket.actionRef) {
    case "action:log":
      return Effect.log("Scheduled action executed", {
        scheduleId: ticket.scheduleId,
        actionRef: ticket.actionRef
      }).pipe(Effect.as("ExecutionSucceeded" as const))
    case "action:health_check":
      return Effect.log("Health check", {
        scheduleId: ticket.scheduleId
      }).pipe(Effect.as("ExecutionSucceeded" as const))
    default:
      return Effect.log("Unknown action ref, skipping", {
        actionRef: ticket.actionRef
      }).pipe(Effect.as("ExecutionSucceeded" as const))
  }
}
