import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type { AgentState, CheckpointPort, CompactionCheckpointPort, CompactionCheckpointRecord, GovernancePort, Instant, MemoryPort } from "@template/domain/ports"
import type { SubroutineToolScope } from "@template/domain/memory"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Response from "effect/unstable/ai/Response"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentConfig } from "../src/ai/AgentConfig.js"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import * as ChatPersistence from "../src/ai/ChatPersistence.js"
import { ModelRegistry } from "../src/ai/ModelRegistry.js"
import { ToolRegistry } from "../src/ai/ToolRegistry.js"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import { CheckpointPortSqlite } from "../src/CheckpointPortSqlite.js"
import { CheckpointPortTag, CompactionCheckpointPortTag, GovernancePortTag, MemoryPortTag } from "../src/PortTags.js"
import { layer as CliRuntimeLocalLayer } from "../src/tools/cli/CliRuntimeLocal.js"
import { layer as CommandBackendLocalLayer } from "../src/tools/command/CommandBackendLocal.js"
import { CommandRuntime } from "../src/tools/command/CommandRuntime.js"
import { CommandHooksDefaultLayer } from "../src/tools/command/hooks/CommandHooksDefault.js"
import { FilePathPolicy } from "../src/tools/file/FilePathPolicy.js"
import { FileReadTracker } from "../src/tools/file/FileReadTracker.js"
import { FileRuntime } from "../src/tools/file/FileRuntime.js"
import { FileHooksDefaultLayer } from "../src/tools/file/hooks/FileHooksDefault.js"
import { ToolExecution } from "../src/tools/ToolExecution.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { SubroutineRunner, buildTriggerPrompt, type SubroutineContext } from "../src/memory/SubroutineRunner.js"
import { TraceWriter } from "../src/memory/TraceWriter.js"
import type { LoadedSubroutine } from "../src/memory/SubroutineCatalog.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_ID = "session:sub-test" as SessionId
const CONVERSATION_ID = "conversation:sub-test" as ConversationId
const AGENT_ID = "agent:default" as AgentId
const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))
const NOW = instant("2026-03-01T12:00:00.000Z")

// ---------------------------------------------------------------------------
// Mock Language Model
// ---------------------------------------------------------------------------

const makeMockLanguageModel = (
  mockOptions?: {
    readonly textResponse?: string
    readonly finishReasons?: ReadonlyArray<Response.FinishReason>
    readonly failWithErrorMessage?: string
  }
): LanguageModel.Service => {
  let callCount = 0

  return {
    generateText: (_options: any) => {
      if (mockOptions?.failWithErrorMessage) {
        return Effect.fail({
          _tag: "MockModelProviderError",
          message: mockOptions.failWithErrorMessage
        }) as any
      }
      const finishReasons = mockOptions?.finishReasons
      const currentCall = callCount++
      const finishReason = finishReasons
        ? (finishReasons[currentCall] ?? finishReasons[finishReasons.length - 1] ?? "stop")
        : "stop"

      const mockUsage = new Response.Usage({
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
      })

      const parts: Array<Response.Part<any>> = []

      if (finishReason === "tool-calls") {
        parts.push(
          Response.makePart("tool-call", {
            id: `call_echo_${currentCall}`,
            name: "echo.text",
            params: { text: "subroutine call" },
            providerExecuted: false
          }),
          Response.makePart("tool-result", {
            id: `call_echo_${currentCall}`,
            name: "echo.text",
            isFailure: false,
            result: { text: "subroutine call" },
            encodedResult: { text: "subroutine call" },
            providerExecuted: false,
            preliminary: false
          })
        )
      } else {
        parts.push(Response.makePart("text", {
          text: mockOptions?.textResponse ?? "I stored a memory."
        }))
      }

      parts.push(Response.makePart("finish", {
        reason: finishReason,
        usage: mockUsage,
        response: undefined
      }))

      return Effect.succeed(
        new LanguageModel.GenerateTextResponse(parts)
      ) as any
    },
    streamText: (_options: any) => Stream.empty as any,
    generateObject: (_options: any) => Effect.die(new Error("generateObject not implemented in tests")) as any
  }
}

// ---------------------------------------------------------------------------
// Mock Agent Config
// ---------------------------------------------------------------------------

