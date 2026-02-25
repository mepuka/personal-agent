# Channel Adapter Architecture — Slice 1: Foundation + CLI Migration + WebChat

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract `ChannelCore` from the existing `ChannelEntity`, migrate CLI to the adapter pattern, and add a WebChat adapter — proving the adapter entity architecture end-to-end.

**Architecture:** Each channel adapter is an Effect Cluster entity implementing a shared base protocol. A `ChannelCore` service provides common logic (session binding, turn delegation). The existing `ChannelEntity` becomes `CLIAdapterEntity`. A new `WebChatAdapterEntity` proves the pattern with WebSocket transport. See `docs/plans/2026-02-25-channel-adapter-architecture-design.md` for full design context.

**Tech Stack:** Effect 4 (Entity, Rpc, Schema, Layer, ServiceMap, Stream), Bun, @effect/platform-bun

**Important:** The Memory Entity plan is being implemented on a separate branch. Steer clear of `MemoryEntity.ts`, `MemoryPortSqlite.ts`, and `MemoryPortMemory.ts`. Our changes should not conflict.

---

### Task 1: Expand domain types — ChannelType, ChannelCapability

**Files:**
- Modify: `packages/domain/src/status.ts`
- Modify: `packages/domain/test/ConfigSchema.test.ts` (if ChannelType is tested there)

**Step 1: Update ChannelType enum**

In `packages/domain/src/status.ts`, replace:
```typescript
export const ChannelType = Schema.Literals([
  "CLI",
  "HTTP"
])
```
With (aligning to PAO ontology `pao:ChannelType` individuals):
```typescript
export const ChannelType = Schema.Literals([
  "CLI",
  "Messaging",
  "WebChat",
  "APIChannel",
  "VoiceChannel",
  "EmailChannel"
])
```

**Step 2: Add ChannelCapability enum**

Append to `packages/domain/src/status.ts`:
```typescript
export const ChannelCapability = Schema.Literals([
  "SendText",
  "SendFile",
  "Reactions",
  "Threads",
  "ReadReceipts",
  "Typing",
  "StreamingDelivery"
])
export type ChannelCapability = typeof ChannelCapability.Type
```

**Step 3: Export ChannelCapability from domain index**

Check `packages/domain/src/index.ts` (or the status barrel export) and ensure `ChannelCapability` is exported.

**Step 4: Fix any test references to `"HTTP"` channel type**

Search for `"HTTP"` in tests — it's no longer a valid ChannelType literal. Replace with `"APIChannel"` if used, or remove if only in the enum.

**Verify:**
```bash
bun run check   # no type errors from ChannelType changes
bun run test     # all pass
```

**Commit:** `feat(domain): expand ChannelType to match PAO ontology, add ChannelCapability`

---

### Task 2: Add InboundMessage schema to domain

**Files:**
- Create: `packages/domain/src/channel.ts`
- Modify: domain barrel export (if needed)

**Step 1: Create the canonical inbound message envelope**

Create `packages/domain/src/channel.ts`:
```typescript
import { Schema } from "effect"

export class InboundAttachment extends Schema.Class<InboundAttachment>("InboundAttachment")({
  id: Schema.optionalWith(Schema.String, { as: "Option" }),
  name: Schema.optionalWith(Schema.String, { as: "Option" }),
  mimeType: Schema.optionalWith(Schema.String, { as: "Option" }),
  size: Schema.optionalWith(Schema.Number, { as: "Option" }),
  url: Schema.optionalWith(Schema.String, { as: "Option" }),
  kind: Schema.optionalWith(
    Schema.Literals(["image", "file", "audio", "video"]),
    { as: "Option" }
  )
}) {}

export class InboundMessage extends Schema.Class<InboundMessage>("InboundMessage")({
  channelId: Schema.String,
  userId: Schema.String,
  userName: Schema.optionalWith(Schema.String, { as: "Option" }),
  text: Schema.String,
  timestamp: Schema.DateTimeUtc,
  threadId: Schema.optionalWith(Schema.String, { as: "Option" }),
  isGroup: Schema.Boolean,
  attachments: Schema.Array(InboundAttachment),
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown })
}) {}
```

**Step 2: Write a basic decode test**

