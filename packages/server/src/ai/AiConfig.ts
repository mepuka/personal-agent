import type { Redacted } from "effect"
import { Config, Effect, Layer, Option, ServiceMap } from "effect"

export type AiProvider = "anthropic" | "openai"

export interface AiConfigService {
  readonly provider: AiProvider
  readonly model: string
  readonly anthropicApiKey: Redacted.Redacted<string> | null
  readonly openAiApiKey: Redacted.Redacted<string> | null
}

export class AiConfig extends ServiceMap.Service<AiConfig>()(
  "server/ai/AiConfig",
  {
    make: Effect.gen(function*() {
      const providerRaw = yield* Config.string("PA_AI_PROVIDER").pipe(
        Config.withDefault(() => "anthropic")
      )
      const provider = normalizeProvider(providerRaw)

      if (provider === null) {
        return yield* Effect.die(
          new Error(`Unsupported PA_AI_PROVIDER value: ${providerRaw}`)
        )
      }

      const anthropicApiKeyOption = yield* Config.option(
        Config.redacted("PA_ANTHROPIC_API_KEY")
      )
      const openAiApiKeyOption = yield* Config.option(
        Config.redacted("PA_OPENAI_API_KEY")
      )

      if (provider === "anthropic" && Option.isNone(anthropicApiKeyOption)) {
        return yield* Effect.die(
          new Error("PA_ANTHROPIC_API_KEY is required when PA_AI_PROVIDER=anthropic")
        )
      }
      if (provider === "openai" && Option.isNone(openAiApiKeyOption)) {
        return yield* Effect.die(
          new Error("PA_OPENAI_API_KEY is required when PA_AI_PROVIDER=openai")
        )
      }

      const defaultModel = provider === "anthropic"
        ? "claude-3-7-sonnet-latest"
        : "gpt-4o-mini"

      const model = yield* Config.string("PA_AI_MODEL").pipe(
        Config.withDefault(() => defaultModel)
      )

      return {
        provider,
        model,
        anthropicApiKey: Option.getOrNull(anthropicApiKeyOption),
        openAiApiKey: Option.getOrNull(openAiApiKeyOption)
      } satisfies AiConfigService
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const normalizeProvider = (input: string): AiProvider | null => {
  const value = input.trim().toLowerCase()
  if (value === "anthropic") {
    return "anthropic"
  }
  if (value === "openai") {
    return "openai"
  }
  return null
}