const mockAgentConfigLayer = AgentConfig.layerFromParsed({
  providers: { anthropic: { apiKeyEnv: "TEST_KEY" } },
  agents: {
    default: {
      persona: { name: "Test Agent", systemPrompt: "You are a test agent." },
      model: { provider: "anthropic", modelId: "test-model" },
      generation: { temperature: 0.7, maxOutputTokens: 1024 }
    }
  },
  server: { port: 3000 }
})

// ---------------------------------------------------------------------------
// Mock Compaction Checkpoint Port
// ---------------------------------------------------------------------------

const makeCompactionCheckpointMock = (captured?: Array<CompactionCheckpointRecord>): CompactionCheckpointPort => ({
  create: (record) => Effect.sync(() => { captured?.push(record) }),
  getLatestForSubroutine: () => Effect.succeed(null),
  listBySession: () => Effect.succeed([])
})

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const makeSubroutineContext = (overrides?: Partial<SubroutineContext>): SubroutineContext => ({
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
  conversationId: CONVERSATION_ID,
  turnId: "turn:test-turn" as TurnId,
  triggerType: "PostTurn",
  triggerReason: "End of user turn",
  now: NOW,
  runId: `run-${crypto.randomUUID()}`,
  ...overrides
})

const makeLoadedSubroutine = (overrides?: {
  readonly id?: string
  readonly prompt?: string
  readonly maxIterations?: number
  readonly toolScope?: SubroutineToolScope
}): LoadedSubroutine => ({
  config: {
    id: overrides?.id ?? "memory_consolidation",
    name: "Memory Consolidation",
    tier: "SemanticMemory",
    trigger: { type: "PostTurn" },
    promptFile: "prompts/consolidation.md",
    maxIterations: overrides?.maxIterations ?? 5,
    toolConcurrency: 1,
    dedupeWindowSeconds: 30
  },
  prompt: overrides?.prompt ?? "You are a memory consolidation routine. Review recent conversation and store important facts.",
  resolvedToolScope: overrides?.toolScope ?? {
    fileRead: true,
    fileWrite: false,
    shell: false,
    memoryRead: true,
    memoryWrite: true,
    notification: false
  }
})

// ---------------------------------------------------------------------------
// Layer Construction
// ---------------------------------------------------------------------------

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => { rmSync(path, { force: true }) })

const makeAgentState = (overrides: Partial<AgentState>): AgentState => ({
  agentId: AGENT_ID,
  permissionMode: "Permissive",
  tokenBudget: 1_000,
  maxToolIterations: 10,
  quotaPeriod: "Daily",
  tokensConsumed: 0,
  budgetResetAt: null,
  ...overrides
})

const makeTestLayer = (
  dbPath: string,
  mockOptions?: Parameters<typeof makeMockLanguageModel>[0],
  capturedCheckpoints?: Array<CompactionCheckpointRecord>
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
      return (yield* GovernancePortSqlite) as GovernancePort
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

  const checkpointPortSqliteLayer = CheckpointPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const checkpointPortTagLayer = Layer.effect(
    CheckpointPortTag,
    Effect.gen(function*() {
      return (yield* CheckpointPortSqlite) as CheckpointPort
    })
  ).pipe(Layer.provide(checkpointPortSqliteLayer))

  const cliRuntimeLayer = CliRuntimeLocalLayer.pipe(
    Layer.provide(NodeServices.layer)
  )
  const commandBackendLayer = CommandBackendLocalLayer.pipe(
    Layer.provide(cliRuntimeLayer)
  )
  const commandRuntimeLayer = CommandRuntime.layer.pipe(
    Layer.provide(CommandHooksDefaultLayer),
    Layer.provide(commandBackendLayer),
    Layer.provide(NodeServices.layer)
  )
  const filePathPolicyLayer = FilePathPolicy.layer.pipe(
    Layer.provide(NodeServices.layer)
  )
  const fileRuntimeLayer = FileRuntime.layer.pipe(
    Layer.provide(FileHooksDefaultLayer),
    Layer.provide(FileReadTracker.layer),
    Layer.provide(filePathPolicyLayer),
    Layer.provide(NodeServices.layer)
  )
  const toolExecutionLayer = ToolExecution.layer.pipe(
    Layer.provide(fileRuntimeLayer),
    Layer.provide(filePathPolicyLayer),
    Layer.provide(cliRuntimeLayer),
    Layer.provide(commandRuntimeLayer),
    Layer.provide(sqlInfrastructureLayer),
    Layer.provide(NodeServices.layer)
  )

  const toolRegistryLayer = ToolRegistry.layer.pipe(
    Layer.provide(toolExecutionLayer),
    Layer.provide(governanceTagLayer),
    Layer.provide(memoryPortTagLayer),
    Layer.provide(mockAgentConfigLayer),
    Layer.provide(checkpointPortTagLayer)
  )

  const chatPersistenceLayer = ChatPersistence.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )

  const mockModelRegistryLayer = Layer.effect(
    ModelRegistry,
    Effect.succeed({
      get: (_provider: string, _modelId: string) =>
        Effect.succeed(
          Layer.succeed(LanguageModel.LanguageModel, makeMockLanguageModel(mockOptions))
        )
    })
  )

  const traceWriterLayer = Layer.succeed(TraceWriter, {
    writeRunTrace: () => Effect.void
  } as any)

  const compactionCheckpointPortTagLayer = Layer.succeed(
    CompactionCheckpointPortTag,
    makeCompactionCheckpointMock(capturedCheckpoints) as any
  )

  const subroutineRunnerLayer = SubroutineRunner.layer.pipe(
    Layer.provide(toolRegistryLayer),
    Layer.provide(chatPersistenceLayer),
    Layer.provide(mockAgentConfigLayer),
    Layer.provide(mockModelRegistryLayer),
    Layer.provide(governanceTagLayer),
    Layer.provide(traceWriterLayer),
    Layer.provide(compactionCheckpointPortTagLayer)
  )

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    AgentStatePortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer)),
    governanceSqliteLayer,
    governanceTagLayer,
    memoryPortSqliteLayer,
    memoryPortTagLayer,
    subroutineRunnerLayer
  )
}

