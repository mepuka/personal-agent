import { TurnStreamEvent } from "@template/domain/events"
import { Effect, Layer, ServiceMap, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

const BASE_URL = "http://localhost:3000"

export class ChatClient extends ServiceMap.Service<ChatClient>()("cli/ChatClient", {
  make: Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient

    const createChannel = (channelId: string, agentId: string) =>
      HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${BASE_URL}/channels/${channelId}/create`),
        { channelType: "CLI", agentId }
      ).pipe(
        (request) => httpClient.execute(request),
        Effect.asVoid,
        Effect.scoped
      )

    const sendMessage = (channelId: string, content: string) =>
      HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${BASE_URL}/channels/${channelId}/messages`),
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

    const health = httpClient.execute(
      HttpClientRequest.get(`${BASE_URL}/health`)
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.tap((body) => Effect.logInfo(JSON.stringify(body))),
      Effect.scoped
    )

    return { createChannel, sendMessage, health } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
