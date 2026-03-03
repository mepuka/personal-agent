import { AiProviderName } from "@template/domain/config"
import type { TurnFailureCode } from "@template/domain/events"
import type { ChannelId } from "@template/domain/ids"
import { ChannelType } from "@template/domain/status"
import { Effect, Layer, Option, Schema } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { ChannelCore } from "../ChannelCore.js"
import { CLIAdapterEntity } from "../entities/CLIAdapterEntity.js"
import { toSseTextStream, withFailedTurnEvent } from "./TurnStreamTransport.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const extractParam = (inputUrl: string, index: number): string => {
  const url = new URL(inputUrl, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean)
  return parts[index] ?? ""
}

const InitializeChannelRequest = Schema.Struct({
  channelType: Schema.Union([ChannelType, Schema.Undefined]),
  agentId: Schema.Union([Schema.String, Schema.Undefined])
})

const SendMessageRequest = Schema.Struct({
  content: Schema.String,
  model: Schema.optionalKey(Schema.Struct({
    provider: AiProviderName,
    modelId: Schema.String
  })),
  generationConfig: Schema.optionalKey(Schema.Struct({
    temperature: Schema.optionalKey(Schema.Number),
    maxOutputTokens: Schema.optionalKey(Schema.Number),
    topP: Schema.optionalKey(Schema.Number)
  }))
})

const decodeInitializeChannelRequest = Schema.decodeUnknownOption(InitializeChannelRequest)
const decodeSendMessageRequest = Schema.decodeUnknownOption(SendMessageRequest)

