# Memory Injection into System Prompt

**Date:** 2026-03-03
**Status:** Approved

## Problem

The agent has memory tools (`store_memory`, `retrieve_memories`, `forget_memories`) and a full storage backend (`MemoryPortSqlite` with FTS5), but no memories reach the agent's context automatically. The agent must call `retrieve_memories` explicitly — which it cannot do before receiving its first instruction, and which it has no reason to do unless it already knows relevant memories exist.

This creates a cold-start problem: memories are stored but never surface unless the agent guesses to look for them.

## Solution

Inject the agent's durable memories (SemanticMemory, ProceduralMemory) into the system prompt at the start of each turn. The injection is a read-only step in `TurnProcessingWorkflow` — no new services, no subroutines, no background activity.

### Injection Point

In `TurnProcessingWorkflow.ts`, between fetching the base system prompt and calling `Prompt.setSystem()`:

```typescript
// Existing
const baseSystemPrompt = yield* promptCatalog.get(
  promptBindings.turn.systemPromptRef
).pipe(Effect.orDie)

// New: append memory block
const memoryBlock = yield* buildMemoryBlock(memoryPort, context.agentId, profile)
const enrichedPrompt = memoryBlock.length > 0
  ? `${baseSystemPrompt}\n\n${memoryBlock}`
  : baseSystemPrompt

// Existing (updated)
const withSystem = Prompt.setSystem(currentHistory, enrichedPrompt)
```

### Memory Block Format

Memories render as an appended markdown section. If no memories exist for a tier, that heading is omitted. If no memories exist at all, the block is empty (no "Your Memories" header cluttering the prompt).

```markdown
## Your Memories

### Facts & Knowledge
- User prefers dark mode
- User's timezone is US/Pacific
- Project uses Effect v4 with bun

### Procedures & Workflows
- When deploying, always run tests first then check CI
- For database changes, write migration before updating schema
```

### Token Budget

A configurable cap prevents memories from consuming too much of the context window. The budget defaults to 2000 tokens (≈8000 characters at 4 chars/token). When total memory content exceeds the budget, older memories are truncated first (by `createdAt` ascending).

The budget is an optional field on the agent profile:

```yaml
agents:
  default:
    memoryInjection:
      maxTokens: 2000        # default
      tiers:                  # which tiers to auto-inject
        - SemanticMemory
        - ProceduralMemory
```

### `buildMemoryBlock` Function

Located in a new file `packages/server/src/turn/MemoryInjector.ts`:

```typescript
export const buildMemoryBlock = (
  memoryPort: MemoryPortService,
  agentId: AgentId,
  profile: AgentProfile
): Effect.Effect<string> =>
```

Steps:
1. Read `profile.memoryInjection` config (defaults: maxTokens=2000, tiers=[SemanticMemory, ProceduralMemory])
2. For each configured tier, call `memoryPort.listAll(agentId, { tier, scope: "GlobalScope" })`
3. Sort all items by `createdAt` descending (newest first for display, oldest truncated first if over budget)
4. Estimate token count per item (content length / 4)
5. Accumulate items until budget is reached
6. Group by tier, render as markdown sections
7. Return the formatted string (empty string if no memories)

### Schema Changes

Add optional `memoryInjection` field to `AgentProfileSchema` in `packages/domain/src/config.ts`:

```typescript
export const MemoryInjectionConfigSchema = Schema.Struct({
  maxTokens: Schema.optional(Schema.Number),   // default 2000
  tiers: Schema.optional(Schema.Array(MemoryTier))  // default [SemanticMemory, ProceduralMemory]
})
```

## Design Decisions

- **Appended section over template variable** — The base system prompt stays clean and unchanged. No `{{memories}}` placeholder to maintain. Injection is additive.
- **Separate file (`MemoryInjector.ts`) over inline** — Keeps TurnProcessingWorkflow focused on orchestration. The injector is testable in isolation.
- **Character-based budget over tokenizer** — A real tokenizer adds a dependency and latency. The 4:1 ratio is a well-known approximation that errs on the conservative side.
- **GlobalScope only** — SessionScope memories are working context; they belong in the conversation history, not the system prompt. GlobalScope memories are the agent's durable knowledge.
- **No caching** — Memory items can change between turns (the agent may store or forget memories mid-session). Fetching fresh each turn is cheap (SQLite local query) and correct.
- **Graceful degradation** — If the memory query fails, the turn proceeds with the base prompt. Memory injection is best-effort, not critical path.

## Files Changed

| File | Change |
|------|--------|
| `packages/domain/src/config.ts` | Add `MemoryInjectionConfigSchema`, optional field on `AgentProfileSchema` |
| `packages/server/src/turn/MemoryInjector.ts` | New: `buildMemoryBlock` function |
| `packages/server/src/turn/TurnProcessingWorkflow.ts` | Call `buildMemoryBlock`, use enriched prompt |
| `packages/server/test/MemoryInjector.test.ts` | New: unit tests for formatting, budget, empty states |
| `agent.yaml` | Add `memoryInjection` config to default agent |

## Future

- **Relevance-based injection** — Once vector search exists, replace `listAll` with a semantic query against the current user message. Inject the most relevant memories rather than all of them.
- **Reflection subroutine** — A ContextPressure-triggered subroutine that reviews recent turns and persists key information. Gated by turn count or token pressure threshold to avoid firing too often.
- **Memory decay** — Use `lastAccessTime` to deprioritize stale memories in the injection budget.
