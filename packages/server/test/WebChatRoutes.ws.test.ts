import { describe, expect, it } from "@effect/vitest"
import type { TurnStreamEvent } from "@template/domain/events"
import type { AgentStatePort, ChannelPort, SessionTurnPort } from "@template/domain/ports"
import { Effect, Layer, Stream } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import * as HttpServer from "effect/unstable/http/HttpServer"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { ChannelCore } from "../src/ChannelCore.js"
import { ChannelPortSqlite } from "../src/ChannelPortSqlite.js"
import { layer as SessionEntityLayer } from "../src/entities/SessionEntity.js"
import { layer as WebChatAdapterEntityLayer } from "../src/entities/WebChatAdapterEntity.js"
import { layer as WebChatRoutesLayer } from "../src/gateway/WebChatRoutes.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { AgentStatePortTag, ChannelPortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { SessionTurnPortSqlite } from "../src/SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "../src/turn/TurnProcessingRuntime.js"
import type { ProcessTurnPayload } from "../src/turn/TurnProcessingWorkflow.js"

// ---------------------------------------------------------------------------
// Runtime guard — only run under Bun
// ---------------------------------------------------------------------------

const isBun = typeof (globalThis as any).Bun !== "undefined"
const describeWs = isBun ? describe : describe.skip

// ---------------------------------------------------------------------------
// Mock TurnProcessingRuntime
// ---------------------------------------------------------------------------

const makeMockTurnProcessingRuntime = () =>
  Layer.succeed(TurnProcessingRuntime, {
    processTurn: (_input: ProcessTurnPayload) =>
      Effect.succeed({
        turnId: _input.turnId,
        accepted: true,
        auditReasonCode: "turn_processing_accepted" as const,
        assistantContent: "mock ws response",
        assistantContentBlocks: [{ contentBlockType: "TextBlock" as const, text: "mock ws response" }],
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
          delta: "mock ws response"
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
// WebSocket helpers
// ---------------------------------------------------------------------------

const waitForOpen = (ws: WebSocket, timeoutMs = 5000): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    const timer = setTimeout(() => reject(new Error("WS open timeout")), timeoutMs)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    ws.addEventListener("error", (e) => {
      clearTimeout(timer)
      reject(e)
    }, { once: true })
  })

const readMessage = (ws: WebSocket, timeoutMs = 5000): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS read timeout")), timeoutMs)
    const handler = (event: MessageEvent) => {
      clearTimeout(timer)
      ws.removeEventListener("message", handler)
      resolve(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data))
    }
    ws.addEventListener("message", handler)
  })

// ---------------------------------------------------------------------------
// Test database helpers
// ---------------------------------------------------------------------------

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-ws-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })

// ---------------------------------------------------------------------------
// Test layer — real HTTP server with BunHttpServer (dynamic import)
// ---------------------------------------------------------------------------

