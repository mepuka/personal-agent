import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ModelRegistry } from "../src/ai/ModelRegistry.js"
import { AgentConfig } from "../src/ai/AgentConfig.js"

const testConfig = {
  providers: {
    anthropic: { apiKeyEnv: "PA_ANTHROPIC_API_KEY" }
  },
  agents: {
    default: {
      persona: { name: "Test", systemPrompt: "x" },
      model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      generation: { temperature: 0.7, maxOutputTokens: 4096 }
    }
  },
  server: { port: 3000 }
}

describe("ModelRegistry", () => {
  it.effect("service loads and exposes get function", () =>
    Effect.gen(function*() {
      const registry = yield* ModelRegistry
      expect(typeof registry.get).toBe("function")
    }).pipe(
      Effect.provide(
        ModelRegistry.layer.pipe(
          Layer.provide(AgentConfig.layerFromParsed(testConfig))
        )
      )
    )
  )
})
