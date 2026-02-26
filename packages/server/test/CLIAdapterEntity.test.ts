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
import { CLIAdapterEntity, layer as CLIAdapterEntityLayer } from "../src/entities/CLIAdapterEntity.js"
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

describe("CLIAdapterEntity", () => {
  it.effect("createChannel + getHistory returns empty", () => {
    const dbPath = testDatabasePath("cli-adapter-create")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(CLIAdapterEntity, CLIAdapterEntityLayer)
      const channelId = "channel:test-create" as ChannelId
      const client = yield* makeClient(channelId)

      yield* client.createChannel({
        channelType: "CLI",
        agentId: "agent:test-1"
      })

      const history = yield* client.getHistory({})
      expect(history).toEqual([])
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("createChannel is idempotent", () => {
    const dbPath = testDatabasePath("cli-adapter-idempotent")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(CLIAdapterEntity, CLIAdapterEntityLayer)
      const channelId = "channel:test-idempotent" as ChannelId
      const client = yield* makeClient(channelId)

      yield* client.createChannel({
        channelType: "CLI",
        agentId: "agent:test-idempotent"
      })

      const channelPort = yield* ChannelPortSqlite
      const first = yield* channelPort.get(channelId)
      expect(first).not.toBeNull()
      const firstSessionId = first!.activeSessionId

      yield* client.createChannel({
        channelType: "CLI",
        agentId: "agent:test-idempotent"
      })

      const second = yield* channelPort.get(channelId)
      expect(second).not.toBeNull()
      expect(second!.activeSessionId).toBe(firstSessionId)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("sendMessage returns stream of TurnStreamEvents", () => {
    const dbPath = testDatabasePath("cli-adapter-send")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(CLIAdapterEntity, CLIAdapterEntityLayer)
      const channelId = "channel:test-send" as ChannelId
      const client = yield* makeClient(channelId)

      yield* client.createChannel({
        channelType: "CLI",
        agentId: "agent:test-send"
      })

      const events = yield* client.sendMessage({
        content: "hello from channel"
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

  it.effect("sendMessage to non-existent channel fails with ChannelNotFound", () => {
    const dbPath = testDatabasePath("cli-adapter-notfound")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(CLIAdapterEntity, CLIAdapterEntityLayer)
      const channelId = "channel:nonexistent" as ChannelId
      const client = yield* makeClient(channelId)

      const error = yield* client.sendMessage({
        content: "this should fail"
      }).pipe(Stream.runCollect, Effect.flip)

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
