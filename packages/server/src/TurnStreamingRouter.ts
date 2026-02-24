import { SubmitTurnRequest, type TurnFailedEvent, type TurnStreamEvent } from "@template/domain/RuntimeApi"
import { Effect, Schema, Stream } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { SessionEntity } from "./entities/SessionEntity.js"

export const layer = HttpRouter.add(
  "POST",
  "/sessions/:sessionId/turns",
  (request) =>
    Effect.gen(function*() {
      const makeSessionClient = yield* SessionEntity.client
      const body = yield* request.json
      const decoded = yield* Schema.decodeUnknownEffect(SubmitTurnRequest)(body)

      const sessionId = getSessionId(request.url)
      const sessionClient = makeSessionClient(sessionId)

      const payload = {
        ...decoded,
        sessionId
      }

      const stream = sessionClient.processTurn(payload).pipe(
        Stream.map(encodeSseEvent),
        Stream.catch((error) =>
          Stream.make(
            encodeSseEvent(
              {
                type: "turn.failed",
                sequence: Number.MAX_SAFE_INTEGER,
                turnId: payload.turnId,
                sessionId: payload.sessionId,
                errorCode: getErrorCode(error),
                message: getErrorMessage(error)
              } satisfies TurnFailedEvent
            )
          )
        )
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

const encodeSseEvent = (event: TurnStreamEvent): Uint8Array =>
  new TextEncoder().encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )

const getSessionId = (inputUrl: string): string => {
  const url = new URL(inputUrl, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean)
  const id = parts[1]
  return id ?? ""
}

const getErrorCode = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
  ) {
    return error._tag
  }
  return "TurnProcessingError"
}

const getErrorMessage = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "string"
  ) {
    return error.reason
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
