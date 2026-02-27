# Full Agentic Slice Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable multi-step tool calling with memory tools so the agent can autonomously store, retrieve, and forget memories across recursive LLM calls within a single turn.

**Architecture:** Three memory tools added to `ToolRegistry`, governed by `runGovernedTool`. The single `chat.generateText()` call in `TurnProcessingWorkflow` is replaced with a recursive `Effect.suspend` loop that re-calls the model when `finishReason === "tool-calls"`. New stream events give the client real-time visibility into tool loop iterations. A `maxToolIterations` field on `AgentState` caps recursion depth.

**Tech Stack:** Effect (Schema, ServiceMap, Activity, Workflow, Chat, Tool, Toolkit), SQLite, Bun, Vitest

---

### Task 1: Add `maxToolIterations` to AgentState

**Files:**
- Modify: `packages/domain/src/ports.ts:50-57`
- Modify: `packages/server/src/AgentStatePortSqlite.ts:9-16,86-115,187-194`
- Modify: `packages/server/src/persistence/DomainMigrator.ts` (add migration `0008`)
- Test: `packages/server/test/AgentStatePortSqlite.test.ts` (new test case)

**Step 1: Add field to `AgentState` interface**

In `packages/domain/src/ports.ts`, add `maxToolIterations` to the `AgentState` interface:

```typescript
export interface AgentState {
  readonly agentId: AgentId
  readonly permissionMode: PermissionMode
  readonly tokenBudget: number
  readonly quotaPeriod: QuotaPeriod
  readonly tokensConsumed: number
  readonly budgetResetAt: Instant | null
  readonly maxToolIterations: number
}
```

**Step 2: Add migration `0008_agent_max_tool_iterations`**

In `packages/server/src/persistence/DomainMigrator.ts`, add after the `0007` entry in `fromRecord`:

```typescript
"0008_agent_max_tool_iterations": Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE agents ADD COLUMN max_tool_iterations INTEGER NOT NULL DEFAULT 10
  `.unprepared.pipe(Effect.catch(() => Effect.void))
})
```

**Step 3: Update `AgentStatePortSqlite`**

In `packages/server/src/AgentStatePortSqlite.ts`:

a) Add `max_tool_iterations` to `AgentStateRowSchema`:

```typescript
const AgentStateRowSchema = Schema.Struct({
  agent_id: Schema.String,
  permission_mode: PermissionMode,
  token_budget: Schema.Number,
  quota_period: QuotaPeriod,
  tokens_consumed: Schema.Number,
  budget_reset_at: Schema.Union([Schema.String, Schema.Null]),
  max_tool_iterations: Schema.Number
})
```

b) Add `max_tool_iterations` to the SELECT queries in `findAgentStateById` and `findAllAgentStates` (add `, max_tool_iterations` to the column list).

c) Update `upsert` INSERT/ON CONFLICT to include `max_tool_iterations`:

```typescript
yield* sql`
  INSERT INTO agents (
    agent_id, permission_mode, token_budget, quota_period,
    tokens_consumed, budget_reset_at, max_tool_iterations, updated_at
  ) VALUES (
    ${agentState.agentId}, ${agentState.permissionMode},
    ${agentState.tokenBudget}, ${agentState.quotaPeriod},
    ${agentState.tokensConsumed}, ${toSqlInstant(agentState.budgetResetAt)},
    ${agentState.maxToolIterations}, CURRENT_TIMESTAMP
  )
  ON CONFLICT(agent_id) DO UPDATE SET
    permission_mode = excluded.permission_mode,
    token_budget = excluded.token_budget,
    quota_period = excluded.quota_period,
    tokens_consumed = excluded.tokens_consumed,
    budget_reset_at = excluded.budget_reset_at,
    max_tool_iterations = excluded.max_tool_iterations,
    updated_at = CURRENT_TIMESTAMP
`.unprepared
```

d) Also add `max_tool_iterations` to the UPDATE inside `consumeTokenBudget`.

e) Update `decodeAgentStateRow`:

```typescript
const decodeAgentStateRow = (row: AgentStateRow): AgentState => ({
  agentId: row.agent_id as AgentId,
  permissionMode: row.permission_mode,
  tokenBudget: row.token_budget,
  quotaPeriod: row.quota_period,
  tokensConsumed: row.tokens_consumed,
  budgetResetAt: fromSqlInstant(row.budget_reset_at),
  maxToolIterations: row.max_tool_iterations
})
```

**Step 4: Fix all `makeAgentState` helpers across test files**

Every test file that constructs an `AgentState` object needs the new field. Search for all `makeAgentState` functions and add `maxToolIterations: 10` as the default. Files to update:

- `packages/server/test/ToolRegistry.test.ts` (line 226)
- `packages/server/test/GovernanceRoutes.e2e.test.ts` (line 250)
- `packages/server/test/TurnProcessingWorkflow.e2e.test.ts` (line 542)
- `packages/server/src/ChannelCore.ts` (line 37, the `ensureAgentState` literal)

**Step 5: Run typecheck and tests**

Run: `bun run check && bun run test`
Expected: All pass. The new column has DEFAULT 10 so existing data migrates cleanly.

**Step 6: Commit**

```bash
git add packages/domain/src/ports.ts packages/server/src/AgentStatePortSqlite.ts \
  packages/server/src/persistence/DomainMigrator.ts packages/server/src/ChannelCore.ts \
  packages/server/test/ToolRegistry.test.ts packages/server/test/GovernanceRoutes.e2e.test.ts \
  packages/server/test/TurnProcessingWorkflow.e2e.test.ts