const makeWsTestLayer = (dbPath: string) => {
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

  const channelCoreLayer = ChannelCore.layer.pipe(
    Layer.provide(clusterLayer),
    Layer.provide(agentStateTagLayer),
    Layer.provide(channelPortTagLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(mockTurnProcessingRuntimeLayer),
    Layer.provide(sessionEntityLayer)
  )

  const webChatAdapterEntityLayer = WebChatAdapterEntityLayer.pipe(
    Layer.provide(clusterLayer),
    Layer.provide(channelCoreLayer),
    Layer.provide(channelPortTagLayer)
  )

  const appDepsLayer = Layer.mergeAll(
    sqlInfrastructureLayer,
    agentStateSqliteLayer,
    agentStateTagLayer,
    sessionTurnSqliteLayer,
    sessionTurnTagLayer,
    channelPortSqliteLayer,
    channelPortTagLayer,
    mockTurnProcessingRuntimeLayer,
    sessionEntityLayer,
    webChatAdapterEntityLayer
  ).pipe(
    Layer.provideMerge(clusterLayer)
  )

  // Use Layer.unwrap to dynamically import BunHttpServer at layer-build time
  // This avoids the static import that fails in Node.js environments
  const bunHttpServerLayer = Layer.unwrap(
    Effect.promise(async () => {
      const { BunHttpServer } = await import("@effect/platform-bun")
      return BunHttpServer.layer({ port: 0 })
    })
  ) as Layer.Layer<HttpServer.HttpServer>

  const httpLayer = HttpRouter.serve(
    WebChatRoutesLayer.pipe(Layer.provide(appDepsLayer)),
    { disableLogger: true, disableListenLog: true }
  ).pipe(
    Layer.provide(clusterLayer),
    Layer.provideMerge(bunHttpServerLayer)
  )

  return httpLayer
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWs("WebChatRoutes WebSocket", () => {
  it.live("happy path: connect -> init -> message -> streamed events", () => {
    const dbPath = testDatabasePath("ws-happy")
    return Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      if (address._tag !== "TcpAddress") {
        throw new Error("Expected TcpAddress")
      }
      const port = address.port
      const channelId = `channel:${crypto.randomUUID()}`

      const ws = new WebSocket(`ws://localhost:${port}/ws/chat/${channelId}`)
      yield* Effect.promise(() => waitForOpen(ws))

      try {
        // Should receive "connected"
        const connected = yield* Effect.promise(() => readMessage(ws))
        const connectedData = JSON.parse(connected)
        expect(connectedData.type).toBe("connected")

        // Send init
        ws.send(JSON.stringify({ type: "init", agentId: "agent:bootstrap", userId: "user:web:test" }))
        const initialized = yield* Effect.promise(() => readMessage(ws))
        expect(JSON.parse(initialized).type).toBe("initialized")

        // Send message
        ws.send(JSON.stringify({ type: "message", content: "hello" }))

        // Read events until turn.completed
        const events: Array<any> = []
        let done = false
        while (!done) {
          const msg = yield* Effect.promise(() => readMessage(ws))
          const event = JSON.parse(msg)
          events.push(event)
          if (event.type === "turn.completed" || event.type === "turn.failed") done = true
        }

        expect(events.some((e: any) => e.type === "turn.started")).toBe(true)
        expect(events.some((e: any) => e.type === "assistant.delta")).toBe(true)
        expect(events.some((e: any) => e.type === "turn.completed")).toBe(true)
      } finally {
        ws.close()
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(makeWsTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.live("malformed frame: receives INVALID_FRAME error", () => {
    const dbPath = testDatabasePath("ws-malformed")
    return Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      if (address._tag !== "TcpAddress") {
        throw new Error("Expected TcpAddress")
      }
      const port = address.port
      const channelId = `channel:${crypto.randomUUID()}`

      const ws = new WebSocket(`ws://localhost:${port}/ws/chat/${channelId}`)
      yield* Effect.promise(() => waitForOpen(ws))

      try {
        // Read "connected"
        const connected = yield* Effect.promise(() => readMessage(ws))
        expect(JSON.parse(connected).type).toBe("connected")

        // Send garbage
        ws.send("this is not valid json {{{")
        const errorMsg = yield* Effect.promise(() => readMessage(ws))
        const errorData = JSON.parse(errorMsg)
        expect(errorData.type).toBe("error")
        expect(errorData.code).toBe("INVALID_FRAME")
      } finally {
        ws.close()
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(makeWsTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.live("message before init: receives NOT_INITIALIZED error", () => {
    const dbPath = testDatabasePath("ws-no-init")
    return Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      if (address._tag !== "TcpAddress") {
        throw new Error("Expected TcpAddress")
      }
      const port = address.port
      const channelId = `channel:${crypto.randomUUID()}`

      const ws = new WebSocket(`ws://localhost:${port}/ws/chat/${channelId}`)
      yield* Effect.promise(() => waitForOpen(ws))

      try {
        // Read "connected"
        const connected = yield* Effect.promise(() => readMessage(ws))
        expect(JSON.parse(connected).type).toBe("connected")

        // Send message before init
        ws.send(JSON.stringify({ type: "message", content: "premature" }))
        const errorMsg = yield* Effect.promise(() => readMessage(ws))
        const errorData = JSON.parse(errorMsg)
        expect(errorData.type).toBe("error")
        expect(errorData.code).toBe("NOT_INITIALIZED")
      } finally {
        ws.close()
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(makeWsTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.live("double init: receives ALREADY_INITIALIZED error", () => {
    const dbPath = testDatabasePath("ws-double-init")
    return Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      if (address._tag !== "TcpAddress") {
        throw new Error("Expected TcpAddress")
      }
      const port = address.port
      const channelId = `channel:${crypto.randomUUID()}`

      const ws = new WebSocket(`ws://localhost:${port}/ws/chat/${channelId}`)
      yield* Effect.promise(() => waitForOpen(ws))

      try {
        // Read "connected"
        const connected = yield* Effect.promise(() => readMessage(ws))
        expect(JSON.parse(connected).type).toBe("connected")

        // First init
        ws.send(JSON.stringify({ type: "init", agentId: "agent:bootstrap", userId: "user:web:test" }))
        const initialized = yield* Effect.promise(() => readMessage(ws))
        expect(JSON.parse(initialized).type).toBe("initialized")

        // Second init
        ws.send(JSON.stringify({ type: "init", agentId: "agent:bootstrap", userId: "user:web:test" }))
        const errorMsg = yield* Effect.promise(() => readMessage(ws))
        const errorData = JSON.parse(errorMsg)
        expect(errorData.type).toBe("error")
        expect(errorData.code).toBe("ALREADY_INITIALIZED")
      } finally {
        ws.close()
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(makeWsTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.live("disconnect cleanup: no unhandled promise rejections", () => {
    const dbPath = testDatabasePath("ws-disconnect")
    return Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      if (address._tag !== "TcpAddress") {
        throw new Error("Expected TcpAddress")
      }
      const port = address.port
      const channelId = `channel:${crypto.randomUUID()}`

      // Track unhandled rejections
      const rejections: Array<unknown> = []
      const handler = (event: PromiseRejectionEvent) => {
        rejections.push(event.reason)
      }
      globalThis.addEventListener("unhandledrejection", handler)

      try {
        const ws = new WebSocket(`ws://localhost:${port}/ws/chat/${channelId}`)
        yield* Effect.promise(() => waitForOpen(ws))

        // Read "connected"
        const connected = yield* Effect.promise(() => readMessage(ws))
        expect(JSON.parse(connected).type).toBe("connected")

        // Init the channel
        ws.send(JSON.stringify({ type: "init", agentId: "agent:bootstrap", userId: "user:web:test" }))
        const initialized = yield* Effect.promise(() => readMessage(ws))
        expect(JSON.parse(initialized).type).toBe("initialized")

        // Close the socket abruptly
        ws.close()

        // Give the server a moment to process the disconnect
        yield* Effect.sleep("200 millis")

        expect(rejections).toEqual([])
      } finally {
        globalThis.removeEventListener("unhandledrejection", handler)
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(makeWsTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})
