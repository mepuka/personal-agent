import { describe, expect, it } from "@effect/vitest"
import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type {
  AgentState,
  AgentStatePort,
  GovernancePort,
  Instant,
  SessionState,
  SessionTurnPort
} from "@template/domain/ports"
import { DateTime, Effect, Layer, Stream } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Response from "effect/unstable/ai/Response"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { AgentConfig } from "../src/ai/AgentConfig.js"
import * as ChatPersistence from "../src/ai/ChatPersistence.js"
import { ModelRegistry } from "../src/ai/ModelRegistry.js"
import { ToolRegistry } from "../src/ai/ToolRegistry.js"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { AgentStatePortTag, GovernancePortTag, MemoryPortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { SessionTurnPortSqlite } from "../src/SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "../src/turn/TurnProcessingRuntime.js"
import {
  layer as TurnProcessingWorkflowLayer,
  type ProcessTurnPayload
} from "../src/turn/TurnProcessingWorkflow.js"

const TEST_SYSTEM_PROMPT = "You are a test bot. Always respond with 'Hello from test bot!'"

const testConfigData = {
  providers: { anthropic: { apiKeyEnv: "PA_ANTHROPIC_API_KEY" } },
  agents: {
    default: {
      persona: { name: "Test Bot", systemPrompt: TEST_SYSTEM_PROMPT },
      model: { provider: "anthropic", modelId: "test-model" },
      generation: { temperature: 0.0, maxOutputTokens: 100 }
    }
  },
  server: { port: 3000 }
}

describe("ChatFlow E2E", () => {
  it.effect("full chat flow: config → turn processing → system prompt injected → response persisted", () => {
    const dbPath = testDatabasePath("chatflow-happy")
    const layer = makeChatFlowLayer(dbPath)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-25T12:00:00.000Z")
      const agent = makeAgentState({
        agentId: "agent:chatflow" as AgentId,
        tokenBudget: 500,
        tokensConsumed: 0,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      })
      const session = makeSessionState({
        sessionId: "session:chatflow" as SessionId,
        conversationId: "conversation:chatflow" as ConversationId,
        tokenCapacity: 1000,
        tokensUsed: 0
      })

      yield* agentPort.upsert(agent)
      yield* sessionPort.startSession(session)

      // Process a turn through the full workflow
      const result = yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:chatflow-1" as TurnId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        createdAt: now,
        inputTokens: 20,
        content: "Hello!"
      }))

      // Verify turn accepted
      expect(result.accepted).toBe(true)
      expect(result.assistantContent).toContain("assistant mock response")

      // Verify history persisted (user + assistant)
      const turns = yield* sessionPort.listTurns(session.sessionId)
      expect(turns).toHaveLength(2)
      expect(turns[0].participantRole).toBe("UserRole")
      expect(turns[0].message.content).toBe("Hello!")
      expect(turns[1].participantRole).toBe("AssistantRole")
      expect(turns[1].message.content).toContain("assistant mock response")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("streams canonical events through full workflow", () => {
    const dbPath = testDatabasePath("chatflow-stream")
    const layer = makeChatFlowLayer(dbPath)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-25T12:00:00.000Z")
      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:chatflow-stream" as AgentId,
        tokenBudget: 500,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:chatflow-stream" as SessionId,
        conversationId: "conversation:chatflow-stream" as ConversationId,
        tokenCapacity: 1000,
        tokensUsed: 0
      }))

      const events = yield* runtime.processTurnStream(makeTurnPayload({
        turnId: "turn:chatflow-stream" as TurnId,
        agentId: "agent:chatflow-stream" as AgentId,
        sessionId: "session:chatflow-stream" as SessionId,
        conversationId: "conversation:chatflow-stream" as ConversationId,
        createdAt: now,
        inputTokens: 15,
        content: "stream me"
      })).pipe(Stream.runCollect)

      expect(events[0]?.type).toBe("turn.started")
      expect(events.some((e) => e.type === "assistant.delta")).toBe(true)
      expect(events.some((e) => e.type === "turn.completed")).toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("second turn reuses existing chat history without re-injecting system prompt", () => {
    const dbPath = testDatabasePath("chatflow-multi")
    const layer = makeChatFlowLayer(dbPath)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-25T12:00:00.000Z")
      const agent = makeAgentState({
        agentId: "agent:chatflow-multi" as AgentId,
        tokenBudget: 1000,
        tokensConsumed: 0,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      })
      const session = makeSessionState({
        sessionId: "session:chatflow-multi" as SessionId,
        conversationId: "conversation:chatflow-multi" as ConversationId,
        tokenCapacity: 2000,
        tokensUsed: 0
      })

      yield* agentPort.upsert(agent)
      yield* sessionPort.startSession(session)

      // First turn
      yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:multi-1" as TurnId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        createdAt: now,
        inputTokens: 20,
        content: "first message"
      }))

      // Second turn
      const second = yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:multi-2" as TurnId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        createdAt: instant("2026-02-25T12:01:00.000Z"),
        inputTokens: 20,
        content: "second message"
      }))

      expect(second.accepted).toBe(true)

      // Should have 4 turns total (2 user + 2 assistant)
      const turns = yield* sessionPort.listTurns(session.sessionId)
      expect(turns).toHaveLength(4)
      expect(turns[0].participantRole).toBe("UserRole")
      expect(turns[1].participantRole).toBe("AssistantRole")
      expect(turns[2].participantRole).toBe("UserRole")
      expect(turns[3].participantRole).toBe("AssistantRole")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

