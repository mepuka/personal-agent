import { TurnStreamEvent } from "@template/domain/events"
import { Config, Effect, Layer, ServiceMap, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

export type DecideCheckpointResult =
  | { readonly kind: "ack" }
  | { readonly kind: "stream"; readonly stream: Stream.Stream<TurnStreamEvent, unknown> }

export interface ChannelSummary {
  readonly channelId: string
  readonly channelType: string
  readonly agentId: string
  readonly activeSessionId: string
  readonly activeConversationId: string
  readonly createdAt: string
  readonly lastTurnAt: string | null
  readonly messageCount: number
}

export class ChatClient extends ServiceMap.Service<ChatClient>()("client/ChatClient", {
  make: Effect.gen(function*() {
    const baseUrl = yield* Config.string("PA_SERVER_URL").pipe(
      Config.withDefault(() => "http://localhost:3000")
    )

    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk
    )

    const initialize = (channelId: string, agentId: string) =>
      HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${baseUrl}/channels/${channelId}/initialize`),
        { channelType: "CLI", agentId }
      ).pipe(
        (request) => httpClient.execute(request),
        Effect.asVoid,
        Effect.scoped
      )

    const sendMessage = (channelId: string, content: string) =>
      HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${baseUrl}/channels/${channelId}/messages`),
        { content }
      ).pipe(
        (request) => httpClient.execute(request),
        Effect.map((response) =>
          response.stream.pipe(
            Stream.decodeText(),
            Stream.pipeThroughChannel(Sse.decodeDataSchema(TurnStreamEvent)),
            Stream.map((event) => event.data)
          )
        )
      )

    const getHistory = (channelId: string) =>
      httpClient.execute(
        HttpClientRequest.get(`${baseUrl}/channels/${channelId}/history`)
      ).pipe(
        Effect.flatMap((response) => response.json),
        Effect.scoped
      )

    const listChannels = (agentId?: string) => {
      const query = agentId !== undefined ? `?agentId=${encodeURIComponent(agentId)}` : ""
      return httpClient.execute(
        HttpClientRequest.get(`${baseUrl}/channels${query}`)
      ).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((body: any) => Array.isArray(body?.items) ? body.items as ReadonlyArray<ChannelSummary> : []),
        Effect.scoped
      )
    }

    const decideCheckpoint = (
      checkpointId: string,
      decision: "Approved" | "Rejected" | "Deferred"
    ) =>
      HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${baseUrl}/checkpoints/${checkpointId}/decide`),
        { decision, decidedBy: "user:cli:local" }
      ).pipe(
        (request) => httpClient.execute(request),
        Effect.map((response) => {
          const contentType = response.headers["content-type"] ?? ""
          if (contentType.includes("text/event-stream")) {
            const stream = response.stream.pipe(
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decodeDataSchema(TurnStreamEvent)),
              Stream.map((event) => event.data)
            )
            return { kind: "stream" as const, stream }
          }
          return { kind: "ack" as const }
        })
      )

    const health = httpClient.execute(
      HttpClientRequest.get(`${baseUrl}/health`)
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.tap((body) => Effect.logInfo(JSON.stringify(body))),
      Effect.scoped
    )

    return { initialize, sendMessage, decideCheckpoint, getHistory, listChannels, health } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
