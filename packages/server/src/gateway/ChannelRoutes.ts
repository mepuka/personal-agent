import type { TurnFailedEvent, TurnStreamEvent } from "@template/domain/events"
import type { ChannelType } from "@template/domain/status"
import { Effect, Stream } from "effect"
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

const toFailedTurnEvent = (error: unknown): TurnFailedEvent => {
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
        turnId: "",
        sessionId: "",
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
      turnId: "",
      sessionId: "",
      errorCode,
      message
    }
  }

  return {
    type: "turn.failed",
    sequence: Number.MAX_SAFE_INTEGER,
    turnId: "",
    sessionId: "",
    errorCode: "TurnProcessingError",
    message: error instanceof Error ? error.message : String(error)
  }
}

// ---------------------------------------------------------------------------
// Routes — use HttpRouter.route (not HttpRouter.add) for proper streaming
// scope transfer. HttpRouter.add creates a Layer whose handler scope closes
// before a streaming response body finishes writing.
// ---------------------------------------------------------------------------

const createChannel = HttpRouter.route(
  "POST",
  "/channels/:channelId/create",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* ChannelEntity.client
      const channelId = extractParam(request.url, 1)
      const body = yield* request.json
      const client = makeClient(channelId)

      const typed = body as Record<string, unknown>
      yield* client.createChannel({
        channelType: (typed.channelType as ChannelType | undefined) ?? "CLI",
        agentId: (typed.agentId as string | undefined) ?? "agent:bootstrap"
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

const sendMessage = HttpRouter.route(
  "POST",
  "/channels/:channelId/messages",
  (request) =>
    Effect.gen(function*() {
      const makeClient = yield* ChannelEntity.client
      const channelId = extractParam(request.url, 1)
      const body = yield* request.json
      const client = makeClient(channelId)

      const stream = client.sendMessage({
        content: (body as Record<string, unknown>).content as string
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

const getHistory = HttpRouter.route(
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

const health = HttpRouter.route(
  "GET",
  "/health",
  HttpServerResponse.json({ status: "ok", service: "personal-agent" })
)

// ---------------------------------------------------------------------------
// Combined layer
// ---------------------------------------------------------------------------

export const layer = HttpRouter.addAll([createChannel, sendMessage, getHistory, health])
