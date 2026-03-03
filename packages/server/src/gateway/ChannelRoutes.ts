import type { TurnFailureCode } from "@template/domain/events"
import type { ChannelId } from "@template/domain/ids"
import {
  InitializeChannelRequest,
  SendChannelMessageRequest,
  SetChannelModelPreferenceRequest
} from "@template/domain/ports"
import { Effect, Layer, Option, Schema } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { ChannelCore } from "../ChannelCore.js"
import { CLIAdapterEntity } from "../entities/CLIAdapterEntity.js"
import {
  badRequest,
  extractPathParam,
  internalServerError,
  sseStreamResponse
} from "./RouteCommon.js"
import { toSseTextStream, withFailedTurnEvent } from "./TurnStreamTransport.js"

const decodeInitializeChannelRequest = Schema.decodeUnknownOption(InitializeChannelRequest)
const decodeSendMessageRequest = Schema.decodeUnknownOption(SendChannelMessageRequest)

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
      const channelId = extractPathParam(request.url, 1)
      const rawBody = yield* request.json
      if (!isRecord(rawBody)) {
        return yield* badRequest("Expected JSON object payload")
      }

      const normalizedBody = {
        channelType: rawBody.channelType ?? "CLI",
        agentId: rawBody.agentId ?? "agent:bootstrap",
        ...("attachTo" in rawBody ? { attachTo: rawBody.attachTo } : {})
      }
      const decodedBody = decodeInitializeChannelRequest(normalizedBody)
      if (Option.isNone(decodedBody)) {
        return yield* badRequest("Invalid initialize channel payload")
      }

      const client = makeClient(channelId)

      yield* client.initialize({
        channelType: decodedBody.value.channelType,
        agentId: decodedBody.value.agentId,
        userId: "user:cli:local",
        ...(decodedBody.value.attachTo !== undefined
          ? { attachTo: decodedBody.value.attachTo }
          : {})
      })

      return yield* HttpServerResponse.json({ ok: true })
    }).pipe(
      Effect.withSpan("ChannelRoutes.initializeChannel"),
      Effect.catchTag("SessionNotFound", (error) =>
        HttpServerResponse.json(
          { error: "SessionNotFound", sessionId: error.sessionId },
          { status: 404 }
        )),
      Effect.catchTag("ChannelTypeMismatch", (error) =>
        HttpServerResponse.json(
          {
            error: "ChannelTypeMismatch",
            channelId: error.channelId,
            existingType: error.existingType,
            requestedType: error.requestedType
          },
          { status: 409 }
        )),
      Effect.catchCause(() => internalServerError())
    )
)

const sendMessage = HttpRouter.add(
  "POST",
  "/channels/:channelId/messages",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* CLIAdapterEntity.client
      const channelId = extractPathParam(request.url, 1)
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

      return sseStreamResponse(stream)
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
      const channelId = extractPathParam(request.url, 1)
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
      Effect.catchCause(() => internalServerError())
    )
)

const getStatus = HttpRouter.add(
  "GET",
  "/channels/:channelId/status",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* CLIAdapterEntity.client
      const channelId = extractPathParam(request.url, 1)
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
      Effect.catchCause(() => internalServerError())
    )
)

const deleteChannel = HttpRouter.add(
  "DELETE",
  "/channels/:channelId",
  (request) =>
    Effect.gen(function*() {
      const channelCore = yield* ChannelCore
      const channelId = extractPathParam(request.url, 1)
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
      Effect.catchCause(() => internalServerError())
    )
)

const decodeSetModelPreferenceRequest = Schema.decodeUnknownOption(SetChannelModelPreferenceRequest)

const setModelPreference = HttpRouter.add(
  "PATCH",
  "/channels/:channelId/model",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* CLIAdapterEntity.client
      const channelId = extractPathParam(request.url, 1)
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
      Effect.catchCause(() => internalServerError())
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