Create `packages/domain/test/ChannelSchema.test.ts`:
```typescript
import { describe, expect, it } from "@effect/vitest"
import { InboundMessage } from "../src/channel.js"
import { Schema } from "effect"

describe("InboundMessage", () => {
  it("decodes a minimal inbound message", () => {
    const input = {
      channelId: "channel:test",
      userId: "user:123",
      text: "hello",
      timestamp: "2026-02-25T12:00:00.000Z",
      isGroup: false,
      attachments: [],
      metadata: {}
    }
    const result = Schema.decodeUnknownSync(InboundMessage)(input)
    expect(result.channelId).toBe("channel:test")
    expect(result.text).toBe("hello")
  })
})
```

**Verify:**
```bash
bun run check
bun run test
```

**Commit:** `feat(domain): add InboundMessage and InboundAttachment schemas`

---

### Task 3: Expand ChannelRecord and ChannelPort with capabilities

**Files:**
- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/server/src/ChannelPortSqlite.ts`
- Modify: `packages/server/src/persistence/DomainMigrator.ts`
- Modify: `packages/server/src/entities/ChannelEntity.ts` (update channel creation to include capabilities)
- Modify: `packages/server/test/ChannelPortSqlite.test.ts`
- Modify: `packages/server/test/ChannelEntity.test.ts`

**Step 1: Add capabilities to ChannelRecord**

In `packages/domain/src/ports.ts`, update `ChannelRecord`:
```typescript
export interface ChannelRecord {
  readonly channelId: ChannelId
  readonly channelType: ChannelType
  readonly agentId: AgentId
  readonly activeSessionId: SessionId
  readonly activeConversationId: ConversationId
  readonly capabilities: ReadonlyArray<ChannelCapability>
  readonly createdAt: Instant
}
```

Import `ChannelCapability` from `status.ts`.

**Step 2: Add DB migration for capabilities column**

In `packages/server/src/persistence/DomainMigrator.ts`, add a new migration after the last one:
```typescript
"0006_channel_capabilities": Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE channels ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '["SendText"]'
  `.unprepared
})
```

**Step 3: Update ChannelPortSqlite**

Update `ChannelRowSchema` to include `capabilities_json: Schema.String`.

Update `decodeChannelRow` to parse `capabilities_json`:
```typescript
capabilities: JSON.parse(row.capabilities_json) as ReadonlyArray<ChannelCapability>
```

Update `create` to encode capabilities:
```typescript
${JSON.stringify(channel.capabilities)}
```

Add `capabilities_json` to the SELECT, INSERT, and ON CONFLICT clauses.

**Step 4: Update existing ChannelEntity to pass capabilities on creation**

In `ChannelEntity.ts`, update the `channelPort.create(...)` call in `createChannel` to include:
```typescript
capabilities: ["SendText"]
```

**Step 5: Update tests**

Update `ChannelPortSqlite.test.ts` and `ChannelEntity.test.ts` to include `capabilities` in `ChannelRecord` test data.

**Verify:**
```bash
bun run check
bun run test    # all 120+ pass
```

**Commit:** `feat(server): add capabilities to ChannelRecord and channels table`

---

### Task 4: Extract ChannelCore service

**Files:**
- Create: `packages/server/src/ChannelCore.ts`
- Create: `packages/server/test/ChannelCore.test.ts`

This is the heart of the refactoring. Extract the shared logic from `ChannelEntity.ts` into a reusable `ChannelCore` service.

**Step 1: Create ChannelCore**