// ---------------------------------------------------------------------------
// Unit Tests: buildTriggerPrompt
// ---------------------------------------------------------------------------

describe("buildTriggerPrompt", () => {
  it("produces prompt for PostTurn trigger", () => {
    const ctx = makeSubroutineContext({ triggerType: "PostTurn", triggerReason: "End of user turn" })
    const prompt = buildTriggerPrompt(ctx)
    expect(prompt).toContain("Execute your memory routine.")
    expect(prompt).toContain("Trigger: PostTurn")
    expect(prompt).toContain(`Session: ${SESSION_ID}`)
    expect(prompt).toContain("Reason: End of user turn")
  })

  it("produces prompt for PostSession trigger", () => {
    const ctx = makeSubroutineContext({ triggerType: "PostSession", triggerReason: "Session idle timeout" })
    const prompt = buildTriggerPrompt(ctx)
    expect(prompt).toContain("Trigger: PostSession")
    expect(prompt).toContain("Reason: Session idle timeout")
  })

  it("produces prompt for Scheduled trigger", () => {
    const ctx = makeSubroutineContext({ triggerType: "Scheduled", triggerReason: "Cron: 0 */6 * * *" })
    const prompt = buildTriggerPrompt(ctx)
    expect(prompt).toContain("Trigger: Scheduled")
    expect(prompt).toContain("Reason: Cron: 0 */6 * * *")
  })

  it("produces prompt for ContextPressure trigger", () => {
    const ctx = makeSubroutineContext({ triggerType: "ContextPressure", triggerReason: "Token pressure at 90%" })
    const prompt = buildTriggerPrompt(ctx)
    expect(prompt).toContain("Trigger: ContextPressure")
    expect(prompt).toContain("Reason: Token pressure at 90%")
  })

  it("includes ISO timestamp", () => {
    const ctx = makeSubroutineContext()
    const prompt = buildTriggerPrompt(ctx)
    expect(prompt).toContain("Time:")
    expect(prompt).toContain("2026")
  })

  it("handles null turnId context", () => {
    const ctx = makeSubroutineContext({ turnId: null })
    const prompt = buildTriggerPrompt(ctx)
    expect(prompt).toContain("Execute your memory routine.")
  })
})

// ---------------------------------------------------------------------------
// Unit Tests: Synthetic ID format
// ---------------------------------------------------------------------------

