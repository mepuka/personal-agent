import { describe, expect, it } from "@effect/vitest"
import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type { AgentState, GovernancePort, Instant } from "@template/domain/ports"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { ToolRegistry } from "../src/ai/ToolRegistry.js"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { GovernancePortTag } from "../src/PortTags.js"

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
})

const invokeTool = (
  agentId: AgentId,
  toolName: "echo_text" | "math_calculate" | "time_now",
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

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    AgentStatePortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer)),
    governanceSqliteLayer,
    governanceTagLayer,
    ToolRegistry.layer.pipe(Layer.provide(governanceTagLayer))
  )
}

const makeAgentState = (overrides: Partial<AgentState>): AgentState => ({
  agentId: "agent:default" as AgentId,
  permissionMode: "Standard",
  tokenBudget: 1_000,
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
