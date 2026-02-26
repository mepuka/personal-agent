import { TurnStreamEvent } from "@template/domain/events"
import type { ConversationId, SessionId } from "@template/domain/ids"
import { ContentBlock } from "@template/domain/ports"
import { Effect, Schema, Stream } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { SessionTurnPortTag } from "../PortTags.js"
import { TurnProcessingRuntime } from "../turn/TurnProcessingRuntime.js"
import { TurnProcessingError } from "../turn/TurnProcessingWorkflow.js"

const SessionStateFields = {
  sessionId: Schema.String,
  conversationId: Schema.String,
  tokenCapacity: Schema.Number,
  tokensUsed: Schema.Number
} as const

const StartSessionRpc = Rpc.make("startSession", {
  payload: SessionStateFields,
  success: Schema.Void,
  primaryKey: ({ sessionId }) => `start:${sessionId}`
}).annotate(ClusterSchema.Persisted, true)

const ProcessTurnPayloadFields = {
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  agentId: Schema.String,
  userId: Schema.String,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlock),
  createdAt: Schema.DateTimeUtcFromString,
  inputTokens: Schema.Number
} as const

// NOTE: stream + Persisted is broken when success schema contains Transform
// fields (e.g. DateTimeUtcFromString). See docs/issues/effect-cluster-stream-
// persisted-transform-bug.md for root cause analysis.
const ProcessTurnRpc = Rpc.make("processTurn", {
  payload: ProcessTurnPayloadFields,
  success: TurnStreamEvent,
  error: TurnProcessingError,
  stream: true
})

export const SessionEntity = Entity.make("Session", [
  StartSessionRpc,
  ProcessTurnRpc
])

export const layer = SessionEntity.toLayer(Effect.gen(function*() {
  const sessionPort = yield* SessionTurnPortTag
  const runtime = yield* TurnProcessingRuntime

  return {
    startSession: ({ payload, address }) =>
      sessionPort.startSession({
        sessionId: payload.sessionId as SessionId,
        conversationId: payload.conversationId as ConversationId,
        tokenCapacity: payload.tokenCapacity,
        tokensUsed: payload.tokensUsed
      }).pipe(
        Effect.withSpan("SessionEntity.startSession"),
        Effect.annotateLogs({ module: "SessionEntity", entityId: address.entityId })
      ),

    processTurn: ({ payload }) =>
      runtime.processTurnStream(payload).pipe(
        Stream.withSpan("SessionEntity.processTurn")
      )
  }
}))
