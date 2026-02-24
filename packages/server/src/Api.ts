import type { AgentId } from "@template/domain/ids"
import type { AgentState } from "@template/domain/ports"
import { RuntimeApi, RuntimeStatus } from "@template/domain/RuntimeApi"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentStatePortMemory } from "./AgentStatePortMemory.js"

const RuntimeApiLive = HttpApiBuilder.group(
  RuntimeApi,
  "runtime",
  (handlers) =>
    handlers.handle("getStatus", () =>
      Effect.gen(function*() {
        const agentPort = yield* AgentStatePortMemory
        const agentId = "agent:bootstrap" as AgentId

        const existing = yield* agentPort.get(agentId)
        if (existing === null) {
          const bootstrap: AgentState = {
            agentId,
            permissionMode: "Standard",
            tokenBudget: 200_000,
            quotaPeriod: "Daily",
            tokensConsumed: 0,
            budgetResetAt: null
          }
          yield* agentPort.upsert(bootstrap)
        }

        return new RuntimeStatus({
          service: "personal-agent",
          phase: "phase1-in-memory-ports",
          ontologyVersion: "PAO v0.8.0",
          architectureVersion: "0.3.0-draft",
          branch: "codex/mvp-implementation-kickoff"
        })
      }))
)

export const ApiLive = HttpApiBuilder.layer(RuntimeApi).pipe(
  Layer.provide(RuntimeApiLive)
)
