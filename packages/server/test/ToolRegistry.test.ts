import { describe, expect, it } from "@effect/vitest"
import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type { AgentState, GovernancePort, Instant, MemoryPort } from "@template/domain/ports"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentConfig } from "../src/ai/AgentConfig.js"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { ToolRegistry } from "../src/ai/ToolRegistry.js"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { GovernancePortTag, MemoryPortTag } from "../src/PortTags.js"

const SESSION_ID = "session:tool-registry" as SessionId
const CONVERSATION_ID = "conversation:tool-registry" as ConversationId
const TURN_ID = "turn:tool-registry" as TurnId
const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))
const NOW = instant("2026-02-27T12:00:00.000Z")

describe("ToolRegistry", () => {
  it("allow path records compliant tool invocation", async () => {
    const dbPath = testDatabasePath("tool-registry-allow")
    const layer = makeToolRegistryLayer(dbPath)
    const agentId = "agent:allow" as AgentId

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      const governance = yield* GovernancePortSqlite
      yield* agents.upsert(makeAgentState({
        agentId,
        permissionMode: "Standard",
        budgetResetAt: NOW
      }))

      const output = yield* invokeTool(agentId, "echo_text", { text: "hello" })
      expect(output).toContain("\"hello\"")

      const records = yield* governance.listToolInvocationsBySession(SESSION_ID, {})
      expect(records.totalCount).toBe(1)
      expect(records.items[0].toolName).toBe("echo_text")
      expect(records.items[0].decision).toBe("Allow")
      expect(records.items[0].complianceStatus).toBe("Compliant")
      expect(records.items[0].conversationId).toBe(CONVERSATION_ID)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("deny path records non-compliant invocation when policy denies", async () => {
    const dbPath = testDatabasePath("tool-registry-deny")
    const layer = makeToolRegistryLayer(dbPath)
    const agentId = "agent:missing" as AgentId

    const program = Effect.gen(function*() {
      const governance = yield* GovernancePortSqlite

      const failure = (yield* invokeTool(agentId, "echo_text", { text: "blocked" }).pipe(
        Effect.flip
      )) as { readonly errorCode: string }

      expect(failure.errorCode).toBe("PolicyDenied")

      const records = yield* governance.listToolInvocationsBySession(SESSION_ID, {})
      expect(records.totalCount).toBe(1)
      expect(records.items[0].decision).toBe("Deny")
      expect(records.items[0].complianceStatus).toBe("NonCompliant")
      expect(records.items[0].reason).toContain("tool_policy_denied")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("quota exceeded path records non-compliant invocation", async () => {
    const dbPath = testDatabasePath("tool-registry-quota")
    const layer = makeToolRegistryLayer(dbPath)
    const agentId = "agent:quota" as AgentId

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      const governance = yield* GovernancePortSqlite
      const sql = yield* SqlClient.SqlClient

      yield* agents.upsert(makeAgentState({
        agentId,
        permissionMode: "Standard",
        budgetResetAt: NOW
      }))

      const windowStart = DateTime.formatIso(DateTime.removeTime(NOW))
      yield* sql`
        INSERT INTO tool_quota_counters (
          agent_id,
          tool_name,
          window_start,
          used_count
        ) VALUES (
          ${agentId},
          ${"echo_text"},
          ${windowStart},
          ${500}
        )
      `.unprepared

      const failure = (yield* invokeTool(agentId, "echo_text", { text: "over-limit" }).pipe(
        Effect.flip
      )) as { readonly errorCode: string }
      expect(failure.errorCode).toBe("ToolQuotaExceeded")

      const records = yield* governance.listToolInvocationsBySession(SESSION_ID, {})
      expect(records.totalCount).toBe(1)
      expect(records.items[0].decision).toBe("Deny")
      expect(records.items[0].complianceStatus).toBe("NonCompliant")
      expect(records.items[0].reason).toContain("tool_quota_exceeded")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("governance system error fails closed and records non-compliant invocation", async () => {
    const dbPath = testDatabasePath("tool-registry-governance-error")
    const layer = makeToolRegistryLayer(dbPath, {
      evaluatePolicy: () => Effect.die("policy backend unavailable")
    })
    const agentId = "agent:error" as AgentId

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      const governance = yield* GovernancePortSqlite

      yield* agents.upsert(makeAgentState({
        agentId,
        permissionMode: "Permissive",
        budgetResetAt: NOW
      }))

      const failure = (yield* invokeTool(agentId, "echo_text", { text: "test" }).pipe(
        Effect.flip
      )) as { readonly errorCode: string }
      expect(failure.errorCode).toBe("GovernancePolicyError")

      const records = yield* governance.listToolInvocationsBySession(SESSION_ID, {})
      expect(records.totalCount).toBe(1)
      expect(records.items[0].decision).toBe("Deny")
      expect(records.items[0].complianceStatus).toBe("NonCompliant")
      expect(records.items[0].reason).toBe("governance_system_error:evaluate_policy")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("store_memory happy path stores and returns memoryId", async () => {
    const dbPath = testDatabasePath("tool-registry-store-memory")
    const layer = makeToolRegistryLayer(dbPath)
    const agentId = "agent:store-mem" as AgentId

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({
        agentId,
        permissionMode: "Standard",
        budgetResetAt: NOW
      }))

      const output = yield* invokeTool(agentId, "store_memory", {
        content: "test fact",
        tags: ["tag1"]
      })
      expect(output).toContain("memoryId")
      expect(output).toContain("true")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("retrieve_memories returns stored memories", async () => {
    const dbPath = testDatabasePath("tool-registry-retrieve-memories")
    const layer = makeToolRegistryLayer(dbPath)
    const agentId = "agent:retrieve-mem" as AgentId

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({
        agentId,
        permissionMode: "Standard",
        budgetResetAt: NOW
      }))

      yield* invokeTool(agentId, "store_memory", {
        content: "remembered fact for retrieval"
      })

      const output = yield* invokeTool(agentId, "retrieve_memories", {
        query: "remembered fact",
        limit: 5
      })
      expect(output).toContain("remembered fact")
      expect(output).toContain("memoryId")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("forget_memories removes stored memories", async () => {
    const dbPath = testDatabasePath("tool-registry-forget-memories")
    const layer = makeToolRegistryLayer(dbPath)
    const agentId = "agent:forget-mem" as AgentId

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({
        agentId,
        permissionMode: "Standard",
        budgetResetAt: NOW
      }))

      const storeOutput = yield* invokeTool(agentId, "store_memory", {
        content: "memory to forget"
      })
      // Extract memoryId from the JSON output string
      const memoryIdMatch = storeOutput.match(/"memoryId"\s*:\s*"([^"]+)"/)
      expect(memoryIdMatch).not.toBeNull()
      const memoryId = memoryIdMatch![1]

      const forgetOutput = yield* invokeTool(agentId, "forget_memories", {
        memoryIds: [memoryId]
      })
      expect(forgetOutput).toContain("\"forgotten\"")
      expect(forgetOutput).toContain("1")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("forget_memories with empty IDs returns InvalidMemoryIds error", async () => {
    const dbPath = testDatabasePath("tool-registry-forget-empty")
    const layer = makeToolRegistryLayer(dbPath)
    const agentId = "agent:forget-empty" as AgentId

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({
        agentId,
        permissionMode: "Standard",
        budgetResetAt: NOW
      }))

      const failure = (yield* invokeTool(agentId, "forget_memories", {
        memoryIds: ["", "  "]
      }).pipe(
        Effect.flip
      )) as { readonly errorCode: string }
      expect(failure.errorCode).toBe("InvalidMemoryIds")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })
})

const invokeTool = (
  agentId: AgentId,
  toolName: "echo_text" | "math_calculate" | "time_now" | "store_memory" | "retrieve_memories" | "forget_memories",
  params: Record<string, unknown>
) =>
  Effect.gen(function*() {
    const registry = yield* ToolRegistry
    const bundle = yield* registry.makeToolkit({
      agentId,
      sessionId: SESSION_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      now: NOW
    })
    const toolkit = yield* bundle.toolkit.asEffect().pipe(
      Effect.provide(bundle.handlerLayer)
    )
    const stream = yield* toolkit.handle(toolName as any, params as any).pipe(
      Effect.mapError(toToolFailure)
    )
    const chunks = yield* Stream.runCollect(stream).pipe(
      Effect.mapError(toToolFailure)
    )
    return encodeJson(chunks)
  })

const encodeJsonUnknown = Schema.encodeSync(Schema.UnknownFromJsonString)

const encodeJson = (value: unknown): string => encodeJsonUnknown(value)

const mockAgentConfigLayer = AgentConfig.layerFromParsed({
  providers: { anthropic: { apiKeyEnv: "TEST_KEY" } },
  agents: {
    default: {
      persona: { name: "Test", systemPrompt: "test" },
      model: { provider: "anthropic", modelId: "test-model" },
      generation: { temperature: 0.7, maxOutputTokens: 1024 }
    }
  },
  server: { port: 3000 }
})

const makeToolRegistryLayer = (
  dbPath: string,
  overrides: Partial<GovernancePort> = {}
) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.orDie
  )
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

  const governanceSqliteLayer = GovernancePortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const governanceTagLayer = Layer.effect(
    GovernancePortTag,
    Effect.gen(function*() {
      const governance = yield* GovernancePortSqlite
      return {
        ...governance,
        ...overrides
      } as GovernancePort
    })
  ).pipe(Layer.provide(governanceSqliteLayer))

  const memoryPortSqliteLayer = MemoryPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const memoryPortTagLayer = Layer.effect(
    MemoryPortTag,
    Effect.gen(function*() {
      return (yield* MemoryPortSqlite) as MemoryPort
    })
  ).pipe(Layer.provide(memoryPortSqliteLayer))

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    AgentStatePortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer)),
    governanceSqliteLayer,
    governanceTagLayer,
    memoryPortSqliteLayer,
    memoryPortTagLayer,
    ToolRegistry.layer.pipe(
      Layer.provide(governanceTagLayer),
      Layer.provide(memoryPortTagLayer),
      Layer.provide(mockAgentConfigLayer)
    )
  )
}

const makeAgentState = (overrides: Partial<AgentState>): AgentState => ({
  agentId: "agent:default" as AgentId,
  permissionMode: "Standard",
  tokenBudget: 1_000,
  maxToolIterations: 10,
  quotaPeriod: "Daily",
  tokensConsumed: 0,
  budgetResetAt: null,
  ...overrides
})

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })

const toToolFailure = (error: unknown): { readonly errorCode: string; readonly message: string } => ({
  errorCode: (
      typeof error === "object"
      && error !== null
      && "errorCode" in error
      && typeof (error as { readonly errorCode?: unknown }).errorCode === "string"
    )
    ? (error as { readonly errorCode: string }).errorCode
    : "ToolInvocationError",
  message: (
      typeof error === "object"
      && error !== null
      && "message" in error
      && typeof (error as { readonly message?: unknown }).message === "string"
    )
    ? (error as { readonly message: string }).message
    : error instanceof Error
    ? error.message
    : String(error)
})