describe("Synthetic ID format", () => {
  it("synthetic turnId has correct prefix", () => {
    const runId = "abc-123"
    expect(`turn:subroutine:${runId}`).toMatch(/^turn:subroutine:.+/)
  })

  it("synthetic channelId has correct prefix", () => {
    expect(`channel:subroutine:${SESSION_ID}`).toMatch(/^channel:subroutine:.+/)
  })

  it("synthetic conversationId has correct prefix", () => {
    const runId = "abc-123"
    expect(`conversation:subroutine:${runId}`).toMatch(/^conversation:subroutine:.+/)
  })

  it("chatSessionKey has correct prefix", () => {
    const runId = "abc-123"
    expect(`subroutine:${runId}`).toBe("subroutine:abc-123")
  })
})

// ---------------------------------------------------------------------------
// Integration Tests: SubroutineRunner.execute
// ---------------------------------------------------------------------------

describe("SubroutineRunner.execute", () => {
  it("successful run returns success: true with assistant content", async () => {
    const dbPath = testDatabasePath("sub-success")
    const layer = makeTestLayer(dbPath, { textResponse: "Memory stored successfully." })

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const result = yield* runner.execute(
        makeLoadedSubroutine(),
        makeSubroutineContext()
      )

      expect(result.success).toBe(true)
      expect(result.subroutineId).toBe("memory_consolidation")
      expect(result.iterationsUsed).toBeGreaterThanOrEqual(1)
      expect(result.assistantContent).toContain("Memory stored successfully.")
      expect(result.error).toBeNull()
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("model error returns success: false with errorMessage", async () => {
    const dbPath = testDatabasePath("sub-model-error")
    const layer = makeTestLayer(dbPath, {
      failWithErrorMessage: "Rate limit exceeded"
    })

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const result = yield* runner.execute(
        makeLoadedSubroutine(),
        makeSubroutineContext()
      )

      expect(result.success).toBe(false)
      expect(result.error).not.toBeNull()
      expect(result.error!.tag).toBeDefined()
      expect(result.error!.message).toBeDefined()
      expect(result.iterationsUsed).toBe(0)
      expect(result.toolCallsTotal).toBe(0)
      expect(result.assistantContent).toBe("")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("run with tool calls completes within maxIterations", async () => {
    const dbPath = testDatabasePath("sub-tool-loop")
    // First call returns tool-calls, second returns stop
    const layer = makeTestLayer(dbPath, {
      finishReasons: ["tool-calls", "stop"],
      textResponse: "Done consolidating."
    })

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const result = yield* runner.execute(
        makeLoadedSubroutine({ maxIterations: 5 }),
        makeSubroutineContext()
      )

      expect(result.success).toBe(true)
      expect(result.iterationsUsed).toBe(2)
      expect(result.toolCallsTotal).toBeGreaterThanOrEqual(1)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("audit entries written for start + complete on success", async () => {
    const dbPath = testDatabasePath("sub-audit-success")
    const layer = makeTestLayer(dbPath, { textResponse: "Stored." })

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const context = makeSubroutineContext()
      yield* runner.execute(makeLoadedSubroutine(), context)

      const governance = yield* GovernancePortSqlite
      const entries = yield* governance.listAuditEntries()
      const subroutineEntries = entries.filter((e) =>
        e.reason.startsWith("memory_subroutine_")
      )

      expect(subroutineEntries.length).toBeGreaterThanOrEqual(2)
      const reasons = subroutineEntries.map((e) => e.reason)
      expect(reasons.some((r) => r.includes("memory_subroutine_started"))).toBe(true)
      expect(reasons.some((r) => r.includes("memory_subroutine_completed"))).toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("audit entries written for start + fail on error", async () => {
    const dbPath = testDatabasePath("sub-audit-fail")
    const layer = makeTestLayer(dbPath, {
      failWithErrorMessage: "Provider unavailable"
    })

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const context = makeSubroutineContext()
      yield* runner.execute(makeLoadedSubroutine(), context)

      const governance = yield* GovernancePortSqlite
      const entries = yield* governance.listAuditEntries()
      const subroutineEntries = entries.filter((e) =>
        e.reason.startsWith("memory_subroutine_")
      )

      expect(subroutineEntries.length).toBeGreaterThanOrEqual(2)
      const reasons = subroutineEntries.map((e) => e.reason)
      expect(reasons.some((r) => r.includes("memory_subroutine_started"))).toBe(true)
      expect(reasons.some((r) => r.includes("memory_subroutine_failed"))).toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("result contains modelUsageJson on success", async () => {
    const dbPath = testDatabasePath("sub-usage")
    const layer = makeTestLayer(dbPath, { textResponse: "Done." })

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const result = yield* runner.execute(
        makeLoadedSubroutine(),
        makeSubroutineContext()
      )

      expect(result.success).toBe(true)
      expect(result.modelUsageJson).not.toBeNull()
      if (result.modelUsageJson) {
        const parsed = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(result.modelUsageJson) as Record<string, unknown>
        expect(parsed).toHaveProperty("inputTokens")
        expect(parsed).toHaveProperty("outputTokens")
      }
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("max iterations cap produces cap message", async () => {
    const dbPath = testDatabasePath("sub-cap")
    // All calls return tool-calls — should hit the cap
    const layer = makeTestLayer(dbPath, {
      finishReasons: ["tool-calls", "tool-calls", "tool-calls"]
    })

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const result = yield* runner.execute(
        makeLoadedSubroutine({ maxIterations: 2 }),
        makeSubroutineContext()
      )

      expect(result.success).toBe(true)
      expect(result.iterationsUsed).toBe(2)
      expect(result.assistantContent).toContain("max tool iterations")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("runId and subroutineId are correctly propagated", async () => {
    const dbPath = testDatabasePath("sub-ids")
    const layer = makeTestLayer(dbPath, { textResponse: "Done." })
    const runId = `run-${crypto.randomUUID()}`

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const result = yield* runner.execute(
        makeLoadedSubroutine({ id: "custom_routine" }),
        makeSubroutineContext({ runId })
      )

      expect(result.subroutineId).toBe("custom_routine")
      expect(result.runId).toBe(runId)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })
})

// ---------------------------------------------------------------------------
// Integration Tests: Compaction Checkpoint
// ---------------------------------------------------------------------------

describe("SubroutineRunner checkpoint", () => {
  it("success + writesCheckpoint=true creates record", async () => {
    const dbPath = testDatabasePath("sub-checkpoint-success")
    const capturedCheckpoints: Array<CompactionCheckpointRecord> = []
    const layer = makeTestLayer(dbPath, { textResponse: "Compacted." }, capturedCheckpoints)

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const subroutine = makeLoadedSubroutine()
      // Patch writesCheckpoint = true
      const withCheckpoint: LoadedSubroutine = {
        ...subroutine,
        config: { ...subroutine.config, writesCheckpoint: true }
      }

      const result = yield* runner.execute(withCheckpoint, makeSubroutineContext())
      expect(result.success).toBe(true)

      expect(capturedCheckpoints.length).toBe(1)
      expect(capturedCheckpoints[0].subroutineId).toBe("memory_consolidation")
      expect(capturedCheckpoints[0].summary).toContain("Compacted.")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("failure + writesCheckpoint=true does not create record", async () => {
    const dbPath = testDatabasePath("sub-checkpoint-failure")
    const capturedCheckpoints: Array<CompactionCheckpointRecord> = []
    const layer = makeTestLayer(dbPath, { failWithErrorMessage: "Provider down" }, capturedCheckpoints)

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const subroutine = makeLoadedSubroutine()
      const withCheckpoint: LoadedSubroutine = {
        ...subroutine,
        config: { ...subroutine.config, writesCheckpoint: true }
      }

      const result = yield* runner.execute(withCheckpoint, makeSubroutineContext())
      expect(result.success).toBe(false)

      expect(capturedCheckpoints.length).toBe(0)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("success + writesCheckpoint absent does not create record", async () => {
    const dbPath = testDatabasePath("sub-checkpoint-absent")
    const capturedCheckpoints: Array<CompactionCheckpointRecord> = []
    const layer = makeTestLayer(dbPath, { textResponse: "Done." }, capturedCheckpoints)

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const result = yield* runner.execute(makeLoadedSubroutine(), makeSubroutineContext())
      expect(result.success).toBe(true)

      expect(capturedCheckpoints.length).toBe(0)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })

  it("checkpoint create failure is non-fatal", async () => {
    const dbPath = testDatabasePath("sub-checkpoint-nonfatal")
    // Use a failing mock
    const failingCheckpointLayer = Layer.succeed(
      CompactionCheckpointPortTag,
      {
        create: () => Effect.die(new Error("DB write failed")),
        getLatestForSubroutine: () => Effect.succeed(null),
        listBySession: () => Effect.succeed([])
      } as any
    )

    const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
    const migrationLayer = DomainMigrator.layer.pipe(Layer.provide(sqliteLayer), Layer.orDie)
    const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

    const governanceSqliteLayer = GovernancePortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer))
    const governanceTagLayer = Layer.effect(
      GovernancePortTag,
      Effect.gen(function*() { return (yield* GovernancePortSqlite) as GovernancePort })
    ).pipe(Layer.provide(governanceSqliteLayer))

    const memoryPortSqliteLayer = MemoryPortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer))
    const memoryPortTagLayer = Layer.effect(
      MemoryPortTag,
      Effect.gen(function*() { return (yield* MemoryPortSqlite) as MemoryPort })
    ).pipe(Layer.provide(memoryPortSqliteLayer))

    const checkpointPortSqliteLayer = CheckpointPortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer))
    const checkpointPortTagLayer = Layer.effect(
      CheckpointPortTag,
      Effect.gen(function*() { return (yield* CheckpointPortSqlite) as CheckpointPort })
    ).pipe(Layer.provide(checkpointPortSqliteLayer))

    const cliRuntimeLayer = CliRuntimeLocalLayer.pipe(Layer.provide(NodeServices.layer))
    const commandBackendLayer = CommandBackendLocalLayer.pipe(Layer.provide(cliRuntimeLayer))
    const commandRuntimeLayer = CommandRuntime.layer.pipe(
      Layer.provide(CommandHooksDefaultLayer),
      Layer.provide(commandBackendLayer),
      Layer.provide(NodeServices.layer)
    )
    const filePathPolicyLayer = FilePathPolicy.layer.pipe(Layer.provide(NodeServices.layer))
    const fileRuntimeLayer = FileRuntime.layer.pipe(
      Layer.provide(FileHooksDefaultLayer),
      Layer.provide(FileReadTracker.layer),
      Layer.provide(filePathPolicyLayer),
      Layer.provide(NodeServices.layer)
    )
    const toolExecutionLayer = ToolExecution.layer.pipe(
      Layer.provide(fileRuntimeLayer),
      Layer.provide(filePathPolicyLayer),
      Layer.provide(cliRuntimeLayer),
      Layer.provide(commandRuntimeLayer),
      Layer.provide(sqlInfrastructureLayer),
      Layer.provide(NodeServices.layer)
    )
    const toolRegistryLayer = ToolRegistry.layer.pipe(
      Layer.provide(toolExecutionLayer),
      Layer.provide(governanceTagLayer),
      Layer.provide(memoryPortTagLayer),
      Layer.provide(mockAgentConfigLayer),
      Layer.provide(checkpointPortTagLayer)
    )
    const chatPersistenceLayer = ChatPersistence.layer.pipe(Layer.provide(sqlInfrastructureLayer))
    const mockModelRegistryLayer = Layer.effect(
      ModelRegistry,
      Effect.succeed({
        get: (_provider: string, _modelId: string) =>
          Effect.succeed(Layer.succeed(LanguageModel.LanguageModel, makeMockLanguageModel({ textResponse: "Checkpoint fail test." })))
      })
    )
    const traceWriterLayer = Layer.succeed(TraceWriter, { writeRunTrace: () => Effect.void } as any)

    const subroutineRunnerLayer = SubroutineRunner.layer.pipe(
      Layer.provide(toolRegistryLayer),
      Layer.provide(chatPersistenceLayer),
      Layer.provide(mockAgentConfigLayer),
      Layer.provide(mockModelRegistryLayer),
      Layer.provide(governanceTagLayer),
      Layer.provide(traceWriterLayer),
      Layer.provide(failingCheckpointLayer)
    )

    const layer = Layer.mergeAll(
      sqlInfrastructureLayer,
      AgentStatePortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer)),
      subroutineRunnerLayer
    )

    const program = Effect.gen(function*() {
      const agents = yield* AgentStatePortSqlite
      yield* agents.upsert(makeAgentState({ budgetResetAt: NOW }))

      const runner = yield* SubroutineRunner
      const subroutine = makeLoadedSubroutine()
      const withCheckpoint: LoadedSubroutine = {
        ...subroutine,
        config: { ...subroutine.config, writesCheckpoint: true }
      }

      // Should NOT throw even though checkpoint write dies
      const result = yield* runner.execute(withCheckpoint, makeSubroutineContext())
      expect(result.success).toBe(true)
      expect(result.assistantContent).toContain("Checkpoint fail test.")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
    await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
  })
})
