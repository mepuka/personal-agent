import { describe, expect, it } from "@effect/vitest"
import type { TurnStreamEvent } from "@template/domain/events"
import type { ChannelId } from "@template/domain/ids"
import type { AgentStatePort, ChannelPort, SessionTurnPort } from "@template/domain/ports"
import { Effect, Layer, Stream } from "effect"
import { Entity, Sharding, ShardingConfig } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { ChannelCore } from "../src/ChannelCore.js"
import { ChannelPortSqlite } from "../src/ChannelPortSqlite.js"
import {
  WebChatAdapterEntity,
  layer as WebChatAdapterEntityLayer
} from "../src/entities/WebChatAdapterEntity.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { AgentStatePortTag, ChannelPortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { SessionTurnPortSqlite } from "../src/SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "../src/turn/TurnProcessingRuntime.js"
import type { ProcessTurnPayload } from "../src/turn/TurnProcessingWorkflow.js"

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

const makeTestLayer = (dbPath: string) => {
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

  const mockTurnProcessingRuntimeLayer = makeMockTurnProcessingRuntime()
  const mockShardingLayer = Layer.succeed(Sharding.Sharding, {} as any)

  const channelCoreLayer = ChannelCore.layer.pipe(
    Layer.provide(agentStateTagLayer),
    Layer.provide(channelPortTagLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(mockTurnProcessingRuntimeLayer),
    Layer.provide(mockShardingLayer)
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
    channelCoreLayer,
    ShardingConfig.layer()
  )
}

describe("WebChatAdapterEntity", () => {
  it.effect("initialize creates a WebChat channel with correct capabilities", () => {
    const dbPath = testDatabasePath("webchat-initialize")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(WebChatAdapterEntity, WebChatAdapterEntityLayer)
      const channelId = "channel:webchat-init" as ChannelId
      const client = yield* makeClient(channelId)

      yield* client.initialize({
        channelType: "WebChat",
        agentId: "agent:webchat-1",
        userId: "user:web:test"
      })

      const channelPort = yield* ChannelPortSqlite
      const channel = yield* channelPort.get(channelId)
      expect(channel).not.toBeNull()
      expect(channel!.channelType).toBe("WebChat")
      expect(channel!.capabilities).toEqual(["SendText", "Typing", "StreamingDelivery"])
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("initialize is idempotent", () => {
    const dbPath = testDatabasePath("webchat-idempotent")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(WebChatAdapterEntity, WebChatAdapterEntityLayer)
      const channelId = "channel:webchat-idempotent" as ChannelId
      const client = yield* makeClient(channelId)

      yield* client.initialize({
        channelType: "WebChat",
        agentId: "agent:webchat-idempotent",
        userId: "user:web:test"
      })

      const channelPort = yield* ChannelPortSqlite
      const first = yield* channelPort.get(channelId)
      expect(first).not.toBeNull()
      const firstSessionId = first!.activeSessionId

      yield* client.initialize({
        channelType: "WebChat",
        agentId: "agent:webchat-idempotent",
        userId: "user:web:test"
      })

      const second = yield* channelPort.get(channelId)
      expect(second).not.toBeNull()
      expect(second!.activeSessionId).toBe(firstSessionId)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("initialize always uses WebChat regardless of payload channelType", () => {
    const dbPath = testDatabasePath("webchat-always-webchat")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(WebChatAdapterEntity, WebChatAdapterEntityLayer)
      const channelId = "channel:webchat-forced" as ChannelId
      const client = yield* makeClient(channelId)

      // Even if we send channelType: "CLI", the adapter should use "WebChat"
      yield* client.initialize({
        channelType: "CLI",
        agentId: "agent:webchat-forced",
        userId: "user:web:test"
      })

      const channelPort = yield* ChannelPortSqlite
      const channel = yield* channelPort.get(channelId)
      expect(channel).not.toBeNull()
      expect(channel!.channelType).toBe("WebChat")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("receiveMessage returns stream of TurnStreamEvents", () => {
    const dbPath = testDatabasePath("webchat-receive")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(WebChatAdapterEntity, WebChatAdapterEntityLayer)
      const channelId = "channel:webchat-receive" as ChannelId
      const client = yield* makeClient(channelId)

      yield* client.initialize({
        channelType: "WebChat",
        agentId: "agent:webchat-receive",
        userId: "user:web:test"
      })

      const events = yield* client.receiveMessage({
        content: "hello from webchat",
        userId: "user:web:test"
      }).pipe(Stream.runCollect)

      expect(events.length).toBeGreaterThan(0)
      expect(events[0]?.type).toBe("turn.started")
      expect(events.some((e) => e.type === "assistant.delta")).toBe(true)
      expect(events.some((e) => e.type === "turn.completed")).toBe(true)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("receiveMessage to non-existent channel fails with ChannelNotFound", () => {
    const dbPath = testDatabasePath("webchat-notfound")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(WebChatAdapterEntity, WebChatAdapterEntityLayer)
      const channelId = "channel:webchat-nonexistent" as ChannelId
      const client = yield* makeClient(channelId)

      const error = yield* client.receiveMessage({
        content: "this should fail",
        userId: "user:web:test"
      }).pipe(Stream.runCollect, Effect.flip)

      expect(error._tag).toBe("ChannelNotFound")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("getHistory returns empty for new channel", () => {
    const dbPath = testDatabasePath("webchat-history-empty")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(WebChatAdapterEntity, WebChatAdapterEntityLayer)
      const channelId = "channel:webchat-history" as ChannelId
      const client = yield* makeClient(channelId)

      yield* client.initialize({
        channelType: "WebChat",
        agentId: "agent:webchat-history",
        userId: "user:web:test"
      })

      const history = yield* client.getHistory({})
      expect(history).toEqual([])
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("getStatus returns correct channel info", () => {
    const dbPath = testDatabasePath("webchat-status")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(WebChatAdapterEntity, WebChatAdapterEntityLayer)
      const channelId = "channel:webchat-status" as ChannelId
      const client = yield* makeClient(channelId)

      yield* client.initialize({
        channelType: "WebChat",
        agentId: "agent:webchat-status",
        userId: "user:web:test"
      })

      const status = yield* client.getStatus({})
      expect(status.channelId).toBe(channelId)
      expect(status.channelType).toBe("WebChat")
      expect(status.capabilities).toEqual(["SendText", "Typing", "StreamingDelivery"])
      expect(status.activeSessionId).toBeTruthy()
      expect(status.activeConversationId).toBeTruthy()
      expect(status.createdAt).toBeDefined()
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("getStatus for non-existent channel fails with ChannelNotFound", () => {
    const dbPath = testDatabasePath("webchat-status-notfound")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(WebChatAdapterEntity, WebChatAdapterEntityLayer)
      const channelId = "channel:webchat-no-status" as ChannelId
      const client = yield* makeClient(channelId)

      const error = yield* client.getStatus({}).pipe(Effect.flip)
      expect(error._tag).toBe("ChannelNotFound")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