Create `packages/server/src/ChannelCore.ts`:
```typescript
import type { AgentId, ChannelId, ConversationId, SessionId } from "@template/domain/ids"
import type { AgentState, ChannelPort, ChannelRecord, SessionTurnPort } from "@template/domain/ports"
import type { ChannelCapability, ChannelType } from "@template/domain/status"
import { DateTime, Effect, ServiceMap, Stream } from "effect"
import type { TurnStreamEvent } from "@template/domain/events"
import { AgentStatePortTag, ChannelPortTag, SessionTurnPortTag } from "./PortTags.js"
import { TurnProcessingRuntime } from "./turn/TurnProcessingRuntime.js"

export class ChannelCore extends ServiceMap.Service<ChannelCore>()("server/ChannelCore", {
  make: Effect.gen(function*() {
    const channelPort = yield* ChannelPortTag
    const agentStatePort = yield* AgentStatePortTag
    const sessionTurnPort = yield* SessionTurnPortTag
    const runtime = yield* TurnProcessingRuntime

    const ensureAgent = (agentId: AgentId) =>
      Effect.gen(function*() {
        const existing = yield* agentStatePort.get(agentId)
        if (existing !== null) return
        yield* agentStatePort.upsert({
          agentId,
          permissionMode: "Standard",
          tokenBudget: 200_000,
          quotaPeriod: "Daily",
          tokensConsumed: 0,
          budgetResetAt: null
        } satisfies AgentState)
      })

    const toSessionId = (channelId: ChannelId): SessionId =>
      (`session:${channelId}`) as SessionId

    const toConversationId = (channelId: ChannelId): ConversationId =>
      (`conv:${channelId}`) as ConversationId

    const initializeChannel = (opts: {
      channelId: ChannelId
      channelType: ChannelType
      agentId: AgentId
      capabilities: ReadonlyArray<ChannelCapability>
    }) =>
      Effect.gen(function*() {
        const existing = yield* channelPort.get(opts.channelId)
        if (existing !== null) {
          yield* ensureAgent(existing.agentId)
          return existing
        }

        const agentId = opts.agentId
        const sessionId = toSessionId(opts.channelId)
        const conversationId = toConversationId(opts.channelId)
        const now = yield* DateTime.now

        yield* ensureAgent(agentId)
        yield* sessionTurnPort.startSession({
          sessionId,
          conversationId,
          tokenCapacity: 200_000,
          tokensUsed: 0
        })

        const record: ChannelRecord = {
          channelId: opts.channelId,
          channelType: opts.channelType,
          agentId,
          activeSessionId: sessionId,
          activeConversationId: conversationId,
          capabilities: opts.capabilities,
          createdAt: now
        }
        yield* channelPort.create(record)
        return record
      })

    const getChannel = (channelId: ChannelId) => channelPort.get(channelId)

    const buildTurnPayload = (channel: ChannelRecord, content: string) =>
      Effect.gen(function*() {
        const turnId = `turn:${crypto.randomUUID()}`
        const now = yield* DateTime.now
        return {
          turnId,
          sessionId: channel.activeSessionId,
          conversationId: channel.activeConversationId,
          agentId: channel.agentId,
          content,
          contentBlocks: [{ contentBlockType: "TextBlock" as const, text: content }],
          createdAt: now,
          inputTokens: 0
        }
      })

    const processTurnStream = (turnPayload: Parameters<typeof runtime.processTurnStream>[0]) =>
      runtime.processTurnStream(turnPayload)

    const getHistory = (sessionId: SessionId) =>
      sessionTurnPort.listTurns(sessionId)

    return {
      ensureAgent,
      initializeChannel,
      getChannel,
      buildTurnPayload,
      processTurnStream,
      getHistory
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
```

**Step 2: Write ChannelCore tests**

Create `packages/server/test/ChannelCore.test.ts`. Test that:
- `initializeChannel` creates a channel record and session
- `initializeChannel` is idempotent (second call returns existing record)
- `buildTurnPayload` produces correct structure
- `getChannel` returns null for unknown, record for known

Use the same test layer pattern as `ChannelEntity.test.ts` (SQLite + mocks).

**Verify:**
```bash
bun run check
bun run test
```

**Commit:** `feat(server): extract ChannelCore service from ChannelEntity`

---

### Task 5: Refactor ChannelEntity to use ChannelCore (rename to CLIAdapterEntity)

**Files:**
- Modify: `packages/server/src/entities/ChannelEntity.ts` → rewrite to delegate to ChannelCore
- Create: `packages/server/src/entities/CLIAdapterEntity.ts` (or rename in-place)
- Modify: `packages/server/src/gateway/ChannelRoutes.ts` (update import)
- Modify: `packages/server/src/server.ts` (update import and layer wiring)
- Modify: `packages/server/test/ChannelEntity.test.ts` → rename/update

**Strategy:** This is a rename + refactor in stages to keep tests green.

**Step 1: Rewrite ChannelEntity internals to delegate to ChannelCore**

Keep the same file path and entity name for now. Replace the inlined logic in `createChannel`, `sendMessage`, and `getHistory` handlers with calls to `ChannelCore`:

```typescript
// In the entity layer factory:
const core = yield* ChannelCore

return {
  createChannel: (request) =>
    Effect.gen(function*() {
      const channelId = String(request.address.entityId) as ChannelId
      yield* core.initializeChannel({
        channelId,
        channelType: request.payload.channelType,
        agentId: request.payload.agentId as AgentId,
        capabilities: ["SendText"]
      })
    }),

  sendMessage: (request) =>
    Stream.unwrap(
      Effect.gen(function*() {
        const channelId = String(request.address.entityId) as ChannelId
        const channel = yield* core.getChannel(channelId)
        if (channel === null) {
          return Stream.fail(new ChannelNotFound({ channelId }))
        }
        const turnPayload = yield* core.buildTurnPayload(channel, request.payload.content)
        // Keep the existing SessionEntity delegation logic for Sharding-aware path
        // Fall back to core.processTurnStream for test mode
        ...
      })
    ),
  ...
}
```

