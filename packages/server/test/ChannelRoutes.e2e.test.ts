import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { TurnStreamEvent } from "@template/domain/events"
import type { ChannelId } from "@template/domain/ids"
import type { ChannelPort, SessionTurnPort } from "@template/domain/ports"
import { Effect, Layer, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { HttpRouter } from "effect/unstable/http"
import { SingleRunner } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { layer as ChannelEntityLayer } from "../src/entities/ChannelEntity.js"
import { layer as ChannelRoutesLayer } from "../src/gateway/ChannelRoutes.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { ChannelPortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { ChannelPortSqlite } from "../src/ChannelPortSqlite.js"
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
// Test layer — HTTP round-trip through ChannelRoutes
// ---------------------------------------------------------------------------

const makeTestLayer = (dbPath: string) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(Layer.provide(sqliteLayer), Layer.orDie)
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

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

  const channelEntityLayer = ChannelEntityLayer.pipe(
    Layer.provide(clusterLayer),
    Layer.provide(channelPortTagLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(makeMockTurnProcessingRuntime())
  )

  const portsAndEntityLayer = Layer.mergeAll(
    sqlInfrastructureLayer,
    sessionTurnSqliteLayer,
    sessionTurnTagLayer,
    channelPortSqliteLayer,
    channelPortTagLayer,
    makeMockTurnProcessingRuntime(),
    channelEntityLayer
  ).pipe(
    Layer.provideMerge(clusterLayer)
  )

  const httpServeLayer = HttpRouter.serve(ChannelRoutesLayer, {
    disableLogger: true
  }).pipe(
    Layer.provide(portsAndEntityLayer)
  )

  const httpTestLayer = NodeHttpServer.layerTest

  return httpServeLayer.pipe(
    Layer.provideMerge(httpTestLayer)
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
// Tests
// ---------------------------------------------------------------------------

describe("ChannelRoutes e2e", () => {
  it.effect("GET /health returns ok", () => {
    const dbPath = testDatabasePath("e2e-health")
    return Effect.gen(function*() {
      const response = yield* HttpClient.get("/health")
      const body = yield* response.json
      expect(body).toEqual({ status: "ok", service: "personal-agent" })
    }).pipe(
      Effect.scoped,
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("create channel + send message returns SSE stream", () => {
    const dbPath = testDatabasePath("e2e-send")
    return Effect.gen(function*() {
      const channelId = `channel:${crypto.randomUUID()}` as ChannelId

      // Create channel
      const createRequest = yield* HttpClientRequest.post(`/channels/${channelId}/create`).pipe(
        HttpClientRequest.bodyJson({ channelType: "CLI", agentId: "agent:bootstrap" })
      )
      const createResponse = yield* HttpClient.execute(createRequest)
      expect(createResponse.status).toBe(200)

      // Send message — SSE response
      const sendRequest = yield* HttpClientRequest.post(`/channels/${channelId}/messages`).pipe(
        HttpClientRequest.bodyJson({ content: "hello" })
      )
      const sendResponse = yield* HttpClient.execute(sendRequest)
      expect(sendResponse.status).toBe(200)

      const events = yield* sendResponse.stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("data: ")),
        Stream.map((line) => JSON.parse(line.slice(6)) as TurnStreamEvent),
        Stream.runCollect
      )

      expect(events.length).toBeGreaterThan(0)
      expect(events[0]?.type).toBe("turn.started")
      expect(events.some((e) => e.type === "assistant.delta")).toBe(true)
      expect(events.some((e) => e.type === "turn.completed")).toBe(true)
    }).pipe(
      Effect.scoped,
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("get history endpoint returns array for created channel", () => {
    const dbPath = testDatabasePath("e2e-history")
    return Effect.gen(function*() {
      const channelId = `channel:${crypto.randomUUID()}` as ChannelId

      // Create channel
      const createReq = yield* HttpClientRequest.post(`/channels/${channelId}/create`).pipe(
        HttpClientRequest.bodyJson({ channelType: "CLI", agentId: "agent:bootstrap" })
      )
      yield* HttpClient.execute(createReq).pipe(Effect.scoped)

      // Get history — should return an empty array (mock runtime does not persist turns)
      const historyReq = yield* HttpClientRequest.post(`/channels/${channelId}/history`).pipe(
        HttpClientRequest.bodyJson({})
      )
      const historyResponse = yield* HttpClient.execute(historyReq)
      expect(historyResponse.status).toBe(200)
      const turns = (yield* historyResponse.json) as Array<unknown>

      expect(Array.isArray(turns)).toBe(true)
    }).pipe(
      Effect.scoped,
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})
