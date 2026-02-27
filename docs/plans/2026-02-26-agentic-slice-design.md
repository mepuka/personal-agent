# Full Agentic Slice Design

**Goal:** Enable true agentic behavior — memory tools, multi-step tool calling, and loop control — so the agent can autonomously use tools across multiple LLM calls within a single turn.

**Scope:** Memory tools (store, retrieve, forget) + recursive tool loop + loop control + stream observability events.

---

## 1. Memory Tools

Three tools added to the existing `SafeToolkit` in `ToolRegistry.ts`, following the same `runGovernedTool` governance pattern as `time_now`, `math_calculate`, and `echo_text`.

### store_memory

Persists a semantic memory scoped to the agent.

- **Parameters:** `{ content: string, tags: string[] }`
- **Success:** `{ memoryId: string, stored: true }`
- **Backend:** `MemoryPortSqlite.encode(agentId, content, tags)`

### retrieve_memories

Searches stored memories by natural language query using FTS5.

- **Parameters:** `{ query: string, limit?: number }`
- **Success:** `{ memories: Array<{ memoryId, content, tags, similarity }> }`
- **Backend:** `MemoryPortSqlite.retrieve(agentId, query, limit)`
- **Default limit:** 5

### forget_memories

Removes memories by ID.

- **Parameters:** `{ memoryIds: string[] }`
- **Success:** `{ forgotten: number }`
- **Backend:** `MemoryPortSqlite.forget(agentId, memoryIds)`

All three tools go through the full governance pipeline: `evaluatePolicy -> checkQuota -> execute -> recordInvocation + audit`. The `ToolExecutionContext` already carries `agentId` and `sessionId` for scoping. `MemoryPortSqlite` is already in the server's dependency graph.

---

## 2. Tool Loop

The current `TurnProcessingWorkflow` makes a single `chat.generateText()` call. When the model returns `finishReason: "tool-calls"`, the Chat API resolves the tools but does not re-call the model. The agent can't act on tool results.

### Recursive loop pattern

Replace the single call with an idiomatic `Effect.suspend` recursive loop:

```typescript
const processWithToolLoop = (
  chat: Chat.Chat,
  toolkit: typeof SafeToolkit,
  handlerLayer: Layer.Layer<any>,
  maxIterations: number
): Effect.Effect<AssistantResponse, TurnProcessingError> =>
  Effect.suspend(function loop(
    iteration: number = 0
  ): Effect.Effect<AssistantResponse, TurnProcessingError> {
    if (iteration >= maxIterations) {
      return Effect.succeed(buildMaxIterationsResponse(iteration))
    }

    return chat.generateText({ prompt: Prompt.empty, toolkit }).pipe(
      Effect.provide(handlerLayer),
      Effect.flatMap((response) => {
        if (response.finishReason === "tool-calls") {
          return loop(iteration + 1)
        }
        return Effect.succeed(buildAssistantResponse(response, iteration))
      })
    )
  })
```

### Why this pattern

- **`Effect.suspend`** — stack-safe; Effect trampolines the recursion.
- **Chat's `Ref<Prompt>`** — auto-appends each response (including tool results) to conversation history. No manual history management.
- **`finishReason` drives the loop** — `"tool-calls"` means recurse; anything else (`"stop"`, `"end_turn"`, `"length"`) terminates.
- **No while loops** — idiomatic Effect iteration via recursive function.

### Workflow integration

The loop is **inline** between durable Activity checkpoints, not wrapped as an Activity itself:

```
Activity: PersistUserTurn          <- Checkpoint
  |
  v
processWithToolLoop(...)           <- Inline (recursive Effect.suspend)
  |
  v
Activity: PersistAssistantTurn     <- Checkpoint
Activity: WriteAudit               <- Checkpoint
```

If the process crashes mid-loop, the workflow resumes from `PersistUserTurn` and re-runs the loop. This is safe because:
- LLM calls are deterministic per attempt
- Tool executions use idempotency keys via `runGovernedTool`
- Chat history is rebuilt on restart

---

## 3. Loop Control & Safety

Three existing mechanisms prevent runaway loops — only one new field is needed.

### Max iterations

Hard cap checked at the top of each `loop(iteration)` call. Default: `10`. Sourced from a new `maxToolIterations` field on `AgentState`. The governance layer can override per-agent.

When hit, the loop returns a structured response telling the model it reached the limit, including what it accomplished so far.

### Token budget

The existing `CheckTokenBudget` Activity runs before the loop starts. Inside the loop, the model provider enforces context window limits. No per-iteration budget check needed.

### Tool-level quota

Already exists. `runGovernedTool` calls `governance.checkToolQuota()` before every tool execution. If quota is exceeded mid-loop, the tool returns `ToolQuotaExceeded` as a failure, which the model sees and can respond to gracefully.

### Error handling

- **Tool execution failure** — not fatal. The tool returns a `ToolFailure`, the model sees it, decides whether to retry or respond. Already how `runGovernedTool` works.
- **LLM provider error** — fatal. Breaks out of the loop, falls through to the existing `WriteAudit` failure path.
- **Unexpected error** — `Effect.catchAll` at the loop boundary converts to `TurnProcessingError`.

---

## 4. Stream Events & Observability

New ephemeral stream events so the client can observe multi-step tool loops in real time.

| Event | Emitted when | Payload |
|-------|-------------|---------|
| `tool.calls.started` | Model returns `finishReason: "tool-calls"` | `{ iteration, toolCalls: [{ toolName, inputJson }] }` |
| `tool.call.result` | Each tool finishes executing | `{ iteration, toolName, outputJson, decision }` |
| `iteration.completed` | Loop iteration finishes, about to re-call model | `{ iteration, toolCallCount }` |

These nest inside the existing `turn.started` / `turn.completed` envelope. The TUI's `ToolPane` can render them for real-time visibility.

`turn.completed` gains two fields: `iterationsUsed: number` and `toolCallsTotal: number`.

These are ephemeral stream events only — the durable record is the `ToolInvocationRecord` already persisted by `runGovernedTool`.

---

## 5. Integration & Wiring

### ToolRegistry (`packages/server/src/ai/ToolRegistry.ts`)

Add 3 tool definitions (Schema structs) and 3 handlers to `SafeToolkit`. Each handler follows the `runGovernedTool(context, toolName, input, execute)` pattern. `MemoryPortSqlite` is injected via the handler layer.

### TurnProcessingWorkflow (`packages/server/src/turn/TurnProcessingWorkflow.ts`)

Replace the single `chat.generateText()` with `processWithToolLoop()`. Read `maxToolIterations` from `AgentState` before entering the loop. Activities before and after the loop are unchanged.

### AgentState (`packages/domain/src/ports.ts`)

Add `maxToolIterations: number` (default `10`).

### DomainMigrator (`packages/server/src/persistence/DomainMigrator.ts`)

Migration to add `max_tool_iterations` column with default value.

### Domain events (`packages/domain/src/events.ts`)

Add the three new `TurnStreamEvent` variants and updated `turn.completed` payload.

---

## Files Summary

| File | Change |
|------|--------|
| `packages/domain/src/events.ts` | New stream event types |
| `packages/domain/src/ports.ts` | `AgentState.maxToolIterations` field |
| `packages/server/src/ai/ToolRegistry.ts` | 3 memory tool definitions + handlers |
| `packages/server/src/turn/TurnProcessingWorkflow.ts` | Recursive tool loop replacing single `generateText` |
| `packages/server/src/persistence/DomainMigrator.ts` | Migration for `maxToolIterations` column |
