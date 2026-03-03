import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import { Cause, DateTime, Effect, Layer, ServiceMap } from "effect"
import { SubroutineCatalog } from "../memory/SubroutineCatalog.js"
import { SubroutineRunner, type SubroutineContext } from "../memory/SubroutineRunner.js"
import { TranscriptProjector } from "../memory/TranscriptProjector.js"

export interface ExecutePostCommitPayload {
  readonly taskId: string
  readonly turnId: string
  readonly agentId: string
  readonly sessionId: string
  readonly conversationId: string
}

export interface SubroutineOutcome {
  readonly subroutineId: string
  readonly success: boolean
  readonly errorTag: string | null
}

export interface PostCommitResult {
  readonly subroutines: ReadonlyArray<SubroutineOutcome>
  readonly projectionSuccess: boolean
  readonly projectionError: string | null
}

export interface PostCommitExecutorService {
  readonly execute: (payload: ExecutePostCommitPayload) => Effect.Effect<PostCommitResult>
}

export class PostCommitExecutor extends ServiceMap.Service<PostCommitExecutor>()(
  "server/turn/PostCommitExecutor",
  {
    make: Effect.gen(function*() {
      const catalog = yield* SubroutineCatalog
      const runner = yield* SubroutineRunner
      const projector = yield* TranscriptProjector

      const execute: PostCommitExecutorService["execute"] = (payload) =>
        Effect.gen(function*() {
          yield* Effect.log("post_commit_execute_start", {
            taskId: payload.taskId,
            agentId: payload.agentId,
            sessionId: payload.sessionId
          })

          const agentId = payload.agentId as AgentId
          const sessionId = payload.sessionId as SessionId
          const conversationId = payload.conversationId as ConversationId
          const turnId = payload.turnId as TurnId
          const now = yield* DateTime.now

          const postTurnSubs = yield* catalog.getByTrigger(agentId, "PostTurn")
          const subroutineOutcomes: Array<SubroutineOutcome> = []

          for (const sub of postTurnSubs) {
            const runId = `subrun:${payload.taskId}:${sub.config.id}`
            const context: SubroutineContext = {
              agentId,
              sessionId,
              conversationId,
              turnId,
              triggerType: "PostTurn",
              triggerReason: `post-commit task ${payload.taskId}`,
              now,
              runId
            }
            const result = yield* runner.execute(sub, context).pipe(
              Effect.catchCause((cause) =>
                Effect.succeed({
                  subroutineId: sub.config.id,
                  runId,
                  success: false,
                  iterationsUsed: 0,
                  toolCallsTotal: 0,
                  assistantContent: "",
                  modelUsageJson: null,
                  checkpointWritten: "skipped" as const,
                  error: { tag: "unknown_error" as const, message: `cause: ${Cause.pretty(cause)}` }
                })
              )
            )
            subroutineOutcomes.push({
              subroutineId: sub.config.id,
              success: result.success,
              errorTag: result.error?.tag ?? null
            })
          }

          let projectionSuccess = true
          let projectionError: string | null = null
          yield* projector.projectFromStore(agentId, sessionId).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                projectionSuccess = false
                projectionError = Cause.pretty(cause)
              })
            )
          )

          return {
            subroutines: subroutineOutcomes,
            projectionSuccess,
            projectionError
          } satisfies PostCommitResult
        })

      return { execute } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