const badRequest = (message: string) =>
  HttpServerResponse.json(
    {
      error: "BadRequest",
      message
    },
    { status: 400 }
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const mapChannelNotFoundFailure = (
  error: unknown
): { readonly errorCode: TurnFailureCode; readonly message: string } | null => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
  ) {
    const errorCode = error._tag
    if (errorCode === "ChannelNotFound" && "channelId" in error) {
      const channelId = typeof error.channelId === "string" ? error.channelId : "unknown"
      return {
        errorCode: "turn_processing_error",
        message: `Channel not found: ${channelId}`
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listChannels = HttpRouter.add(
  "GET",
  "/channels",
  (request) =>
    Effect.gen(function*() {
      const channelCore = yield* ChannelCore
      const url = new URL(request.url, "http://localhost")
      const agentId = url.searchParams.get("agentId") ?? undefined
      const items = yield* channelCore.listChannels(agentId as any)
      return yield* HttpServerResponse.json({
        items,
        totalCount: items.length
      })
    }).pipe(
      Effect.withSpan("ChannelRoutes.listChannels"),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

const initializeChannel = HttpRouter.add(
  "POST",
  "/channels/:channelId/initialize",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* CLIAdapterEntity.client
      const channelId = extractParam(request.url, 1)
      const rawBody = yield* request.json
      if (!isRecord(rawBody)) {
        return yield* badRequest("Expected JSON object payload")
      }

      const normalizedBody = {
        channelType: rawBody.channelType ?? "CLI",
        agentId: rawBody.agentId ?? "agent:bootstrap"
      }
      const decodedBody = decodeInitializeChannelRequest(normalizedBody)
      if (Option.isNone(decodedBody)) {
        return yield* badRequest("Invalid initialize channel payload")
      }

      const client = makeClient(channelId)

      yield* client.initialize({
        channelType: decodedBody.value.channelType ?? "CLI",
        agentId: decodedBody.value.agentId ?? "agent:bootstrap",
        userId: "user:cli:local"
      })

      return yield* HttpServerResponse.json({ ok: true })
    }).pipe(
      Effect.withSpan("ChannelRoutes.initializeChannel"),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

const sendMessage = HttpRouter.add(
  "POST",
  "/channels/:channelId/messages",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* CLIAdapterEntity.client
      const channelId = extractParam(request.url, 1)
      const rawBody = yield* request.json
      const decodedBody = decodeSendMessageRequest(rawBody)
      if (Option.isNone(decodedBody)) {
        return yield* badRequest("Invalid send message payload")
      }

      const client = makeClient(channelId)

      const stream = toSseTextStream(
        withFailedTurnEvent(
          client.receiveMessage({
            content: decodedBody.value.content,
            userId: "user:cli:local",
            ...decodedBody.value.model ? { modelOverride: decodedBody.value.model } : {},
            ...decodedBody.value.generationConfig ? { generationConfigOverride: decodedBody.value.generationConfig } : {}
          }),
          {
            fallbackMessage: "Turn processing failed unexpectedly",
            mapKnownError: mapChannelNotFoundFailure
          }
        )
      )

      return HttpServerResponse.stream(stream, {
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive"
        }
      })
    }).pipe(
      Effect.withSpan("ChannelRoutes.sendMessage")
    )
)

const getHistory = HttpRouter.add(
  "GET",
  "/channels/:channelId/history",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* CLIAdapterEntity.client
      const channelId = extractParam(request.url, 1)
      const client = makeClient(channelId)

      const turns = yield* client.getHistory({})

      return yield* HttpServerResponse.json(turns)
    }).pipe(
      Effect.withSpan("ChannelRoutes.getHistory"),
      Effect.catchTag("ChannelNotFound", (error) =>
        HttpServerResponse.json(
          { error: "ChannelNotFound", channelId: error.channelId },
          { status: 404 }
        )),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

const getStatus = HttpRouter.add(
  "GET",
  "/channels/:channelId/status",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* CLIAdapterEntity.client
      const channelId = extractParam(request.url, 1)
      const client = makeClient(channelId)

      const status = yield* client.getStatus({})

      return yield* HttpServerResponse.json(status)
    }).pipe(
      Effect.withSpan("ChannelRoutes.getStatus"),
      Effect.catchTag("ChannelNotFound", (error) =>
        HttpServerResponse.json(
          { error: "ChannelNotFound", channelId: error.channelId },
          { status: 404 }
        )),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

const deleteChannel = HttpRouter.add(
  "DELETE",
  "/channels/:channelId",
  (request) =>
    Effect.gen(function*() {
      const channelCore = yield* ChannelCore
      const channelId = extractParam(request.url, 1)
      if (channelId.length === 0) {
        return yield* badRequest("Missing channelId")
      }
      yield* channelCore.deleteChannel(channelId as ChannelId)
      return yield* HttpServerResponse.json({ ok: true })
    }).pipe(
      Effect.withSpan("ChannelRoutes.deleteChannel"),
      Effect.catchTag("ChannelNotFound", (error) =>
        HttpServerResponse.json(
          { error: "ChannelNotFound", channelId: error.channelId },
          { status: 404 }
        )),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

const SetModelPreferenceRequest = Schema.Struct({
  model: Schema.optionalKey(Schema.Union([
    Schema.Struct({ provider: AiProviderName, modelId: Schema.String }),
    Schema.Null
  ])),
  generationConfig: Schema.optionalKey(Schema.Union([
    Schema.Struct({
      temperature: Schema.optionalKey(Schema.Number),
      maxOutputTokens: Schema.optionalKey(Schema.Number),
      topP: Schema.optionalKey(Schema.Number)
    }),
    Schema.Null
  ]))
})
const decodeSetModelPreferenceRequest = Schema.decodeUnknownOption(SetModelPreferenceRequest)

const setModelPreference = HttpRouter.add(
  "PATCH",
  "/channels/:channelId/model",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* CLIAdapterEntity.client
      const channelId = extractParam(request.url, 1)
      const rawBody = yield* request.json
      const decodedBody = decodeSetModelPreferenceRequest(rawBody)
      if (Option.isNone(decodedBody)) {
        return yield* badRequest("Invalid model preference payload")
      }

      const client = makeClient(channelId)
      yield* client.setModelPreference({
        ...(decodedBody.value.model !== undefined ? { modelOverride: decodedBody.value.model } : {}),
        ...(decodedBody.value.generationConfig !== undefined ? { generationConfigOverride: decodedBody.value.generationConfig } : {})
      })
      return yield* HttpServerResponse.json({ ok: true })
    }).pipe(
      Effect.withSpan("ChannelRoutes.setModelPreference"),
      Effect.catchTag("ChannelNotFound", (error) =>
        HttpServerResponse.json(
          { error: "ChannelNotFound", channelId: error.channelId },
          { status: 404 }
        )),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

const health = HttpRouter.add(
  "GET",
  "/health",
  () => HttpServerResponse.json({ status: "ok", service: "personal-agent" })
)

// ---------------------------------------------------------------------------
// Combined layers
// ---------------------------------------------------------------------------

export const healthLayer = health // always-on, never gated
export const layer = Layer.mergeAll(
  listChannels,
  initializeChannel,
  sendMessage,
  getHistory,
  getStatus,
  deleteChannel,
  setModelPreference
) // gatable
