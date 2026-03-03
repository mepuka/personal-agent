import { Effect, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import {
  PostCommitExecutor,
  type ExecutePostCommitPayload
} from "./PostCommitExecutor.js"

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
  const executor = yield* PostCommitExecutor

  return {
    executePostCommit: (
      { payload }: { readonly payload: ExecutePostCommitPayload }
    ): Effect.Effect<PostCommitResult> => executor.execute(payload)
  }
}))
