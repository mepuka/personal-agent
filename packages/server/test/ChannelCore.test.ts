import { describe, expect, it } from "@effect/vitest"
import type { TurnStreamEvent } from "@template/domain/events"
import type { AgentId, ChannelId } from "@template/domain/ids"
import type { AgentStatePort, ChannelPort, SessionTurnPort } from "@template/domain/ports"
import { Effect, Layer, Stream } from "effect"
import { Sharding } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { ChannelCore } from "../src/ChannelCore.js"
import { ChannelPortSqlite } from "../src/ChannelPortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { AgentStatePortTag, ChannelPortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { SessionTurnPortSqlite } from "../src/SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "../src/turn/TurnProcessingRuntime.js"
import type { ProcessTurnPayload } from "../src/turn/TurnProcessingWorkflow.js"

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
// Test layer — SQLite-backed ports + mock runtime + ChannelCore
// ---------------------------------------------------------------------------

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

  const mockRuntimeLayer = makeMockTurnProcessingRuntime()

  // Provide a mock Sharding that does NOT have makeClient,
  // so ChannelCore falls back to the direct TurnProcessingRuntime.
  const mockShardingLayer = Layer.succeed(Sharding.Sharding, {} as any)

  const channelCoreLayer = ChannelCore.layer.pipe(
    Layer.provide(agentStateTagLayer),
    Layer.provide(channelPortTagLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(mockRuntimeLayer),
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
    mockRuntimeLayer,
    channelCoreLayer
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

describe("ChannelCore", () => {
  it.effect("initializeChannel creates channel + session + agent state", () => {
    const dbPath = testDatabasePath("core-init")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:core-init" as ChannelId

      yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:core-test" as AgentId,
        capabilities: ["SendText"]
      })

      // Verify channel was created
      const channelPort = yield* ChannelPortSqlite
      const channel = yield* channelPort.get(channelId)
      expect(channel).not.toBeNull()
      expect(channel!.channelType).toBe("CLI")
      expect(channel!.agentId).toBe("agent:core-test")
      expect(channel!.capabilities).toEqual(["SendText"])

      // Verify agent state was created
      const agentStatePort = yield* AgentStatePortSqlite
      const agentState = yield* agentStatePort.get("agent:core-test" as AgentId)
      expect(agentState).not.toBeNull()
      expect(agentState!.permissionMode).toBe("Standard")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("initializeChannel is idempotent", () => {
    const dbPath = testDatabasePath("core-idempotent")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:core-idempotent" as ChannelId

      yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:core-idempotent" as AgentId,
        capabilities: ["SendText"]
      })

      const channelPort = yield* ChannelPortSqlite
      const first = yield* channelPort.get(channelId)
      expect(first).not.toBeNull()
      const firstSessionId = first!.activeSessionId

      // Call initializeChannel again — should be no-op
      yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:core-idempotent" as AgentId,
        capabilities: ["SendText"]
      })

      const second = yield* channelPort.get(channelId)
      expect(second).not.toBeNull()
      expect(second!.activeSessionId).toBe(firstSessionId)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("initializeChannel with different capabilities", () => {
    const dbPath = testDatabasePath("core-caps")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:core-caps" as ChannelId

      yield* core.initializeChannel({
        channelId,
        channelType: "WebChat",
        agentId: "agent:core-caps" as AgentId,
        capabilities: ["SendText", "Typing", "StreamingDelivery"]
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

  it.effect("buildTurnPayload returns valid payload for existing channel", () => {
    const dbPath = testDatabasePath("core-payload")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:core-payload" as ChannelId

      yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:core-payload" as AgentId,
        capabilities: ["SendText"]
      })

      const payload = yield* core.buildTurnPayload({
        channelId,
        content: "hello world",
        contentBlocks: [{ contentBlockType: "TextBlock", text: "hello world" }],
        userId: "user:test"
      })

      expect(payload.turnId).toMatch(/^turn:/)
      expect(payload.sessionId).toBe(`session:${channelId}`)
      expect(payload.conversationId).toBe(`conv:${channelId}`)
      expect(payload.agentId).toBe("agent:core-payload")
      expect(payload.content).toBe("hello world")
      expect(payload.contentBlocks).toEqual([{ contentBlockType: "TextBlock", text: "hello world" }])
      expect(payload.inputTokens).toBe(0)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("buildTurnPayload fails with ChannelNotFound for missing channel", () => {
    const dbPath = testDatabasePath("core-payload-notfound")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:nonexistent" as ChannelId

      const error = yield* core.buildTurnPayload({
        channelId,
        content: "this should fail",
        contentBlocks: [{ contentBlockType: "TextBlock", text: "this should fail" }],
        userId: "user:test"
      }).pipe(Effect.flip)

      expect(error._tag).toBe("ChannelNotFound")
      expect(error.channelId).toBe(channelId)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("getHistory returns empty for new channel", () => {
    const dbPath = testDatabasePath("core-history-empty")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:core-history" as ChannelId

      yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:core-history" as AgentId,
        capabilities: ["SendText"]
      })

      const history = yield* core.getHistory(channelId)
      expect(history).toEqual([])
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("getHistory fails with ChannelNotFound for missing channel", () => {
    const dbPath = testDatabasePath("core-history-notfound")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:nonexistent" as ChannelId

      const error = yield* core.getHistory(channelId).pipe(Effect.flip)

      expect(error._tag).toBe("ChannelNotFound")
      expect(error.channelId).toBe(channelId)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("re-init with different channelType fails with ChannelTypeMismatch", () => {
    const dbPath = testDatabasePath("core-type-mismatch")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:core-type-mismatch" as ChannelId

      // First init as CLI
      yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:type-mismatch" as AgentId,
        capabilities: ["SendText"]
      })

      // Re-init as WebChat — should fail
      const error = yield* core.initializeChannel({
        channelId,
        channelType: "WebChat",
        agentId: "agent:type-mismatch" as AgentId,
        capabilities: ["SendText", "Typing", "StreamingDelivery"]
      }).pipe(Effect.flip)

      expect(error._tag).toBe("ChannelTypeMismatch")
      expect(error.channelId).toBe(channelId)
      expect(error.existingType).toBe("CLI")
      expect(error.requestedType).toBe("WebChat")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("re-init with different agentId fails with ChannelTypeMismatch", () => {
    const dbPath = testDatabasePath("core-agent-mismatch")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:core-agent-mismatch" as ChannelId

      // First init with agent:a
      yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:a" as AgentId,
        capabilities: ["SendText"]
      })

      // Re-init with agent:b — should fail
      const error = yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:b" as AgentId,
        capabilities: ["SendText"]
      }).pipe(Effect.flip)

      expect(error._tag).toBe("ChannelTypeMismatch")
      expect(error.channelId).toBe(channelId)
      expect(error.existingType).toBe("agent:a")
      expect(error.requestedType).toBe("agent:b")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("processTurn streams events using direct runtime fallback in test", () => {
    const dbPath = testDatabasePath("core-process")
    return Effect.gen(function*() {
      const core = yield* ChannelCore
      const channelId = "channel:core-process" as ChannelId

      yield* core.initializeChannel({
        channelId,
        channelType: "CLI",
        agentId: "agent:core-process" as AgentId,
        capabilities: ["SendText"]
      })

      const payload = yield* core.buildTurnPayload({
        channelId,
        content: "hello from core",
        contentBlocks: [{ contentBlockType: "TextBlock", text: "hello from core" }],
        userId: "user:test"
      })

      const events = yield* core.processTurn(payload).pipe(Stream.runCollect)

      expect(events.length).toBeGreaterThan(0)
      expect(events[0]?.type).toBe("turn.started")
      expect(events.some((e) => e.type === "assistant.delta")).toBe(true)
      expect(events.some((e) => e.type === "turn.completed")).toBe(true)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})