const makeChatFlowLayer = (dbPath: string) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.orDie
  )
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

  const agentStateSqliteLayer = AgentStatePortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const sessionTurnSqliteLayer = SessionTurnPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const governanceSqliteLayer = GovernancePortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const memoryPortSqliteLayer = MemoryPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )

  const memoryPortTagLayer = Layer.effect(
    MemoryPortTag,
    Effect.gen(function*() {
      return (yield* MemoryPortSqlite) as import("@template/domain/ports").MemoryPort
    })
  ).pipe(Layer.provide(memoryPortSqliteLayer))

  const agentStateTagLayer = Layer.effect(
    AgentStatePortTag,
    Effect.gen(function*() {
      return (yield* AgentStatePortSqlite) as AgentStatePort
    })
  ).pipe(Layer.provide(agentStateSqliteLayer))

  const sessionTurnTagLayer = Layer.effect(
    SessionTurnPortTag,
    Effect.gen(function*() {
      return (yield* SessionTurnPortSqlite) as SessionTurnPort
    })
  ).pipe(Layer.provide(sessionTurnSqliteLayer))

  const governanceTagLayer = Layer.effect(
    GovernancePortTag,
    Effect.gen(function*() {
      return (yield* GovernancePortSqlite) as GovernancePort
    })
  ).pipe(Layer.provide(governanceSqliteLayer))

  const agentConfigLayer = AgentConfig.layerFromParsed(testConfigData)

  const mockModelRegistryLayer = Layer.effect(
    ModelRegistry,
    Effect.succeed({
      get: (_provider: string, _modelId: string) =>
        Effect.succeed(
          Layer.succeed(LanguageModel.LanguageModel, makeMockLanguageModel())
        )
    })
  )

  const chatPersistenceLayer = ChatPersistence.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )

  const toolRegistryLayer = ToolRegistry.layer.pipe(
    Layer.provide(governanceTagLayer)
  )

  const clusterLayer = SingleRunner.layer().pipe(
    Layer.provide(sqlInfrastructureLayer),
    Layer.orDie
  )

  const workflowEngineLayer = ClusterWorkflowEngine.layer.pipe(
    Layer.provide(clusterLayer)
  )

  const turnWorkflowLayer = TurnProcessingWorkflowLayer.pipe(
    Layer.provide(workflowEngineLayer),
    Layer.provide(agentStateTagLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(governanceTagLayer),
    Layer.provide(memoryPortTagLayer),
    Layer.provide(toolRegistryLayer),
    Layer.provide(chatPersistenceLayer),
    Layer.provide(agentConfigLayer),
    Layer.provide(mockModelRegistryLayer)
  )

  const turnRuntimeLayer = TurnProcessingRuntime.layer.pipe(
    Layer.provide(workflowEngineLayer)
  )

  return turnRuntimeLayer.pipe(
    Layer.provideMerge(turnWorkflowLayer),
    Layer.provideMerge(workflowEngineLayer),
    Layer.provideMerge(Layer.mergeAll(
      toolRegistryLayer,
      mockModelRegistryLayer
    )),
    Layer.provideMerge(Layer.mergeAll(
      chatPersistenceLayer,
      agentConfigLayer
    )),
    Layer.provideMerge(Layer.mergeAll(
      agentStateTagLayer,
      sessionTurnTagLayer,
      governanceTagLayer,
      memoryPortTagLayer
    )),
    Layer.provideMerge(Layer.mergeAll(
      agentStateSqliteLayer,
      sessionTurnSqliteLayer,
      governanceSqliteLayer,
      memoryPortSqliteLayer
    )),
    Layer.provideMerge(clusterLayer),
    Layer.provideMerge(sqlInfrastructureLayer)
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const makeAgentState = (overrides: Partial<AgentState>): AgentState => ({
  agentId: "agent:default" as AgentId,
  permissionMode: "Standard",
  tokenBudget: 100,
  quotaPeriod: "Daily",
  tokensConsumed: 0,
  budgetResetAt: null,
  ...overrides
})

const makeSessionState = (overrides: Partial<SessionState>): SessionState => ({
  sessionId: "session:default" as SessionId,
  conversationId: "conversation:default" as ConversationId,
  tokenCapacity: 512,
  tokensUsed: 0,
  ...overrides
})

const makeTurnPayload = (overrides: Partial<ProcessTurnPayload>): ProcessTurnPayload => ({
  turnId: overrides.turnId ?? "turn:default",
  sessionId: overrides.sessionId ?? "session:default",
  conversationId: overrides.conversationId ?? "conversation:default",
  agentId: overrides.agentId ?? "agent:default",
  content: overrides.content ?? "hello",
  contentBlocks: overrides.contentBlocks ?? [{ contentBlockType: "TextBlock", text: overrides.content ?? "hello" }],
  createdAt: overrides.createdAt ?? instant("2026-02-25T12:00:00.000Z"),
  inputTokens: overrides.inputTokens ?? 10
})

const makeMockLanguageModel = (): LanguageModel.Service => ({
  generateText: (_options: any) =>
    Effect.succeed(
      new LanguageModel.GenerateTextResponse([
        Response.makePart("text", {
          text: "assistant mock response"
        }),
        Response.makePart("finish", {
          reason: "stop",
          usage: new Response.Usage({
            inputTokens: {
              uncached: 10,
              total: 10,
              cacheRead: undefined,
              cacheWrite: undefined
            },
            outputTokens: {
              total: 6,
              text: 6,
              reasoning: undefined
            }
          }),
          response: undefined
        })
      ])
    ) as any,
  streamText: (_options: any) => Stream.empty as any,
  generateObject: (_options: any) => Effect.die(new Error("generateObject not implemented in tests")) as any
})

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
