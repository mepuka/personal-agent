import {
  ExecutePostCommitPayload as ExecutePostCommitPayloadSchema,
  PostCommitResult as PostCommitResultSchema,
  type ExecutePostCommitPayload,
  type PostCommitResult
} from "@template/domain/ports"
import { Effect } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { PostCommitExecutor } from "./PostCommitExecutor.js"

// ---------------------------------------------------------------------------
// RPC Schema
// ---------------------------------------------------------------------------

const ExecutePostCommitRpc = Rpc.make("executePostCommit", {
  payload: ExecutePostCommitPayloadSchema.fields,
  success: PostCommitResultSchema,
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