git commit -m "feat: add maxToolIterations field to AgentState"
```

---

### Task 2: Add new stream event types

**Files:**
- Modify: `packages/domain/src/events.ts`

**Step 1: Add `IterationCompletedEvent` class and update `TurnCompletedEvent`**

In `packages/domain/src/events.ts`, add the new event class before the `TurnStreamEvent` union, and add `iterationsUsed` + `toolCallsTotal` to `TurnCompletedEvent`:

```typescript
export class IterationCompletedEvent extends Schema.Class<IterationCompletedEvent>(
  "IterationCompletedEvent"
)({
  type: Schema.Literal("iteration.completed"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  iteration: Schema.Number,
  toolCallCount: Schema.Number
}) {}
```

Update `TurnCompletedEvent` to add two fields:

```typescript
export class TurnCompletedEvent extends Schema.Class<TurnCompletedEvent>(
  "TurnCompletedEvent"
)({
  type: Schema.Literal("turn.completed"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  accepted: Schema.Boolean,
  auditReasonCode: Schema.String,
  modelFinishReason: Schema.Union([ModelFinishReason, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  iterationsUsed: Schema.Number,
  toolCallsTotal: Schema.Number
}) {}
```

Add `IterationCompletedEvent` to the `TurnStreamEvent` union:

```typescript
export const TurnStreamEvent = Schema.Union([
  TurnStartedEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  IterationCompletedEvent,
  TurnCompletedEvent,
  TurnFailedEvent
])
```

**Step 2: Run typecheck**

Run: `bun run check`
Expected: Type errors in `TurnProcessingRuntime.ts` (missing `iterationsUsed`, `toolCallsTotal` on `turn.completed`). These will be fixed in Task 4.

**Step 3: Commit**

```bash
git add packages/domain/src/events.ts
git commit -m "feat: add iteration.completed event and loop metadata to turn.completed"
```

---

### Task 3: Add memory tool definitions and handlers to ToolRegistry

**Files:**
- Modify: `packages/server/src/ai/ToolRegistry.ts`
- Test: `packages/server/test/ToolRegistry.test.ts`

**Step 1: Write failing tests for memory tools**

Add these test cases to `packages/server/test/ToolRegistry.test.ts`:

```typescript
it("store_memory tool stores and returns memoryId", async () => {
  const dbPath = testDatabasePath("tool-registry-store-memory")
  const layer = makeToolRegistryLayer(dbPath)
  const agentId = "agent:store" as AgentId

  const program = Effect.gen(function*() {
    const agents = yield* AgentStatePortSqlite
    yield* agents.upsert(makeAgentState({
      agentId,
      permissionMode: "Standard",
      budgetResetAt: NOW
    }))

    const output = yield* invokeTool(agentId, "store_memory", {
      content: "User prefers dark mode",
      tags: ["preference", "ui"]
    })
    const parsed = JSON.parse(output) as any
    expect(parsed[0]).toHaveProperty("memoryId")
    expect(parsed[0].stored).toBe(true)
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(cleanupDatabase(dbPath))
  )
  await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
})

it("retrieve_memories tool returns matching memories", async () => {
  const dbPath = testDatabasePath("tool-registry-retrieve-memories")
  const layer = makeToolRegistryLayer(dbPath)
  const agentId = "agent:retrieve" as AgentId

  const program = Effect.gen(function*() {
    const agents = yield* AgentStatePortSqlite
    const memoryPort = yield* MemoryPortSqlite
    yield* agents.upsert(makeAgentState({
      agentId,
      permissionMode: "Standard",
      budgetResetAt: NOW
    }))

    yield* memoryPort.encode(agentId, [{
      tier: "SemanticMemory",
      scope: "GlobalScope",
      source: "AgentSource",
      content: "User prefers dark mode"
    }], NOW)

    const output = yield* invokeTool(agentId, "retrieve_memories", {
      query: "dark mode preference"
    })
    const parsed = JSON.parse(output) as any
    expect(parsed[0].memories.length).toBeGreaterThan(0)
    expect(parsed[0].memories[0].content).toContain("dark mode")
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(cleanupDatabase(dbPath))
  )
  await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
})

it("forget_memories tool deletes by memoryIds", async () => {
  const dbPath = testDatabasePath("tool-registry-forget-memories")
  const layer = makeToolRegistryLayer(dbPath)
  const agentId = "agent:forget" as AgentId

  const program = Effect.gen(function*() {
    const agents = yield* AgentStatePortSqlite
    const memoryPort = yield* MemoryPortSqlite
    yield* agents.upsert(makeAgentState({
      agentId,
      permissionMode: "Standard",
      budgetResetAt: NOW
    }))

    const ids = yield* memoryPort.encode(agentId, [{
      tier: "SemanticMemory",
      scope: "GlobalScope",
      source: "AgentSource",
      content: "Ephemeral fact"
    }], NOW)

    const output = yield* invokeTool(agentId, "forget_memories", {
      memoryIds: ids
    })
    const parsed = JSON.parse(output) as any
    expect(parsed[0].forgotten).toBe(1)

    // Verify it's gone
    const remaining = yield* memoryPort.listAll(agentId, { limit: 10 })
    expect(remaining).toHaveLength(0)
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(cleanupDatabase(dbPath))
  )
  await Effect.runPromise(program as Effect.Effect<unknown, unknown, never>)
})
```

You'll also need to add `MemoryPortSqlite` import and add it to `makeToolRegistryLayer`. Add `import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"` to the test imports, and in `makeToolRegistryLayer`:

```typescript
const memoryPortSqliteLayer = MemoryPortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)
```

And merge it into the returned layer:

```typescript
return Layer.mergeAll(
  sqlInfrastructureLayer,
  AgentStatePortSqlite.layer.pipe(Layer.provide(sqlInfrastructureLayer)),
  governanceSqliteLayer,
  governanceTagLayer,
  memoryPortSqliteLayer,
  ToolRegistry.layer.pipe(Layer.provide(Layer.mergeAll(governanceTagLayer, memoryPortSqliteLayer)))
)
```

Also update `invokeTool`'s type union to include the new tool names:

```typescript
toolName: "echo_text" | "math_calculate" | "time_now" | "store_memory" | "retrieve_memories" | "forget_memories",
```

**Step 2: Run tests to verify they fail**

Run: `bun run test -- packages/server/test/ToolRegistry.test.ts`
Expected: FAIL — tool names not in toolkit

**Step 3: Add tool definitions and handlers to ToolRegistry**

In `packages/server/src/ai/ToolRegistry.ts`:

a) Add import for MemoryPortSqlite:

```typescript
import { MemoryPortSqlite } from "../MemoryPortSqlite.js"
```

b) Add tool definitions after `EchoTextTool`:

```typescript
const StoreMemoryTool = Tool.make("store_memory", {
  description: "Store a semantic memory for later retrieval. Use this to remember facts, preferences, or important information about the user.",
  parameters: Schema.Struct({
    content: Schema.String,
    tags: Schema.Array(Schema.String)
  }),
  success: Schema.Struct({
    memoryId: Schema.String,
    stored: Schema.Boolean
  }),
  failure: ToolFailure
})

const RetrieveMemoriesTool = Tool.make("retrieve_memories", {
  description: "Search stored memories by natural language query. Returns the most relevant memories.",
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optionalWith(Schema.Number, { default: () => 5 })
  }),
  success: Schema.Struct({
    memories: Schema.Array(Schema.Struct({
      memoryId: Schema.String,
      content: Schema.String,
      tags: Schema.String
    }))
  }),
  failure: ToolFailure
})

const ForgetMemoriesTool = Tool.make("forget_memories", {
  description: "Remove specific memories by their IDs.",
  parameters: Schema.Struct({
    memoryIds: Schema.Array(Schema.String)
  }),
  success: Schema.Struct({
    forgotten: Schema.Number
  }),
  failure: ToolFailure
})
```

c) Update `SafeToolkit`:

```typescript
const SafeToolkit = Toolkit.make(
  TimeNowTool, MathCalculateTool, EchoTextTool,
  StoreMemoryTool, RetrieveMemoriesTool, ForgetMemoriesTool
)
```

d) Update `make` to yield MemoryPortSqlite, and add handlers in `makeToolkit`. Add after `const governance = yield* GovernancePortTag`:

```typescript
const memoryPort = yield* MemoryPortSqlite
```

Then add the three new handlers inside `SafeToolkit.of({...})`:

```typescript
"store_memory": ({ content, tags }) =>
  runGovernedTool(
    context,
    "store_memory" as ToolName,
    { content, tags },
    Effect.gen(function*() {
      const ids = yield* memoryPort.encode(
        context.agentId,
        [{
          tier: "SemanticMemory",
          scope: "GlobalScope",
          source: "AgentSource",
          content,
          metadataJson: JSON.stringify({ tags }),
          generatedByTurnId: context.turnId as string,
          sessionId: context.sessionId as string
        }],
        context.now
      )
      return { memoryId: ids[0] as string, stored: true }
    })
  ),
"retrieve_memories": ({ query, limit }) =>
  runGovernedTool(
    context,
    "retrieve_memories" as ToolName,
    { query, limit },
    Effect.gen(function*() {
      const rows = yield* memoryPort.retrieve(context.agentId, {
        query,
        tier: "SemanticMemory",
        limit: limit ?? 5
      })
      return {
        memories: rows.map((row) => ({
          memoryId: row.memoryItemId,
          content: row.content,
          tags: row.metadataJson ?? ""
        }))
      }
    })
  ),
"forget_memories": ({ memoryIds }) =>
  runGovernedTool(
    context,
    "forget_memories" as ToolName,
    { memoryIds },
    Effect.gen(function*() {
      const count = yield* memoryPort.forget(
        context.agentId,
        { itemIds: memoryIds }
      )
      return { forgotten: count }
    })
  )
```

e) Update the `ToolRegistry.make` dependencies — the `make` Effect now requires `MemoryPortSqlite`:

The `make` body already uses `Effect.gen(function*() { ... })` with `yield* GovernancePortTag`. Just add `const memoryPort = yield* MemoryPortSqlite` right after line 80.

f) Update `ToolRegistry.layer` to provide `MemoryPortSqlite`:

The `ToolRegistry.layer` is `Layer.effect(this, this.make)`. The `make` now requires `MemoryPortSqlite` in addition to `GovernancePortTag`. The layer composition in `server.ts` already provides both — but check that `MemoryPortSqlite` is in the dependency chain. If not, it'll be a type error that tells you to add it.

**Step 4: Add tool definitions to migration seed data**

In `packages/server/src/persistence/DomainMigrator.ts`, add to the `0008_agent_max_tool_iterations` migration (or create a new `0009` — better to keep it in `0008` since it hasn't been released):

Actually, add a separate migration `0009_memory_tool_definitions`:

```typescript
"0009_memory_tool_definitions": Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const now = new Date().toISOString()

  yield* sql`
    INSERT OR IGNORE INTO tool_definitions (
      tool_definition_id, tool_name, source_kind,
      integration_id, is_safe_standard, created_at
    ) VALUES
      ('tooldef:store_memory:v1', 'store_memory', 'BuiltIn', NULL, 1, ${now}),
      ('tooldef:retrieve_memories:v1', 'retrieve_memories', 'BuiltIn', NULL, 1, ${now}),
      ('tooldef:forget_memories:v1', 'forget_memories', 'BuiltIn', NULL, 1, ${now})
  `.unprepared
})
```

**Step 5: Run tests**

Run: `bun run test -- packages/server/test/ToolRegistry.test.ts`
Expected: All pass including new memory tool tests.

**Step 6: Run full typecheck and test suite**

Run: `bun run check && bun run test`
Expected: Type errors remain in `TurnProcessingRuntime.ts` from Task 2 changes (expected — fixed in Task 4). All other tests pass.

**Step 7: Commit**

```bash
git add packages/server/src/ai/ToolRegistry.ts packages/server/test/ToolRegistry.test.ts \
  packages/server/src/persistence/DomainMigrator.ts
git commit -m "feat: add store_memory, retrieve_memories, forget_memories tools"
```

---

### Task 4: Implement recursive tool loop in TurnProcessingWorkflow

**Files:**
- Modify: `packages/server/src/turn/TurnProcessingWorkflow.ts:185-244`
- Modify: `packages/server/src/turn/TurnProcessingRuntime.ts:64-129`

**Step 1: Add the recursive `processWithToolLoop` function**

In `packages/server/src/turn/TurnProcessingWorkflow.ts`, add this helper function before the workflow layer (before line 97):

```typescript
interface ToolLoopResult {
  readonly response: LanguageModel.GenerateTextResponse
  readonly iterationsUsed: number
  readonly toolCallsTotal: number
}

const processWithToolLoop = (
  chat: Chat.Chat,
  toolkitBundle: { readonly toolkit: any; readonly handlerLayer: Layer.Layer<any> },
  maxIterations: number
): Effect.Effect<ToolLoopResult, unknown> =>
  Effect.suspend(function loop(
    iteration: number = 0,
    toolCallsTotal: number = 0
  ): Effect.Effect<ToolLoopResult, unknown> {
    if (iteration >= maxIterations) {
      // Return a synthetic response indicating max iterations reached
      return Effect.succeed({
        response: new LanguageModel.GenerateTextResponse([
          Response.makePart("text", {
            text: `I've completed ${iteration} tool-calling steps and reached the maximum. Here is what I found so far.`
          }),
          Response.makePart("finish", {
            reason: "stop" as const,
            usage: new Response.Usage({
              inputTokens: { uncached: 0, total: 0, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 0, text: 0, reasoning: undefined }
            }),
            response: undefined
          })
        ]),
        iterationsUsed: iteration,
        toolCallsTotal
      })
    }

    return chat.generateText({
      prompt: iteration === 0 ? undefined : Prompt.empty,
      toolkit: toolkitBundle.toolkit
    }).pipe(
      Effect.provide(toolkitBundle.handlerLayer),
      Effect.flatMap((response) => {
        const toolCallParts = response.content.filter((p) => p.type === "tool-call")
        const newToolCalls = toolCallsTotal + toolCallParts.length

        if (response.finishReason === "tool-calls") {
          return loop(iteration + 1, newToolCalls)
        }

        return Effect.succeed({
          response,
          iterationsUsed: iteration + 1,
          toolCallsTotal: newToolCalls
        })
      })
    )
  })
