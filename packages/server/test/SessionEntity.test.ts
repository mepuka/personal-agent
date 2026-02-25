import { describe, expect, it } from "@effect/vitest"
import type { TurnStreamEvent } from "@template/domain/events"
import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type { Instant, SessionTurnPort } from "@template/domain/ports"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Entity, ShardingConfig } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { layer as SessionEntityLayer, SessionEntity } from "../src/entities/SessionEntity.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { SessionTurnPortTag } from "../src/PortTags.js"
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

  const sessionTurnSqliteLayer = SessionTurnPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const sessionTurnTagLayer = Layer.effect(
    SessionTurnPortTag,
    Effect.gen(function*() {
      return (yield* SessionTurnPortSqlite) as SessionTurnPort
    })
  ).pipe(Layer.provide(sessionTurnSqliteLayer))

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    sessionTurnSqliteLayer,
    sessionTurnTagLayer,
    makeMockTurnProcessingRuntime(),
    ShardingConfig.layer()
  )
}

describe("SessionEntity", () => {
  it.effect("startSession creates a session via entity", () => {
    const dbPath = testDatabasePath("session-entity-start")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(SessionEntity, SessionEntityLayer)
      const sessionId = "session:entity-start" as SessionId
      const client = yield* makeClient(sessionId)

      yield* client.startSession({
        sessionId,
        conversationId: "conversation:entity-start" as ConversationId,
        tokenCapacity: 500,
        tokensUsed: 0
      })

      const sessionPort = yield* SessionTurnPortSqlite
      const session = yield* sessionPort.getSession(sessionId)
      expect(session).not.toBeNull()
      expect(session?.tokenCapacity).toBe(500)
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("processTurn returns a stream of TurnStreamEvents", () => {
    const dbPath = testDatabasePath("session-entity-stream")
    return Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(SessionEntity, SessionEntityLayer)
      const sessionId = "session:entity-stream" as SessionId
      const client = yield* makeClient(sessionId)

      const events = yield* client.processTurn(makeTurnPayload({
        turnId: "turn:entity-stream" as TurnId,
        sessionId,
        agentId: "agent:entity-stream" as AgentId,
        conversationId: "conversation:entity-stream" as ConversationId,
        content: "hello via entity"
      })).pipe(Stream.runCollect)

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

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const makeTurnPayload = (overrides: Partial<ProcessTurnPayload>): ProcessTurnPayload => ({
  turnId: overrides.turnId ?? "turn:default",
  sessionId: overrides.sessionId ?? "session:default",
  conversationId: overrides.conversationId ?? "conversation:default",
  agentId: overrides.agentId ?? "agent:default",
  content: overrides.content ?? "hello",
  contentBlocks: overrides.contentBlocks ?? [{ contentBlockType: "TextBlock", text: "hello" }],
  createdAt: overrides.createdAt ?? instant("2026-02-24T12:00:00.000Z"),
  inputTokens: overrides.inputTokens ?? 10
})

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
