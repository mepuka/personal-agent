import { RuntimeApi, RuntimeStatus } from "@template/domain/RuntimeApi"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

const RuntimeApiLive = HttpApiBuilder.group(RuntimeApi, "runtime", (handlers) =>
  handlers.handle("getStatus", () =>
    Effect.succeed(new RuntimeStatus({
      service: "personal-agent",
      phase: "mvp-kickoff",
      ontologyVersion: "PAO v0.8.0",
      architectureVersion: "0.3.0-draft",
      branch: "codex/mvp-implementation-kickoff"
    }))
  )
)

export const ApiLive = HttpApiBuilder.layer(RuntimeApi).pipe(
  Layer.provide(RuntimeApiLive)
)