```

You'll need to add imports at the top of the file:

```typescript
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Response from "effect/unstable/ai/Response"
```

**Step 2: Replace the single `generateText` call with the loop**

In the workflow body (around lines 185-244), replace the `modelResponse` block. The current code is:

```typescript
const modelResponse = yield* Effect.gen(function*() {
  const profile = yield* agentConfig.getAgent(payload.agentId)
  const lmLayer = yield* modelRegistry.get(...)
  const toolkitBundle = yield* toolRegistry.makeToolkit(...)
  const chat = yield* chatPersistence.getOrCreate(payload.sessionId)
  // ... system prompt setup ...
  return yield* chat.generateText({...}).pipe(...)
}).pipe(Effect.catch(...))
```

Replace it with:

```typescript
const agentState = yield* agentStatePort.get(payload.agentId as AgentId)
const maxToolIterations = agentState?.maxToolIterations ?? 10

const loopResult = yield* Effect.gen(function*() {
  const profile = yield* agentConfig.getAgent(payload.agentId)
  const lmLayer = yield* modelRegistry.get(
    profile.model.provider,
    profile.model.modelId
  )

  const toolkitBundle = yield* toolRegistry.makeToolkit({
    agentId: payload.agentId as AgentId,
    sessionId: payload.sessionId as SessionId,
    conversationId: payload.conversationId as ConversationId,
    turnId: payload.turnId as TurnId,
    now: payload.createdAt
  })

  const chat = yield* chatPersistence.getOrCreate(payload.sessionId)

  // Build system prompt: base persona + fresh memory context each turn
  const baseSystemPrompt = profile.persona.systemPrompt
  const systemPromptWithMemory = semanticMemories.length > 0
    ? baseSystemPrompt
      + "\n\n[Relevant Memory]\n"
      + semanticMemories.map((m) => `- ${m.content}`).join("\n")
    : baseSystemPrompt

  const currentHistory = yield* Ref.get(chat.history)
  const withSystem = Prompt.setSystem(currentHistory, systemPromptWithMemory)
  yield* Ref.set(chat.history, withSystem)

  // Prepend user message to chat for first iteration
  const userPrompt = toPromptText(payload.content, payload.contentBlocks)
  yield* Ref.update(chat.history, (h) => Prompt.addUserMessage(h, userPrompt))

  return yield* processWithToolLoop(
    chat,
    { toolkit: toolkitBundle.toolkit, handlerLayer: Layer.merge(toolkitBundle.handlerLayer, lmLayer) },
    maxToolIterations
  )
}).pipe(
  Effect.catch((error) =>
    writeAuditEntry(
      governancePort,
      payload,
      "Deny",
      "turn_processing_model_error"
    ).pipe(
      Effect.andThen(
        Effect.fail(
          new TurnModelFailure({
            turnId: payload.turnId,
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      )
    )
  )
)

const modelResponse = loopResult.response
```

Note: The loop's first iteration uses `undefined` for `prompt` (the user message was already added to `chat.history` via `Ref.update`). Subsequent iterations use `Prompt.empty` since Chat's `Ref<Prompt>` auto-appends each response.

Keep the existing `assistantResult` encoding block and subsequent Activities unchanged — they work on `modelResponse` which is now `loopResult.response`.

**Step 3: Update `ProcessTurnResult` to include loop metadata**

In `TurnProcessingWorkflow.ts`, add fields to `ProcessTurnResult`:

```typescript
export const ProcessTurnResult = Schema.Struct({
  turnId: Schema.String,
  accepted: Schema.Boolean,
  auditReasonCode: TurnAuditReasonCode,
  assistantContent: Schema.String,
  assistantContentBlocks: Schema.Array(ContentBlockSchema),
  modelFinishReason: Schema.Union([ModelFinishReason, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  iterationsUsed: Schema.Number,
  toolCallsTotal: Schema.Number
})
```

Update the return value at the end of the workflow to include:

```typescript
return {
  turnId: payload.turnId,
  accepted: true,
  auditReasonCode: "turn_processing_accepted",
  assistantContent: assistantResult.assistantContent,
  assistantContentBlocks: assistantResult.assistantContentBlocks,
  modelFinishReason,
  modelUsageJson: assistantResult.modelUsageJson,
  iterationsUsed: loopResult.iterationsUsed,
  toolCallsTotal: loopResult.toolCallsTotal
} as const
```

**Step 4: Update `TurnProcessingRuntime` to emit loop metadata**

In `packages/server/src/turn/TurnProcessingRuntime.ts`, update the `turn.completed` event in `toSuccessEvents`:

```typescript
events.push({
  type: "turn.completed",
  sequence,
  turnId: input.turnId,
  sessionId: input.sessionId,
  accepted: result.accepted,
  auditReasonCode: result.auditReasonCode,
  modelFinishReason: result.modelFinishReason,
  modelUsageJson: result.modelUsageJson,
  iterationsUsed: result.iterationsUsed,
  toolCallsTotal: result.toolCallsTotal
})
```

**Step 5: Run typecheck**

Run: `bun run check`
Expected: Clean — all type errors from Task 2 now resolved.

**Step 6: Commit**

```bash
git add packages/server/src/turn/TurnProcessingWorkflow.ts \
  packages/server/src/turn/TurnProcessingRuntime.ts
git commit -m "feat: recursive tool loop with Effect.suspend in TurnProcessingWorkflow"
```

---

### Task 5: Add tool loop e2e test

**Files:**
- Modify: `packages/server/test/TurnProcessingWorkflow.e2e.test.ts`

**Step 1: Write test for multi-iteration tool loop**

Add a new test case that uses a mock language model which returns `finishReason: "tool-calls"` on the first call and `"stop"` on the second:

```typescript
it.effect("loops when model returns tool-calls finishReason", () => {
  const dbPath = testDatabasePath("turn-tool-loop")
  let callCount = 0
  const mockLm: LanguageModel.Service = {
    generateText: (_options: any) => {
      callCount++
      if (callCount === 1) {
        // First call: model wants to call a tool
        return Effect.succeed(
          new LanguageModel.GenerateTextResponse([
            Response.makePart("tool-call", {
              id: "call_echo_loop",
              name: "echo.text",
              params: { text: "looping" },
              providerExecuted: false
            }),
            Response.makePart("tool-result", {
              id: "call_echo_loop",
              name: "echo.text",
              isFailure: false,
              result: { text: "looping" },
              encodedResult: { text: "looping" },
              providerExecuted: false,
              preliminary: false
            }),
            Response.makePart("finish", {
              reason: "tool-calls",
              usage: new Response.Usage({
                inputTokens: { uncached: 5, total: 5, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 3, text: 3, reasoning: undefined }
              }),
              response: undefined
            })
          ])
        ) as any
      }
      // Second call: model responds with text
      return Effect.succeed(
        new LanguageModel.GenerateTextResponse([
          Response.makePart("text", { text: "done after loop" }),
          Response.makePart("finish", {
            reason: "stop",
            usage: new Response.Usage({
              inputTokens: { uncached: 10, total: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 6, text: 6, reasoning: undefined }
            }),
            response: undefined
          })
        ])
      ) as any
    },
    streamText: (_options: any) => Stream.empty as any,
    generateObject: (_options: any) => Effect.die(new Error("not implemented")) as any
  }

  const layer = makeTurnProcessingLayerWithModel(dbPath, mockLm)

  return Effect.gen(function*() {
    const agentPort = yield* AgentStatePortSqlite
    const sessionPort = yield* SessionTurnPortSqlite
    const runtime = yield* TurnProcessingRuntime

    const now = instant("2026-02-24T12:00:00.000Z")
    yield* agentPort.upsert(makeAgentState({
      agentId: "agent:loop" as AgentId,
      tokenBudget: 200,
      budgetResetAt: DateTime.add(now, { hours: 1 })
    }))
    yield* sessionPort.startSession(makeSessionState({
      sessionId: "session:loop" as SessionId,
      conversationId: "conversation:loop" as ConversationId,
      tokenCapacity: 500,
      tokensUsed: 0
    }))

    const result = yield* runtime.processTurn(makeTurnPayload({
      turnId: "turn:loop" as TurnId,
      agentId: "agent:loop" as AgentId,
      sessionId: "session:loop" as SessionId,
      conversationId: "conversation:loop" as ConversationId,
      createdAt: now,
      inputTokens: 10,
      content: "trigger tool loop"
    }))

    expect(result.accepted).toBe(true)
    expect(result.assistantContent).toBe("done after loop")
    expect(result.iterationsUsed).toBe(2)
    expect(result.toolCallsTotal).toBeGreaterThan(0)
    expect(callCount).toBe(2)
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(cleanupDatabase(dbPath))
  )
})
```

You'll need to add a `makeTurnProcessingLayerWithModel` helper (or modify the existing `makeTurnProcessingLayer` to accept a custom model). The simplest approach is to add an optional parameter:

```typescript
const makeTurnProcessingLayer = (
  dbPath: string,
  forcedDecision: AuthorizationDecision = "Allow",
  capturedPrompts?: Array<string>,
  customModel?: LanguageModel.Service
) => {
  // ... existing code ...
  const mockModelRegistryLayer = Layer.effect(
    ModelRegistry,
    Effect.succeed({
      get: (_provider: string, _modelId: string) =>
        Effect.succeed(
          Layer.succeed(
            LanguageModel.LanguageModel,
            customModel ?? makeMockLanguageModel(capturedPrompts)
          )
        )
    })
  )
  // ... rest unchanged ...
}
```

Then call it as:

```typescript
const layer = makeTurnProcessingLayer(dbPath, "Allow", undefined, mockLm)
```

**Step 2: Write test for max iterations cap**

```typescript
it.effect("stops at maxToolIterations and returns partial result", () => {
  const dbPath = testDatabasePath("turn-max-iterations")
  const alwaysToolCallsLm: LanguageModel.Service = {
    generateText: (_options: any) =>
      Effect.succeed(
        new LanguageModel.GenerateTextResponse([
          Response.makePart("tool-call", {
            id: `call_${crypto.randomUUID()}`,
            name: "echo.text",
            params: { text: "infinite" },
            providerExecuted: false
          }),
          Response.makePart("tool-result", {
            id: `call_${crypto.randomUUID()}`,
            name: "echo.text",
            isFailure: false,
            result: { text: "infinite" },
            encodedResult: { text: "infinite" },
            providerExecuted: false,
            preliminary: false
          }),
          Response.makePart("finish", {
            reason: "tool-calls",
            usage: new Response.Usage({
              inputTokens: { uncached: 5, total: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 3, text: 3, reasoning: undefined }
            }),
            response: undefined
          })
        ])
      ) as any,
    streamText: (_options: any) => Stream.empty as any,
    generateObject: (_options: any) => Effect.die(new Error("not implemented")) as any
  }

  const layer = makeTurnProcessingLayer(dbPath, "Allow", undefined, alwaysToolCallsLm)

  return Effect.gen(function*() {
    const agentPort = yield* AgentStatePortSqlite
    const sessionPort = yield* SessionTurnPortSqlite
    const runtime = yield* TurnProcessingRuntime

    const now = instant("2026-02-24T12:00:00.000Z")
    yield* agentPort.upsert(makeAgentState({
      agentId: "agent:maxiter" as AgentId,
      tokenBudget: 500,
      maxToolIterations: 3,
      budgetResetAt: DateTime.add(now, { hours: 1 })
    }))
    yield* sessionPort.startSession(makeSessionState({
      sessionId: "session:maxiter" as SessionId,
      conversationId: "conversation:maxiter" as ConversationId,
      tokenCapacity: 1000,
      tokensUsed: 0
    }))

    const result = yield* runtime.processTurn(makeTurnPayload({
      turnId: "turn:maxiter" as TurnId,
      agentId: "agent:maxiter" as AgentId,
      sessionId: "session:maxiter" as SessionId,
      conversationId: "conversation:maxiter" as ConversationId,
      createdAt: now,
      inputTokens: 10,
      content: "trigger infinite loop"
    }))

    expect(result.accepted).toBe(true)
    expect(result.iterationsUsed).toBe(3)
    expect(result.assistantContent).toContain("3 tool-calling steps")
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(cleanupDatabase(dbPath))
  )
})
```

**Step 3: Run tests**

Run: `bun run test -- packages/server/test/TurnProcessingWorkflow.e2e.test.ts`
Expected: All pass — both loop and max-iterations tests green.

**Step 4: Run full suite**

Run: `bun run check && bun run test`
Expected: All pass.

**Step 5: Commit**

```bash
git add packages/server/test/TurnProcessingWorkflow.e2e.test.ts
git commit -m "test: add tool loop and max iterations e2e tests"
```

---

### Task 6: Final verification and cleanup

**Files:**
- All modified files from Tasks 1-5

**Step 1: Run full typecheck**

Run: `bun run check`
Expected: Clean, 0 errors.

**Step 2: Run full test suite**

Run: `bun run test`
Expected: All tests pass. No regressions.

**Step 3: Run lint**

Run: `bun run lint`
Expected: Clean. Fix any issues (import ordering is the most common).

**Step 4: Verify existing stream event tests still pass**

The "exposes canonical stream events" test in `TurnProcessingWorkflow.e2e.test.ts` should still pass — the mock model returns `finishReason: "stop"` which means 1 iteration, and `turn.completed` now has `iterationsUsed: 1` and `toolCallsTotal: 0` (or however many tool-call parts the mock returns).

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "chore: lint and cleanup after agentic slice implementation"
```

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `packages/domain/src/ports.ts` | Add `maxToolIterations` to `AgentState` | 1 |
| `packages/domain/src/events.ts` | Add `IterationCompletedEvent`, update `TurnCompletedEvent` | 2 |
| `packages/server/src/persistence/DomainMigrator.ts` | Migrations 0008 + 0009 | 1, 3 |
| `packages/server/src/AgentStatePortSqlite.ts` | Read/write `max_tool_iterations` | 1 |
| `packages/server/src/ai/ToolRegistry.ts` | 3 memory tools + handlers | 3 |
| `packages/server/src/turn/TurnProcessingWorkflow.ts` | Recursive tool loop | 4 |
| `packages/server/src/turn/TurnProcessingRuntime.ts` | Loop metadata in events | 4 |
| `packages/server/src/ChannelCore.ts` | Fix `AgentState` literal | 1 |
| `packages/server/test/ToolRegistry.test.ts` | Memory tool tests | 3 |
| `packages/server/test/TurnProcessingWorkflow.e2e.test.ts` | Loop + max-iterations tests | 5 |
| `packages/server/test/GovernanceRoutes.e2e.test.ts` | Fix `makeAgentState` | 1 |

## Verification

```bash
bun run check           # typecheck — no errors
bun run test            # full suite — all passing, no regressions
bun run lint            # clean
```
