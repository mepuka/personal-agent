import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AgentConfig, AgentProfileNotFound } from "../src/ai/AgentConfig.js"

const testYaml = {
  providers: {
    anthropic: { apiKeyEnv: "PA_ANTHROPIC_API_KEY" },
    openai: { apiKeyEnv: "PA_OPENAI_API_KEY" }
  },
  agents: {
    default: {
      persona: { name: "Test Assistant", systemPrompt: "You are helpful." },
      model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      generation: { temperature: 0.7, maxOutputTokens: 4096 }
    },
    summarizer: {
      persona: { name: "Summarizer", systemPrompt: "Summarize concisely." },
      model: { provider: "openai", modelId: "gpt-4o-mini" },
      generation: { temperature: 0.2, maxOutputTokens: 1024 }
    }
  },
  server: { port: 3000 }
}

const testLayer = AgentConfig.layerFromParsed(testYaml)

describe("AgentConfig", () => {
  it.effect("getAgent returns the default profile", () =>
    Effect.gen(function*() {
      const config = yield* AgentConfig
      const profile = yield* config.getAgent("default")
      expect(profile.persona.name).toBe("Test Assistant")
      expect(profile.model.provider).toBe("anthropic")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("getAgent returns named profiles", () =>
    Effect.gen(function*() {
      const config = yield* AgentConfig
      const profile = yield* config.getAgent("summarizer")
      expect(profile.persona.name).toBe("Summarizer")
      expect(profile.model.provider).toBe("openai")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("getAgent maps agent:bootstrap to default profile", () =>
    Effect.gen(function*() {
      const config = yield* AgentConfig
      const profile = yield* config.getAgent("agent:bootstrap")
      expect(profile.persona.name).toBe("Test Assistant")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("getAgent fails for unknown agent", () =>
    Effect.gen(function*() {
      const config = yield* AgentConfig
      const exit = yield* config.getAgent("nonexistent").pipe(Effect.flip)
      expect(exit).toBeInstanceOf(AgentProfileNotFound)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("defaultAgent returns the default profile", () =>
    Effect.gen(function*() {
      const config = yield* AgentConfig
      expect(config.defaultAgent.persona.name).toBe("Test Assistant")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("providers map is populated", () =>
    Effect.gen(function*() {
      const config = yield* AgentConfig
      expect(config.providers.size).toBe(2)
      expect(config.providers.get("anthropic")?.apiKeyEnv).toBe("PA_ANTHROPIC_API_KEY")
    }).pipe(Effect.provide(testLayer))
  )
})
