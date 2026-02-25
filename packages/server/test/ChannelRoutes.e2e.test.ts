import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { TurnStreamEvent } from "@template/domain/events"
import type { ChannelId } from "@template/domain/ids"
import type { AgentStatePort, ChannelPort, SessionTurnPort } from "@template/domain/ports"
import { Effect, Layer, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { ChannelPortSqlite } from "../src/ChannelPortSqlite.js"
import { layer as ChannelEntityLayer } from "../src/entities/ChannelEntity.js"
import { layer as SessionEntityLayer } from "../src/entities/SessionEntity.js"
import { layer as ChannelRoutesLayer } from "../src/gateway/ChannelRoutes.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { AgentStatePortTag, ChannelPortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { SessionTurnPortSqlite } from "../src/SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "../src/turn/TurnProcessingRuntime.js"
import type { ProcessTurnPayload } from "../src/turn/TurnProcessingWorkflow.js"

// ---------------------------------------------------------------------------
// Mock TurnProcessingRuntime — same as ChannelEntity.test.ts
// ---------------------------------------------------------------------------

const makeMockTurnProcessingRuntime = () =>
  Layer.succeed(TurnProcessingRuntime, {
    processTurn: (_input: ProcessTurnPayload) =>
      Effect.succeed({
        turnId: _input.turnId,
        accepted: true,
        auditReasonCode: "turn_processing_accepted" as const,
        assistantContent: "mock response",
        assistantContentBlocks: [{ contentBlockType: "TextBlock" as const, text: "mock response" }],
        modelFinishReason: "stop",
        modelUsageJson: "{}"
      }),
    processTurnStream: (input: ProcessTurnPayload): Stream.Stream<TurnStreamEvent> =>
      Stream.make(
        {
          type: "turn.started" as const,
          sequence: 1,
          turnId: input.turnId,
          sessionId: input.sessionId,
          createdAt: input.createdAt
        },
        {
          type: "assistant.delta" as const,
          sequence: 2,
          turnId: input.turnId,
          sessionId: input.sessionId,
          delta: "mock response"
        },
        {
          type: "turn.completed" as const,
          sequence: 3,
          turnId: input.turnId,
          sessionId: input.sessionId,
          accepted: true,
          auditReasonCode: "turn_processing_accepted",
          modelFinishReason: "stop",
          modelUsageJson: "{}"
        }
      )
  } as any)

// ---------------------------------------------------------------------------
// App layer (everything except HTTP server) — used with Layer.build pattern
// ---------------------------------------------------------------------------

const makeAppLayer = (dbPath: string) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(Layer.provide(sqliteLayer), Layer.orDie)
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

  const agentStateSqliteLayer = AgentStatePortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const agentStateTagLayer = Layer.effect(
    AgentStatePortTag,
    Effect.gen(function*() {
      return (yield* AgentStatePortSqlite) as AgentStatePort
    })
  ).pipe(Layer.provide(agentStateSqliteLayer))

  const sessionTurnSqliteLayer = SessionTurnPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const sessionTurnTagLayer = Layer.effect(
    SessionTurnPortTag,
    Effect.gen(function*() {
      return (yield* SessionTurnPortSqlite) as SessionTurnPort
    })
  ).pipe(Layer.provide(sessionTurnSqliteLayer))

  const channelPortSqliteLayer = ChannelPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const channelPortTagLayer = Layer.effect(
    ChannelPortTag,
    Effect.gen(function*() {
      return (yield* ChannelPortSqlite) as ChannelPort
    })
  ).pipe(Layer.provide(channelPortSqliteLayer))

  const clusterLayer = SingleRunner.layer().pipe(
    Layer.provide(sqlInfrastructureLayer),
    Layer.orDie
  )

  const mockTurnProcessingRuntimeLayer = makeMockTurnProcessingRuntime()
  const sessionEntityLayer = SessionEntityLayer.pipe(
    Layer.provide(clusterLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(mockTurnProcessingRuntimeLayer)
  )

  const channelEntityLayer = ChannelEntityLayer.pipe(
    Layer.provide(clusterLayer),
    Layer.provide(agentStateTagLayer),
    Layer.provide(channelPortTagLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(mockTurnProcessingRuntimeLayer),
    Layer.provide(sessionEntityLayer)
  )

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    agentStateSqliteLayer,
    agentStateTagLayer,
    sessionTurnSqliteLayer,
    sessionTurnTagLayer,
    channelPortSqliteLayer,
    channelPortTagLayer,
    mockTurnProcessingRuntimeLayer,
    sessionEntityLayer,
    channelEntityLayer
  ).pipe(
    Layer.provideMerge(clusterLayer)
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })

// ---------------------------------------------------------------------------
// Tests — using Layer.build pattern for streaming support
// ---------------------------------------------------------------------------

describe("ChannelRoutes e2e", () => {
  it.effect("GET /health returns ok", () => {
    const dbPath = testDatabasePath("e2e-health")
    return Effect.gen(function*() {
      yield* HttpRouter.serve(ChannelRoutesLayer, { disableLogger: true }).pipe(
        Layer.provide(makeAppLayer(dbPath)),
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get("/health")
      const body = yield* response.json
      expect(body).toEqual({ status: "ok", service: "personal-agent" })
    }).pipe(
      Effect.provide(NodeHttpServer.layerTest),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("SSE pipeline streams correctly over HTTP", () =>
    Effect.gen(function*() {
      // Tests the full SSE encoding pipeline: events → Sse.encode → encodeText → HTTP stream
      // Uses HttpRouter.route (not add) for proper streaming scope transfer
      const mockEvents: Array<TurnStreamEvent> = [
        { type: "turn.started", sequence: 1, turnId: "turn:test", sessionId: "session:test", createdAt: new Date().toISOString() as any },
        { type: "assistant.delta", sequence: 2, turnId: "turn:test", sessionId: "session:test", delta: "hello" },
        { type: "turn.completed", sequence: 3, turnId: "turn:test", sessionId: "session:test", accepted: true, auditReasonCode: "turn_processing_accepted", modelFinishReason: "stop", modelUsageJson: "{}" }
      ]

      const toSseEvent = (event: TurnStreamEvent): Sse.Event => ({
        _tag: "Event",
        event: event.type,
        id: String(event.sequence),
        data: JSON.stringify(event)
      })

      yield* HttpRouter.addAll([
        HttpRouter.route(
          "POST",
          "/test-sse",
          (_request) =>
            Effect.gen(function*() {
              const stream = Stream.fromIterable(mockEvents).pipe(
                Stream.map(toSseEvent),
                Stream.pipeThroughChannel(Sse.encode()),
                Stream.encodeText
              )
              return HttpServerResponse.stream(stream, {
                contentType: "text/event-stream",
                headers: { "cache-control": "no-cache", connection: "keep-alive" }
              })
            })
        )
      ]).pipe(
        HttpRouter.serve,
        Layer.build
      )

      const client = yield* HttpClient.HttpClient
      const body = yield* HttpClientRequest.post("/test-sse").pipe(
        (req) => client.execute(req),
        Effect.flatMap((r) => r.text)
      )

      expect(body.length).toBeGreaterThan(0)
      expect(body).toContain("turn.started")
      expect(body).toContain("assistant.delta")
      expect(body).toContain("turn.completed")
      expect(body).toContain("hello")
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  )

  // TODO: SingleRunner streaming RPCs hang — entity client streaming through
  // SingleRunner never terminates. Non-streaming entity RPCs (createChannel,
  // getHistory) work fine through SingleRunner. This needs investigation in
  // the Effect cluster layer. See: ChannelEntity.test.ts for entity streaming
  // tests using Entity.makeTestClient (which works).
  it.skip("create channel + send message returns SSE stream (blocked: SingleRunner streaming)", () => {
    const dbPath = testDatabasePath("e2e-send")
    return Effect.gen(function*() {
      yield* HttpRouter.serve(ChannelRoutesLayer, { disableLogger: true }).pipe(
        Layer.provide(makeAppLayer(dbPath)),
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const channelId = `channel:${crypto.randomUUID()}` as ChannelId

      const createReq = yield* HttpClientRequest.post(`/channels/${channelId}/create`).pipe(
        HttpClientRequest.bodyJson({ channelType: "CLI", agentId: "agent:bootstrap" })
      )
      const createStatus = yield* client.execute(createReq).pipe(
        Effect.map((r) => r.status),
        Effect.scoped
      )
      expect(createStatus).toBe(200)

      const sendReq = yield* HttpClientRequest.post(`/channels/${channelId}/messages`).pipe(
        HttpClientRequest.bodyJson({ content: "hello" })
      )
      const body = yield* client.execute(sendReq).pipe(
        Effect.flatMap((r) => r.text)
      )

      expect(body.length).toBeGreaterThan(0)
      expect(body).toContain("turn.started")
    }).pipe(
      Effect.provide(NodeHttpServer.layerTest),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("create channel via entity route returns 200", () => {
    const dbPath = testDatabasePath("e2e-create")
    return Effect.gen(function*() {
      yield* HttpRouter.serve(ChannelRoutesLayer, { disableLogger: true }).pipe(
        Layer.provide(makeAppLayer(dbPath)),
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const channelId = `channel:${crypto.randomUUID()}` as ChannelId

      const createReq = yield* HttpClientRequest.post(`/channels/${channelId}/create`).pipe(
        HttpClientRequest.bodyJson({ channelType: "CLI", agentId: "agent:bootstrap" })
      )
      const response = yield* client.execute(createReq)
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toEqual({ ok: true })
    }).pipe(
      Effect.provide(NodeHttpServer.layerTest),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("get history endpoint returns array for created channel", () => {
    const dbPath = testDatabasePath("e2e-history")
    return Effect.gen(function*() {
      yield* HttpRouter.serve(ChannelRoutesLayer, { disableLogger: true }).pipe(
        Layer.provide(makeAppLayer(dbPath)),
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const channelId = `channel:${crypto.randomUUID()}` as ChannelId

      const createReq = yield* HttpClientRequest.post(`/channels/${channelId}/create`).pipe(
        HttpClientRequest.bodyJson({ channelType: "CLI", agentId: "agent:bootstrap" })
      )
      yield* client.execute(createReq).pipe(Effect.scoped)

      const historyReq = yield* HttpClientRequest.post(`/channels/${channelId}/history`).pipe(
        HttpClientRequest.bodyJson({})
      )
      const historyResponse = yield* client.execute(historyReq)
      expect(historyResponse.status).toBe(200)
      const turns = (yield* historyResponse.json) as Array<unknown>

      expect(Array.isArray(turns)).toBe(true)
    }).pipe(
      Effect.provide(NodeHttpServer.layerTest),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})
