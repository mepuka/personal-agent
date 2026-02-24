import type { AgentId, ConversationId, SessionId } from "@template/domain/ids"
import { ClusterEntityError } from "@template/domain/errors"
import { CreateSessionResponse, RuntimeApi, RuntimeStatus } from "@template/domain/RuntimeApi"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentEntity } from "./entities/AgentEntity.js"
import { SessionEntity } from "./entities/SessionEntity.js"

const toClusterEntityError = (entityType: string) => (error: unknown) =>
  new ClusterEntityError({
    entityType,
    reason: error instanceof Error ? error.message : String(error)
  })

const RuntimeApiLive = HttpApiBuilder.group(
  RuntimeApi,
  "runtime",
  (handlers) =>
    handlers
      .handle("getStatus", () =>
        Effect.gen(function*() {
          const makeAgentClient = yield* AgentEntity.client
          const agentId = "agent:bootstrap" as AgentId
          const agentClient = makeAgentClient(agentId)

          const existing = yield* agentClient.getState({ agentId }).pipe(
            Effect.mapError(toClusterEntityError("Agent"))
          )
          if (existing === null) {
            yield* agentClient.upsertState({
              agentId,
              permissionMode: "Standard",
              tokenBudget: 200_000,
              quotaPeriod: "Daily",
              tokensConsumed: 0,
              budgetResetAt: null
            }).pipe(
              Effect.mapError(toClusterEntityError("Agent"))
            )
          }

          return new RuntimeStatus({
            service: "personal-agent",
            phase: "phase1-message-content-streaming-sse",
            ontologyVersion: "PAO v0.8.0",
            architectureVersion: "0.3.0-draft",
            branch: "codex/mvp-implementation-kickoff"
          })
        }))
      .handle("createSession", ({ payload }) =>
        Effect.gen(function*() {
          const makeSessionClient = yield* SessionEntity.client
          const sessionClient = makeSessionClient(payload.sessionId)

          yield* sessionClient.startSession({
            sessionId: payload.sessionId as SessionId,
            conversationId: payload.conversationId as ConversationId,
            tokenCapacity: payload.tokenCapacity,
            tokensUsed: 0
          }).pipe(
            Effect.mapError(toClusterEntityError("Session"))
          )

          return new CreateSessionResponse({
            sessionId: payload.sessionId,
            conversationId: payload.conversationId,
            tokenCapacity: payload.tokenCapacity,
            tokensUsed: 0
          })
        }))
)

export const ApiLive = HttpApiBuilder.layer(RuntimeApi).pipe(
  Layer.provide(RuntimeApiLive)
)
