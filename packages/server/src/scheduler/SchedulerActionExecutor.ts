import type { ConversationId, SessionId } from "@template/domain/ids"
import type { ExecutionOutcome } from "@template/domain/status"
import { Effect, Layer, ServiceMap } from "effect"
import { GovernancePortTag } from "../PortTags.js"
import { SubroutineCatalog, type SubroutineCatalogService } from "../memory/SubroutineCatalog.js"
import { SubroutineRunner, type SubroutineContext, type SubroutineRunnerService } from "../memory/SubroutineRunner.js"
import type { ExecutionTicket } from "../SchedulerRuntime.js"
import { CommandRuntime, type CommandRuntimeService } from "../tools/command/CommandRuntime.js"

const SCHEDULE_COMMAND_PREFIX = "action:command:"

const MEMORY_SUBROUTINE_PREFIX = "action:memory_subroutine:"

const parseMemorySubroutineId = (actionRef: string): string | null => {
  if (!actionRef.startsWith(MEMORY_SUBROUTINE_PREFIX)) return null
  const id = actionRef.slice(MEMORY_SUBROUTINE_PREFIX.length)
  return id.length > 0 ? id : null
}

const parseScheduleCommand = (actionRef: string): string | null => {
  if (!actionRef.startsWith(SCHEDULE_COMMAND_PREFIX)) {
    return null
  }

  const encoded = actionRef.slice(SCHEDULE_COMMAND_PREFIX.length)
  if (encoded.length === 0) {
    return ""
  }

  try {
    return decodeURIComponent(encoded)
  } catch {
    return ""
  }
}

export class SchedulerActionExecutor extends ServiceMap.Service<SchedulerActionExecutor>()(
  "server/SchedulerActionExecutor",
  {
    make: Effect.gen(function*() {
      const governance = yield* GovernancePortTag
      const commandRuntime = yield* CommandRuntime
      const subroutineRunner = yield* SubroutineRunner
      const subroutineCatalog = yield* SubroutineCatalog

      const execute = (ticket: ExecutionTicket): Effect.Effect<ExecutionOutcome> =>
        Effect.gen(function*() {
          const policy = yield* governance.evaluatePolicy({
            agentId: ticket.ownerAgentId,
            sessionId: null,
            action: "ExecuteSchedule"
          })

          if (policy.decision === "Deny") {
            yield* Effect.log("Scheduled action denied by governance", {
              scheduleId: ticket.scheduleId,
              actionRef: ticket.actionRef,
              decision: policy.decision,
              reason: policy.reason
            })
            return "ExecutionSkipped" as const
          }

          if (policy.decision === "RequireApproval") {
            yield* Effect.log("Scheduled action requires approval; skipping", {
              scheduleId: ticket.scheduleId,
              actionRef: ticket.actionRef,
              decision: policy.decision,
              reason: policy.reason
            })
            return "ExecutionSkipped" as const
          }

          return yield* dispatchAction({
            ticket,
            commandRuntime,
            subroutineRunner,
            subroutineCatalog
          }).pipe(
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

const dispatchAction = (params: {
  readonly ticket: ExecutionTicket
  readonly commandRuntime: CommandRuntimeService
  readonly subroutineRunner: SubroutineRunnerService
  readonly subroutineCatalog: SubroutineCatalogService
}): Effect.Effect<ExecutionOutcome> =>
  Effect.gen(function*() {
    const subroutineId = parseMemorySubroutineId(params.ticket.actionRef)
    if (subroutineId !== null) {
      const loaded = yield* params.subroutineCatalog.getById(subroutineId).pipe(
        Effect.catchTag("SubroutineNotFound", () =>
          Effect.gen(function*() {
            yield* Effect.log("Unknown memory subroutine in schedule", {
              scheduleId: params.ticket.scheduleId,
              subroutineId
            })
            return null
          })
        )
      )
      if (!loaded) return "ExecutionFailed" as const

      const runId = crypto.randomUUID()
      const context: SubroutineContext = {
        agentId: params.ticket.ownerAgentId,
        sessionId: `session:scheduled:${params.ticket.scheduleId}` as SessionId,
        conversationId: `conversation:scheduled:${runId}` as ConversationId,
        turnId: null,
        triggerType: "Scheduled",
        triggerReason: `Schedule: ${params.ticket.scheduleId} (${params.ticket.triggerSource})`,
        now: params.ticket.startedAt,
        runId
      }

      const result = yield* params.subroutineRunner.execute(loaded, context)
      return result.success
        ? "ExecutionSucceeded" as const
        : "ExecutionFailed" as const
    }

    const command = parseScheduleCommand(params.ticket.actionRef)
    if (command !== null) {
      if (command.trim().length === 0) {
        yield* Effect.log("Invalid scheduled command action", {
          scheduleId: params.ticket.scheduleId,
          actionRef: params.ticket.actionRef
        })
        return "ExecutionFailed" as const
      }

      const execution = yield* params.commandRuntime.execute({
        context: {
          source: "schedule",
          agentId: params.ticket.ownerAgentId
        },
        request: {
          command
        }
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.gen(function*() {
              yield* Effect.log("Scheduled command execution failed", {
                scheduleId: params.ticket.scheduleId,
                actionRef: params.ticket.actionRef,
                command,
                errorTag: error._tag
              })
              return "ExecutionFailed" as const
            }),
          onSuccess: (result) =>
            Effect.succeed(
              result.exitCode === 0
                ? "ExecutionSucceeded" as const
                : "ExecutionFailed" as const
            )
        })
      )

      return execution
    }

    switch (params.ticket.actionRef) {
      case "action:log":
        return yield* Effect.log("Scheduled action executed", {
          scheduleId: params.ticket.scheduleId,
          actionRef: params.ticket.actionRef
        }).pipe(Effect.as("ExecutionSucceeded" as const))
      case "action:health_check":
        return yield* Effect.log("Health check", {
          scheduleId: params.ticket.scheduleId
        }).pipe(Effect.as("ExecutionSucceeded" as const))
      default:
        return yield* Effect.log("Unknown action ref, skipping", {
          actionRef: params.ticket.actionRef
        }).pipe(Effect.as("ExecutionSkipped" as const))
    }
  })
