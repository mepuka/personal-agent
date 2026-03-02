import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type { Instant } from "@template/domain/ports"
import { DateTime, Effect, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { SubroutineCatalog } from "../memory/SubroutineCatalog.js"
import { SubroutineRunner, type SubroutineContext } from "../memory/SubroutineRunner.js"
import { TranscriptProjector } from "../memory/TranscriptProjector.js"

// ---------------------------------------------------------------------------
// RPC Schema
// ---------------------------------------------------------------------------

const PostCommitPayloadFields = {
  taskId: Schema.String,
  turnId: Schema.String,
  agentId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String
} as const

const SubroutineOutcome = Schema.Struct({
  subroutineId: Schema.String,
  success: Schema.Boolean,
  errorTag: Schema.Union([Schema.String, Schema.Null])
})

const PostCommitResult = Schema.Struct({
  subroutines: Schema.Array(SubroutineOutcome),
  projectionSuccess: Schema.Boolean,
  projectionError: Schema.Union([Schema.String, Schema.Null])
})

export type PostCommitResult = typeof PostCommitResult.Type

const ExecutePostCommitRpc = Rpc.make("executePostCommit", {
  payload: PostCommitPayloadFields,
  success: PostCommitResult,
  primaryKey: ({ taskId }) => String(taskId)
}).annotate(ClusterSchema.Persisted, true)

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

export const TurnPostCommitCommandEntity = Entity.make("TurnPostCommitCommand", [
  ExecutePostCommitRpc
]).annotate(ClusterSchema.ClientTracingEnabled, false)

export const layer = TurnPostCommitCommandEntity.toLayer(Effect.gen(function*() {
  const catalog = yield* SubroutineCatalog
  const runner = yield* SubroutineRunner
  const projector = yield* TranscriptProjector

  return {
    executePostCommit: ({ payload }) =>
      Effect.gen(function*() {
        const agentId = payload.agentId as AgentId
        const sessionId = payload.sessionId as SessionId
        const conversationId = payload.conversationId as ConversationId
        const turnId = payload.turnId as TurnId
        const now = yield* DateTime.now

        // Branch 1: Post-turn subroutines (serial execution)
        const postTurnSubs = yield* catalog.getByTrigger(agentId, "PostTurn")
        const subroutineOutcomes: Array<typeof SubroutineOutcome.Type> = []

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
            Effect.catchAllCause((cause) =>
              Effect.succeed({
                subroutineId: sub.config.id,
                runId,
                success: false,
                iterationsUsed: 0,
                toolCallsTotal: 0,
                assistantContent: "",
                modelUsageJson: null,
                checkpointWritten: "skipped" as const,
                error: { tag: "unknown_error" as const, message: `cause: ${cause}` }
              })
            )
          )
          subroutineOutcomes.push({
            subroutineId: sub.config.id,
            success: result.success,
            errorTag: result.error?.tag ?? null
          })
        }

        // Branch 2: Canonical transcript projection from store
        let projectionSuccess = true
        let projectionError: string | null = null
        yield* projector.projectFromStore(agentId, sessionId).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              projectionSuccess = false
              projectionError = `${cause}`
            })
          )
        )

        return {
          subroutines: subroutineOutcomes,
          projectionSuccess,
          projectionError
        }
      })
  }
}))
