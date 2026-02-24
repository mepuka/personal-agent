import * as Anthropic from "@effect/ai-anthropic"
import * as OpenAi from "@effect/ai-openai"
import { Effect, Layer } from "effect"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { AiConfig } from "./AiConfig.js"

export const layer: Layer.Layer<LanguageModel.LanguageModel, never, AiConfig> = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AiConfig

    if (config.provider === "anthropic") {
      return Anthropic.AnthropicLanguageModel.layer({
        model: config.model
      }).pipe(
        Layer.provide(
          Anthropic.AnthropicClient.layer({
            apiKey: toUndefined(config.anthropicApiKey)
          })
        ),
        Layer.provide(FetchHttpClient.layer)
      )
    }

    return OpenAi.OpenAiLanguageModel.layer({
      model: config.model
    }).pipe(
      Layer.provide(
        OpenAi.OpenAiClient.layer({
          apiKey: toUndefined(config.openAiApiKey)
        })
      ),
      Layer.provide(FetchHttpClient.layer)
    )
  })
)

const toUndefined = <A>(value: A | null): A | undefined => value === null ? undefined : value
