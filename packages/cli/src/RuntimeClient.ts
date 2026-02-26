import { TurnStreamEvent } from "@template/domain/events"
import { Config, Effect, Layer, ServiceMap, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

export class ChatClient extends ServiceMap.Service<ChatClient>()("cli/ChatClient", {
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

    const health = httpClient.execute(
      HttpClientRequest.get(`${baseUrl}/health`)
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.tap((body) => Effect.logInfo(JSON.stringify(body))),
      Effect.scoped
    )

    return { initialize, sendMessage, health } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