Add `ChannelCore` to the entity layer's dependencies.

**Step 2: Run existing tests**

All existing `ChannelEntity.test.ts` tests must still pass. The test layer needs to provide `ChannelCore.layer`.

**Step 3: Rename to CLIAdapterEntity**

Once tests are green with ChannelCore delegation:
- Copy `ChannelEntity.ts` → `CLIAdapterEntity.ts`
- Update the entity name: `Entity.make("CLIAdapter", [...])`
- Update exports: `export const CLIAdapterEntity = Entity.make(...)`
- Keep `ChannelEntity` as a re-export alias for backward compatibility during this transition
- Update `ChannelRoutes.ts` to import from `CLIAdapterEntity`
- Update `server.ts` layer wiring
- Rename test file to `CLIAdapterEntity.test.ts`

**Step 4: Verify everything**

```bash
bun run check
bun run test    # all pass, no regressions
```

**Commit:** `refactor(server): rename ChannelEntity to CLIAdapterEntity, delegate to ChannelCore`

---

### Task 6: Define the adapter base protocol as reusable RPCs

**Files:**
- Create: `packages/server/src/entities/AdapterProtocol.ts`

**Step 1: Extract shared RPC definitions**

Create `packages/server/src/entities/AdapterProtocol.ts` with the base protocol RPCs that all adapters share:

```typescript
import { Schema } from "effect"
import { InboundMessage } from "@template/domain/channel"
import { ChannelNotFound } from "@template/domain/errors"
import { TurnStreamEvent } from "@template/domain/events"
import { ClusterSchema } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { TurnProcessingError } from "../turn/TurnProcessingWorkflow.js"

// Re-export the TurnRecordSchema (extracted from ChannelEntity)
export const TurnRecordSchema = Schema.Struct({
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  turnIndex: Schema.Number,
  participantRole: Schema.String,
  participantAgentId: Schema.Union([Schema.String, Schema.Null]),
  message: Schema.Struct({
    messageId: Schema.String,
    role: Schema.String,
    content: Schema.String,
    contentBlocks: Schema.Array(ContentBlock)
  }),
  modelFinishReason: Schema.Union([ModelFinishReason, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  createdAt: Schema.DateTimeUtc
})

export const InitializeRpc = Rpc.make("initialize", {
  payload: {
    agentId: Schema.String,
    config: Schema.optionalWith(Schema.Unknown, { as: "Option" })
  },
  success: Schema.Void,
  primaryKey: ({ agentId }) => `init:${agentId}`
}).annotate(ClusterSchema.Persisted, true)

export const ReceiveMessageRpc = Rpc.make("receiveMessage", {
  payload: { message: InboundMessage },
  success: TurnStreamEvent,
  error: Schema.Union([ChannelNotFound, TurnProcessingError]),
  stream: true
})

export const GetHistoryRpc = Rpc.make("getHistory", {
  payload: {},
  success: Schema.Array(TurnRecordSchema),
  error: ChannelNotFound
})

export const GetStatusRpc = Rpc.make("getStatus", {
  payload: {},
  success: Schema.Struct({
    channelType: Schema.String,
    capabilities: Schema.Array(Schema.String),
    isConnected: Schema.Boolean
  })
})
```

**Step 2: Update CLIAdapterEntity to use shared RPCs**

Import `InitializeRpc`, `ReceiveMessageRpc`, `GetHistoryRpc`, `GetStatusRpc` from `AdapterProtocol.ts`. The CLI adapter can keep its legacy `createChannel` and `sendMessage` RPCs as aliases for backward compatibility, or migrate fully to the base protocol.

For this task, keep the legacy RPCs alongside the new ones (dual interface). The new RPCs will be used by the WebChat adapter and eventually replace the legacy ones.

**Verify:**
```bash
bun run check
bun run test
```

**Commit:** `feat(server): define adapter base protocol as reusable RPCs`

---

### Task 7: Implement WebChatAdapterEntity

**Files:**
- Create: `packages/server/src/entities/WebChatAdapterEntity.ts`
- Create: `packages/server/test/WebChatAdapterEntity.test.ts`

**Step 1: Write failing tests first**

