import type { TurnFailedEvent, TurnStreamEvent } from "@template/domain/events"
import { ChannelType } from "@template/domain/status"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { ChannelEntity } from "../entities/ChannelEntity.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const extractParam = (inputUrl: string, index: number): string => {
  const url = new URL(inputUrl, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean)
  return parts[index] ?? ""
}

const toSseEvent = (event: TurnStreamEvent): Sse.Event => ({
  _tag: "Event",
  event: event.type,
  id: String(event.sequence),
  data: JSON.stringify(event)
})

const CreateChannelRequest = Schema.Struct({
  channelType: Schema.Union([ChannelType, Schema.Undefined]),
  agentId: Schema.Union([Schema.String, Schema.Undefined])
})

const SendMessageRequest = Schema.Struct({
  content: Schema.String
})

const decodeCreateChannelRequest = Schema.decodeUnknownOption(CreateChannelRequest)
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

const getStringField = (value: unknown, key: string): string => {
  if (!isRecord(value)) {
    return ""
  }

  const field = value[key]
  return typeof field === "string" ? field : ""
}

const toFailedTurnEvent = (error: unknown): TurnFailedEvent => {
  const turnId = getStringField(error, "turnId")
  const sessionId = getStringField(error, "sessionId")

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
        type: "turn.failed",
        sequence: Number.MAX_SAFE_INTEGER,
        turnId,
        sessionId,
        errorCode,
        message: `Channel not found: ${channelId}`
      }
    }

    const message = "reason" in error && typeof error.reason === "string"
      ? error.reason
      : errorCode

    return {
      type: "turn.failed",
      sequence: Number.MAX_SAFE_INTEGER,
      turnId,
      sessionId,
      errorCode,
      message
    }
  }

  return {
    type: "turn.failed",
    sequence: Number.MAX_SAFE_INTEGER,
    turnId,
    sessionId,
    errorCode: "TurnProcessingError",
    message: error instanceof Error ? error.message : String(error)
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const createChannel = HttpRouter.add(
  "POST",
  "/channels/:channelId/create",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* ChannelEntity.client
      const channelId = extractParam(request.url, 1)
      const rawBody = yield* request.json
      if (!isRecord(rawBody)) {
        return yield* badRequest("Expected JSON object payload")
      }

      const normalizedBody = {
        channelType: rawBody.channelType ?? "CLI",
        agentId: rawBody.agentId ?? "agent:bootstrap"
      }
      const decodedBody = decodeCreateChannelRequest(normalizedBody)
      if (Option.isNone(decodedBody)) {
        return yield* badRequest("Invalid create channel payload")
      }

      const client = makeClient(channelId)

      yield* client.createChannel({
        channelType: decodedBody.value.channelType ?? "CLI",
        agentId: decodedBody.value.agentId ?? "agent:bootstrap"
      })

      return yield* HttpServerResponse.json({ ok: true })
    }).pipe(
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
      const makeClient = yield* ChannelEntity.client
      const channelId = extractParam(request.url, 1)
      const rawBody = yield* request.json
      const decodedBody = decodeSendMessageRequest(rawBody)
      if (Option.isNone(decodedBody)) {
        return yield* badRequest("Invalid send message payload")
      }

      const client = makeClient(channelId)

      const stream = client.sendMessage({
        content: decodedBody.value.content
      }).pipe(
        Stream.catch((error) => Stream.make(toFailedTurnEvent(error))),
        Stream.map(toSseEvent),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText
      )

      return HttpServerResponse.stream(stream, {
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive"
        }
      })
    })
)

const getHistory = HttpRouter.add(
  "POST",
  "/channels/:channelId/history",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* ChannelEntity.client
      const channelId = extractParam(request.url, 1)
      const client = makeClient(channelId)

      const turns = yield* client.getHistory({})

      return yield* HttpServerResponse.json(turns)
    }).pipe(
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
// Combined layer
// ---------------------------------------------------------------------------

export const layer = Layer.mergeAll(createChannel, sendMessage, getHistory, health)
