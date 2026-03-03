import type { PostCommitTaskId } from "@template/domain/ids"
import type { PostCommitResult } from "@template/domain/ports"
import {
  POST_COMMIT_CLAIM_BATCH_SIZE,
  POST_COMMIT_CLAIM_LEASE_SECONDS,
  POST_COMMIT_MAX_ATTEMPTS,
  POST_COMMIT_TICK_SECONDS
} from "@template/domain/system-defaults"
import { Cause, DateTime, Duration, Effect, Layer, Schedule, ServiceMap } from "effect"
import { POST_COMMIT_COMMAND_LANE_ID } from "../CommandLanes.js"
import { TurnPostCommitPortTag } from "../PortTags.js"
import { TurnPostCommitCommandEntity } from "./TurnPostCommitCommandEntity.js"

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TurnPostCommitDispatchLoop extends ServiceMap.Service<TurnPostCommitDispatchLoop>()(
  "server/turn/TurnPostCommitDispatchLoop",
  {
    make: Effect.gen(function*() {
      const postCommitPort = yield* TurnPostCommitPortTag
      const makeClient = yield* TurnPostCommitCommandEntity.client
      const client = makeClient(POST_COMMIT_COMMAND_LANE_ID)
      const workerId = `worker:${crypto.randomUUID()}`

      const tick = Effect.gen(function*() {
        const now = yield* DateTime.now
        const tasks = yield* postCommitPort.claimDue(
          now,
          POST_COMMIT_CLAIM_BATCH_SIZE,
          workerId,
          POST_COMMIT_CLAIM_LEASE_SECONDS
        )

        // Yield after claim to release any SQLite connection state
        // before starting execution on this fiber
        yield* Effect.sleep(0)

        for (const task of tasks) {
          yield* Effect.log("post_commit_dispatching", {
            taskId: task.taskId,
            turnId: task.turnId,
            sessionId: task.sessionId
          })

          const result = yield* client.executePostCommit({
            taskId: task.taskId,
            turnId: task.turnId,
            agentId: task.agentId,
            sessionId: task.sessionId,
            conversationId: task.conversationId
          }).pipe(
            Effect.timeout(Duration.seconds(30)),
            Effect.catchCause((cause) =>
              Effect.succeed({
                subroutines: [],
                projectionSuccess: false,
                projectionError: `execution_error: ${Cause.pretty(cause)}`
              } satisfies PostCommitResult)
            )
          )

          const completedAt = yield* DateTime.now
          const hasFailure = !result.projectionSuccess
            || result.subroutines.some((s) => !s.success)

          if (!hasFailure) {
            yield* postCommitPort.markSucceeded(task.taskId, completedAt)
            yield* Effect.log("post_commit_executed", {
              taskId: task.taskId,
              turnId: task.turnId,
              sessionId: task.sessionId
            })
          } else {
            const nextAttempts = task.attempts + 1
            const errorCode = !result.projectionSuccess
              ? "projection_failed"
              : "subroutine_failed"
            const errorMessage = summarizeFailure(result)

            if (nextAttempts >= POST_COMMIT_MAX_ATTEMPTS) {
              yield* postCommitPort.markFailedPermanent(
                task.taskId as PostCommitTaskId,
                completedAt,
                errorCode,
                errorMessage
              )
              yield* Effect.log("post_commit_failed_permanent", {
                taskId: task.taskId,
                turnId: task.turnId,
                attempts: nextAttempts,
                errorCode,
                errorMessage
              })
            } else {
              // Exponential backoff: 5s, 10s, 20s, 40s
              const backoffSeconds = 5 * Math.pow(2, nextAttempts - 1)
              const nextAttemptAt = DateTime.add(completedAt, { seconds: backoffSeconds })
              yield* postCommitPort.markRetry(
                task.taskId as PostCommitTaskId,
                completedAt,
                errorCode,
                errorMessage,
                nextAttemptAt
              )
              yield* Effect.log("post_commit_retry_scheduled", {
                taskId: task.taskId,
                turnId: task.turnId,
                attempts: nextAttempts,
                nextAttemptAt: DateTime.formatIso(nextAttemptAt)
              })
            }
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.log("Post-commit tick failed", {
            error: Cause.pretty(cause),
            causeJson: stringifyCause(cause)
          }).pipe(
            Effect.annotateLogs("level", "error")
          )
        )
      )

      // Delay first tick to let the full layer graph finish construction,
      // then yield between each tick so the fiber scheduler can run timeouts.
      const loop = Effect.sleep(Duration.seconds(POST_COMMIT_TICK_SECONDS)).pipe(
        Effect.andThen(Effect.repeat(
          Effect.sleep(0).pipe(Effect.andThen(tick)),
          Schedule.spaced(Duration.seconds(POST_COMMIT_TICK_SECONDS))
        ))
      )
      yield* Effect.forkScoped(loop)

      return {} as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const summarizeFailure = (result: PostCommitResult): string => {
  const parts: string[] = []
  if (!result.projectionSuccess) {
    parts.push(`projection: ${result.projectionError ?? "unknown"}`)
  }
  const failed = result.subroutines.filter((s) => !s.success)
  if (failed.length > 0) {
    parts.push(`subroutines: ${failed.map((s) => `${s.subroutineId}(${s.errorTag})`).join(", ")}`)
  }
  return parts.join("; ").slice(0, 500)
}

const stringifyCause = (cause: Cause.Cause<unknown>): string =>
  JSON.stringify(cause.reasons.map((reason) => {
    if (Cause.isFailReason(reason)) {
      return { _tag: "Fail", error: String(reason.error) }
    }
    if (Cause.isDieReason(reason)) {
      const defect = reason.defect
      return {
        _tag: "Die",
        defect: defect instanceof Error
          ? `${defect.name}: ${defect.message}${defect.stack ? `\n${defect.stack}` : ""}`
          : String(defect)
      }
    }
    return {
      _tag: "Interrupt",
      fiberId: String(reason.fiberId)
    }
  }))