Create `packages/server/test/WebChatAdapterEntity.test.ts`:
- Test `initialize` creates a channel with `WebChat` type and capabilities `["SendText", "Typing", "StreamingDelivery"]`
- Test `receiveMessage` with an `InboundMessage` returns a stream of `TurnStreamEvent`
- Test `getHistory` returns turns after a message is processed
- Test `getStatus` returns correct capabilities and connection state
- Test `receiveMessage` on uninitialized entity fails with `ChannelNotFound`

Use the same test layer pattern (`Entity.makeTestClient`, SQLite, mock TurnProcessingRuntime). Add `ChannelCore.layer` to the test layer.

**Step 2: Implement WebChatAdapterEntity**

Create `packages/server/src/entities/WebChatAdapterEntity.ts`:
```typescript
import { Effect, Stream } from "effect"
import { Entity } from "effect/unstable/cluster"
import type { AgentId, ChannelId } from "@template/domain/ids"
import { ChannelNotFound } from "@template/domain/errors"
import { ChannelCore } from "../ChannelCore.js"
import {
  InitializeRpc,
  ReceiveMessageRpc,
  GetHistoryRpc,
  GetStatusRpc
} from "./AdapterProtocol.js"

export const WebChatAdapterEntity = Entity.make("WebChatAdapter", [
  InitializeRpc,
  ReceiveMessageRpc,
  GetHistoryRpc,
  GetStatusRpc
])

export const layer = WebChatAdapterEntity.toLayer(Effect.gen(function*() {
  const core = yield* ChannelCore

  return {
    initialize: (request) =>
      Effect.gen(function*() {
        const channelId = String(request.address.entityId) as ChannelId
        yield* core.initializeChannel({
          channelId,
          channelType: "WebChat",
          agentId: request.payload.agentId as AgentId,
          capabilities: ["SendText", "Typing", "StreamingDelivery"]
        })
      }),

    receiveMessage: (request) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const channelId = String(request.address.entityId) as ChannelId
          const channel = yield* core.getChannel(channelId)
          if (channel === null) {
            return Stream.fail(new ChannelNotFound({ channelId }))
          }
          const turnPayload = yield* core.buildTurnPayload(
            channel,
            request.payload.message.text
          )
          return core.processTurnStream(turnPayload)
        })
      ),

    getHistory: (request) =>
      Effect.gen(function*() {
        const channelId = String(request.address.entityId) as ChannelId
        const channel = yield* core.getChannel(channelId)
        if (channel === null) {
          return yield* new ChannelNotFound({ channelId })
        }
        return yield* core.getHistory(channel.activeSessionId)
      }),

    getStatus: (request) =>
      Effect.gen(function*() {
        const channelId = String(request.address.entityId) as ChannelId
        const channel = yield* core.getChannel(channelId)
        return {
          channelType: "WebChat",
          capabilities: channel?.capabilities ?? [],
          isConnected: channel !== null
        }
      })
  }
}))
```

**Step 3: Run tests**

```bash
bun run check
bun run test
```

**Commit:** `feat(server): implement WebChatAdapterEntity with base protocol`

---

### Task 8: Wire WebChatAdapterEntity into server.ts

**Files:**
- Modify: `packages/server/src/server.ts`

**Step 1: Add ChannelCore layer to the server composition**

```typescript
const channelCoreLayer = ChannelCore.layer.pipe(
  Layer.provide(agentStatePortTagLayer),
  Layer.provide(sessionTurnPortTagLayer),
  Layer.provide(channelPortTagLayer),
  Layer.provide(makeMockTurnProcessingRuntime())  // or the real runtime
)
```

Wait — `ChannelCore` depends on `TurnProcessingRuntime`, which is already wired. Thread the dependency through carefully. Check what `TurnProcessingRuntime` needs and ensure it's available where `ChannelCore` is composed.

**Step 2: Add WebChatAdapterEntity layer**

```typescript
import { layer as WebChatAdapterLayer } from "./entities/WebChatAdapterEntity.js"

const webChatAdapterLayer = WebChatAdapterLayer.pipe(
  Layer.provide(channelCoreLayer)
)
```

Merge into the entity composition alongside the existing channel entity layer.

**Step 3: Verify server boots**

```bash
bun run start   # server starts without errors, Ctrl+C to stop
bun run check
bun run test
```

**Commit:** `feat(server): wire WebChatAdapterEntity into server runtime`

---

### Task 9: Add WebSocket transport routes for WebChat

