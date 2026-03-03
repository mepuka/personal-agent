import type { CheckpointId } from "@template/domain/ids"
import { CheckpointDecision } from "@template/domain/status"
import { Effect, Layer, Schema } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { ChannelCore } from "../ChannelCore.js"
import { toSseTextStream, withFailedTurnEvent } from "./TurnStreamTransport.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const extractParam = (inputUrl: string, index: number): string => {
  const url = new URL(inputUrl, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean)
  return parts[index] ?? ""
}

const badRequest = (message: string) =>
  HttpServerResponse.json(
    {
      error: "BadRequest",
      message
    },
    { status: 400 }
  )

const DecideCheckpointRequest = Schema.Struct({
  decision: CheckpointDecision,
  decidedBy: Schema.String
})
const decodeDecideCheckpointRequest = Schema.decodeUnknownOption(DecideCheckpointRequest)
const decodeJsonBody = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listPending = HttpRouter.add(
  "GET",
  "/checkpoints/pending",
  (request) =>
    Effect.gen(function*() {
      const channelCore = yield* ChannelCore
      const url = new URL(request.url, "http://localhost")
      const agentId = url.searchParams.get("agentId") || undefined
      const checkpoints = yield* channelCore.listPendingCheckpoints(agentId as any)
      return yield* HttpServerResponse.json({ items: checkpoints, totalCount: checkpoints.length })
    }).pipe(
      Effect.withSpan("CheckpointRoutes.listPending"),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

const getCheckpoint = HttpRouter.add(
  "GET",
  "/checkpoints/:checkpointId",
  (request) =>
    Effect.gen(function*() {
      const channelCore = yield* ChannelCore
      const checkpointId = extractParam(request.url, 1) as CheckpointId
      if (checkpointId.length === 0) {
        return yield* badRequest("Missing checkpointId")
      }
      const checkpoint = yield* channelCore.getCheckpoint(checkpointId)
      if (checkpoint === null) {
        return yield* HttpServerResponse.json(
          { error: "CheckpointNotFound", checkpointId },
          { status: 404 }
        )
      }
      return yield* HttpServerResponse.json(checkpoint)
    }).pipe(
      Effect.withSpan("CheckpointRoutes.getCheckpoint"),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

const decideCheckpoint = HttpRouter.add(
  "POST",
  "/checkpoints/:checkpointId/decide",
  (request) =>
    Effect.gen(function*() {
      const channelCore = yield* ChannelCore
      const checkpointId = extractParam(request.url, 1) as CheckpointId
      if (checkpointId.length === 0) {
        return yield* badRequest("Missing checkpointId")
      }

      const rawBodyText = yield* request.text.pipe(
        Effect.catchCause(() => Effect.succeed("__READ_FAILED__"))
      )
      if (rawBodyText === "__READ_FAILED__" || rawBodyText.length === 0) {
        return yield* badRequest("Invalid JSON payload")
      }

      const rawBody = decodeJsonBody(rawBodyText)
      if (rawBody._tag === "None") {
        return yield* badRequest("Invalid JSON payload")
      }

      const decoded = decodeDecideCheckpointRequest(rawBody.value)
      if (decoded._tag === "None") {
        return yield* badRequest(
          "Invalid payload: decision must be Approved|Rejected|Deferred, decidedBy required"
        )
      }

      const decidedBy = decoded.value.decidedBy.trim()
      if (decidedBy.length === 0) {
        return yield* badRequest("Invalid payload: decidedBy must be a non-empty string")
      }

      const result = yield* channelCore.decideCheckpoint({
        checkpointId,
        decision: decoded.value.decision,
        decidedBy
      })

      if (result.kind === "ack") {
        return yield* HttpServerResponse.json({ ok: true })
      }

      // Approved with replay stream — return SSE
      const sseStream = toSseTextStream(
        withFailedTurnEvent(result.stream, {
          fallbackMessage: "Replay stream failed unexpectedly"
        })
      )

      return HttpServerResponse.stream(sseStream, {
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive"
        }
      })
    }).pipe(
      Effect.withSpan("CheckpointRoutes.decideCheckpoint"),
      Effect.catchTag("CheckpointNotFound", (error) =>
        HttpServerResponse.json(
          { error: "CheckpointNotFound", checkpointId: error.checkpointId },
          { status: 404 }
        )
      ),
      Effect.catchTag("CheckpointAlreadyDecided", (error) =>
        HttpServerResponse.json(
          { error: "CheckpointAlreadyDecided", checkpointId: error.checkpointId, currentStatus: error.currentStatus },
          { status: 409 }
        )
      ),
      Effect.catchTag("CheckpointExpired", (error) =>
        HttpServerResponse.json(
          { error: "CheckpointExpired", checkpointId: error.checkpointId },
          { status: 410 }
        )
      ),
      Effect.catchCause(() =>
        HttpServerResponse.json(
          { error: "InternalServerError" },
          { status: 500 }
        )
      )
    )
)

// ---------------------------------------------------------------------------
// Combined layer
// ---------------------------------------------------------------------------

export const layer = Layer.mergeAll(listPending, getCheckpoint, decideCheckpoint)