**Files:**
- Create: `packages/server/src/gateway/WebChatRoutes.ts`
- Modify: `packages/server/src/server.ts` (add routes to HttpApiAndRoutesLive)

**Step 1: Create WebSocket upgrade handler**

Create `packages/server/src/gateway/WebChatRoutes.ts`. This handles:
- `GET /ws/chat/:channelId` — WebSocket upgrade
- On connect: send `{ type: "connected" }` frame
- On text frame with `{ type: "message", content: "..." }`: normalize to `InboundMessage`, call `WebChatAdapterEntity.receiveMessage`, stream `TurnStreamEvent` back as JSON frames
- On disconnect: clean up

Use Effect's `HttpServerResponse.upgrade` for WebSocket handling. Check the Effect docs and `.reference/effect/` for WebSocket patterns in the HTTP server.

**Step 2: Register routes in server.ts**

Add `WebChatRoutes.layer` to `HttpApiAndRoutesLive`.

**Step 3: Manual verification**

```bash
bun run start
# In another terminal, use websocat or similar:
# websocat ws://localhost:3000/ws/chat/test-channel
# Send: {"type":"init","agentId":"agent:bootstrap"}
# Send: {"type":"message","content":"hello"}
# Expect: streamed TurnStreamEvent JSON frames
```

**Verify:**
```bash
bun run check
bun run test
```

**Commit:** `feat(server): add WebSocket transport routes for WebChat adapter`

---

### Task 10: Update agent.yaml config for channels

**Files:**
- Modify: `packages/server/src/ai/AgentConfig.ts` (parse channels section)
- Modify: `agent.yaml.example`
- Modify: `packages/server/test/AgentConfig.test.ts`

**Step 1: Add channels config parsing**

Extend the AgentConfig schema to parse a `channels` section:
```yaml
channels:
  cli:
    enabled: true
  webchat:
    enabled: true
```

Add a `channels` field to the parsed config type:
```typescript
readonly channels: Record<string, { enabled: boolean }>
```

Default: `{ cli: { enabled: true }, webchat: { enabled: true } }` if section is missing.

**Step 2: Update agent.yaml.example**

Add the channels section to the example config.

**Step 3: Test**

Add a test case to `AgentConfig.test.ts` verifying channels parsing.

**Verify:**
```bash
bun run check
bun run test
```

**Commit:** `feat(server): parse channels config from agent.yaml`

---

## Verification Checklist

After all tasks:
```bash
bun run check           # typecheck — zero new errors
bun run test            # full suite — no regressions
bun run start           # server starts, CLI still works
```

## Files Summary

| File | Action |
|------|--------|
| `packages/domain/src/status.ts` | Expand ChannelType, add ChannelCapability |
| `packages/domain/src/channel.ts` | Create — InboundMessage, InboundAttachment |
| `packages/domain/test/ChannelSchema.test.ts` | Create — InboundMessage decode test |
| `packages/domain/src/ports.ts` | Add capabilities to ChannelRecord |
| `packages/server/src/persistence/DomainMigrator.ts` | Add migration for capabilities_json column |
| `packages/server/src/ChannelPortSqlite.ts` | Handle capabilities_json in queries |
| `packages/server/src/ChannelCore.ts` | Create — shared adapter logic |
| `packages/server/test/ChannelCore.test.ts` | Create — ChannelCore unit tests |
| `packages/server/src/entities/ChannelEntity.ts` | Refactor to delegate to ChannelCore |
| `packages/server/src/entities/CLIAdapterEntity.ts` | Renamed from ChannelEntity |
| `packages/server/src/entities/AdapterProtocol.ts` | Create — shared RPC definitions |
| `packages/server/src/entities/WebChatAdapterEntity.ts` | Create — WebChat adapter |
| `packages/server/test/WebChatAdapterEntity.test.ts` | Create — WebChat adapter tests |
| `packages/server/src/gateway/ChannelRoutes.ts` | Update imports |
| `packages/server/src/gateway/WebChatRoutes.ts` | Create — WebSocket routes |
| `packages/server/src/server.ts` | Wire ChannelCore + WebChatAdapter layers |
| `packages/server/src/ai/AgentConfig.ts` | Parse channels config |
| `agent.yaml.example` | Add channels section |

## Out of Scope (Future Slices)

- Email adapter (Slice 2)
- WhatsApp adapter (Slice 2)
- Session resolution modes (shared/per-channel/per-user-channel) (Slice 3)
- User identity linking and PlatformLink table (Slice 3)
- Governance cross-channel access policy (Slice 3)
