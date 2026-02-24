# Channel + Gateway Vertical Slice Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the full message lifecycle: CLI `agent chat` → Channel entity (facade) → Session entity → TurnProcessingWorkflow → LLM → streamed SSE response back to CLI, with multi-turn conversation history. Replace hand-coded API with EntityProxy-derived endpoints.

**Architecture:** Channel-as-Facade. ChannelEntity is the user-facing API — the CLI sends text to a channelId and gets a stream back. Channel manages session lifecycle internally. All HTTP endpoints are auto-derived from entity RPCs via `EntityProxy.toHttpApiGroup` + `EntityProxyServer.layerHttpApi`. CLI is a thin HTTP client (gateway-only).

**Tech Stack:** Effect 4.0.0-beta.11, Effect Cluster entities, EntityProxy, SQLite (via `@effect/sql-sqlite-bun`), Bun runtime (server + CLI).

**Design doc:** `docs/plans/2026-02-24-channel-gateway-vertical-slice-design.md`

---

## Task 1: Extract Event Schemas from RuntimeApi

Move `TurnStreamEvent` types to their own module so they survive RuntimeApi deletion.

**Files:**
- Create: `packages/domain/src/events.ts`
- Modify: `packages/domain/src/RuntimeApi.ts` (remove event classes)
- Modify: `packages/server/src/entities/SessionEntity.ts:3` (update import)
- Modify: `packages/server/src/turn/TurnProcessingRuntime.ts` (update import)
- Modify: `packages/server/src/TurnStreamingRouter.ts:1` (update import)

**Step 1: Create `packages/domain/src/events.ts`**

Move all event Schema.Class definitions and the TurnStreamEvent union. Keep SubmitTurnRequest too (used by SessionEntity's ProcessTurnRpc payload pattern).

```typescript
import { Schema } from "effect"
import { ContentBlock } from "./ports.js"

export class SubmitTurnRequest extends Schema.Class<SubmitTurnRequest>("SubmitTurnRequest")({
  turnId: Schema.String,
  conversationId: Schema.String,
  agentId: Schema.String,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlock),
  createdAt: Schema.DateTimeUtc,
  inputTokens: Schema.Number
}) {}

export class TurnStartedEvent extends Schema.Class<TurnStartedEvent>("TurnStartedEvent")({
  type: Schema.Literal("turn.started"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.DateTimeUtc
}) {}

export class AssistantDeltaEvent extends Schema.Class<AssistantDeltaEvent>("AssistantDeltaEvent")({
  type: Schema.Literal("assistant.delta"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  delta: Schema.String
}) {}

export class ToolCallEvent extends Schema.Class<ToolCallEvent>("ToolCallEvent")({
  type: Schema.Literal("tool.call"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  inputJson: Schema.String
}) {}

export class ToolResultEvent extends Schema.Class<ToolResultEvent>("ToolResultEvent")({
  type: Schema.Literal("tool.result"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  outputJson: Schema.String,
  isError: Schema.Boolean
}) {}

export class TurnCompletedEvent extends Schema.Class<TurnCompletedEvent>("TurnCompletedEvent")({
  type: Schema.Literal("turn.completed"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  accepted: Schema.Boolean,
  auditReasonCode: Schema.String,
  modelFinishReason: Schema.Union([Schema.String, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null])
}) {}

export class TurnFailedEvent extends Schema.Class<TurnFailedEvent>("TurnFailedEvent")({
  type: Schema.Literal("turn.failed"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  errorCode: Schema.String,
  message: Schema.String
}) {}

export const TurnStreamEvent = Schema.Union([
  TurnStartedEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnCompletedEvent,
  TurnFailedEvent
])
export type TurnStreamEvent = typeof TurnStreamEvent.Type
```

**Step 2: Update imports across the codebase**

Replace all `from "@template/domain/RuntimeApi"` with `from "@template/domain/events"` for event-related imports:

- `packages/server/src/entities/SessionEntity.ts:3` — change `TurnStreamEvent` import
- `packages/server/src/turn/TurnProcessingRuntime.ts` — change event imports
- `packages/server/src/TurnStreamingRouter.ts:1` — change `SubmitTurnRequest`, `TurnFailedEvent`, `TurnStreamEvent` imports

**Step 3: Verify**

Run: `bun run check`
Expected: Zero TypeScript errors.

**Step 4: Commit**

```bash
git add packages/domain/src/events.ts packages/domain/src/RuntimeApi.ts packages/server/src/entities/SessionEntity.ts packages/server/src/turn/TurnProcessingRuntime.ts packages/server/src/TurnStreamingRouter.ts
git commit -m "refactor: extract event schemas from RuntimeApi to domain/events"
```

---

## Task 2: Add Domain Types for Channels

**Files:**
- Modify: `packages/domain/src/ids.ts` (add ChannelId)
- Modify: `packages/domain/src/status.ts` (add ChannelType)
- Modify: `packages/domain/src/ports.ts` (add ChannelRecord, ChannelPort, extend SessionTurnPort)
- Modify: `packages/domain/src/errors.ts` (add ChannelNotFound)

**Step 1: Add `ChannelId` to `packages/domain/src/ids.ts`**

After the `ToolName` definition (line 37), add:

```typescript
export const ChannelId = Schema.String.pipe(Schema.brand("ChannelId"))
export type ChannelId = typeof ChannelId.Type
```

**Step 2: Add `ChannelType` to `packages/domain/src/status.ts`**

After `QuotaPeriod` (line 61), add:

```typescript
export const ChannelType = Schema.Literals([
  "CLI",
  "HTTP"
])
export type ChannelType = typeof ChannelType.Type
```

**Step 3: Add `ChannelRecord` and `ChannelPort` to `packages/domain/src/ports.ts`**

Add `ChannelId` to the id imports. Add `ChannelType` to the status imports.

After the `SchedulePort` interface (line 265), add:

```typescript
export interface ChannelRecord {
  readonly channelId: ChannelId
  readonly channelType: ChannelType
  readonly agentId: AgentId
  readonly activeSessionId: SessionId
  readonly activeConversationId: ConversationId
  readonly createdAt: Instant
}

export interface ChannelPort {
  readonly create: (channel: ChannelRecord) => Effect.Effect<void>
  readonly get: (channelId: ChannelId) => Effect.Effect<ChannelRecord | null>
}
```

**Step 4: Extend `SessionTurnPort` with `listTurns`**

In `packages/domain/src/ports.ts`, add to the `SessionTurnPort` interface (after line 235):

```typescript
  readonly listTurns: (
    sessionId: SessionId
  ) => Effect.Effect<ReadonlyArray<TurnRecord>>
```

**Step 5: Add `ChannelNotFound` to `packages/domain/src/errors.ts`**

After `ClusterEntityError` (line 40), add:

```typescript
export class ChannelNotFound extends Schema.ErrorClass<ChannelNotFound>("ChannelNotFound")({
  _tag: Schema.tag("ChannelNotFound"),
  channelId: Schema.String
}) {}
```

**Step 6: Verify**

Run: `bun run check`
Expected: Errors in `SessionTurnPortMemory.ts` (missing `listTurns`). That's expected — we fix it in Task 3.

**Step 7: Commit**

```bash
git add packages/domain/src/ids.ts packages/domain/src/status.ts packages/domain/src/ports.ts packages/domain/src/errors.ts
git commit -m "feat(domain): add Channel types, ChannelPort, listTurns to SessionTurnPort"
```

---

## Task 3: Channel Persistence Layer

**Files:**
- Modify: `packages/server/src/PortTags.ts` (add ChannelPortTag)
- Create: `packages/server/src/ChannelPortSqlite.ts`
- Modify: `packages/server/src/persistence/DomainMigrator.ts` (add migration 0003)
- Modify: `packages/server/src/SessionTurnPortMemory.ts` (add listTurns)
- Create: `packages/server/test/ChannelPortSqlite.test.ts`

**Step 1: Add `ChannelPortTag` to `packages/server/src/PortTags.ts`**

Add import of `ChannelPort` and add after `MemoryPortTag`:

```typescript
export const ChannelPortTag = ServiceMap.Service<ChannelPort>("server/ports/ChannelPort")
```

**Step 2: Add `listTurns` to `SessionTurnPortMemory`**

In `packages/server/src/SessionTurnPortMemory.ts`, add after `updateContextWindow` (before the return, ~line 60):

```typescript
      const listTurns = (sessionId: SessionId) =>
        Ref.get(turns).pipe(
          Effect.map((map) => {
            const current = HashMap.get(map, sessionId)
            return Option.isSome(current) ? current.value : ([] as Array<TurnRecord>)
          })
        )
```

Add `listTurns` to the returned object.

**Step 3: Add migration `0003_channel_tables` to `packages/server/src/persistence/DomainMigrator.ts`**

After the `"0002_core_phase1_tables"` entry, add:

```typescript
  "0003_channel_tables": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        active_session_id TEXT NOT NULL,
        active_conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `.unprepared
  })
```

**Step 4: Create `packages/server/src/ChannelPortSqlite.ts`**

Follow the exact pattern of `AgentStatePortSqlite` and `SessionTurnPortSqlite`:

```typescript
import { Effect, Layer, Option, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type { ChannelId } from "../../domain/src/ids.js"
import type { ChannelPort, ChannelRecord, Instant } from "../../domain/src/ports.js"
import type { ChannelType } from "../../domain/src/status.js"

const ChannelRowSchema = Schema.Struct({
  channel_id: Schema.String,
  channel_type: Schema.String,
  agent_id: Schema.String,
  active_session_id: Schema.String,
  active_conversation_id: Schema.String,
  created_at: Schema.String
})
type ChannelRow = typeof ChannelRowSchema.Type

const ChannelIdRequest = Schema.Struct({ channelId: Schema.String })
const InstantFromSqlString = Schema.DateTimeUtcFromString
const decodeSqlInstant = Schema.decodeUnknownSync(InstantFromSqlString)
const encodeSqlInstant = Schema.encodeSync(InstantFromSqlString)

export class ChannelPortSqlite extends ServiceMap.Service<ChannelPortSqlite>()(
  "server/ChannelPortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findChannelById = SqlSchema.findOneOption({
        Request: ChannelIdRequest,
        Result: ChannelRowSchema,
        execute: ({ channelId }) =>
          sql`
            SELECT channel_id, channel_type, agent_id,
                   active_session_id, active_conversation_id, created_at
            FROM channels
            WHERE channel_id = ${channelId}
            LIMIT 1
          `.withoutTransform
      })

      const create: ChannelPort["create"] = (channel) =>
        sql`
          INSERT INTO channels (
            channel_id, channel_type, agent_id,
            active_session_id, active_conversation_id, created_at
          ) VALUES (
            ${channel.channelId},
            ${channel.channelType},
            ${channel.agentId},
            ${channel.activeSessionId},
            ${channel.activeConversationId},
            ${encodeSqlInstant(channel.createdAt)}
          )
          ON CONFLICT(channel_id) DO UPDATE SET
            channel_type = excluded.channel_type,
            agent_id = excluded.agent_id,
            active_session_id = excluded.active_session_id,
            active_conversation_id = excluded.active_conversation_id
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.orDie
        )

      const get: ChannelPort["get"] = (channelId) =>
        findChannelById({ channelId }).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: decodeChannelRow
            })
          ),
          Effect.orDie
        )

      return { create, get } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const decodeChannelRow = (row: ChannelRow): ChannelRecord => ({
  channelId: row.channel_id as ChannelId,
  channelType: row.channel_type as ChannelType,
  agentId: row.agent_id as ChannelRecord["agentId"],
  activeSessionId: row.active_session_id as ChannelRecord["activeSessionId"],
  activeConversationId: row.active_conversation_id as ChannelRecord["activeConversationId"],
  createdAt: decodeSqlInstant(row.created_at)
})
```

**Step 5: Write test `packages/server/test/ChannelPortSqlite.test.ts`**

Follow the pattern from `SessionTurnPortSqlite.test.ts`:

```typescript
import { Effect, Layer } from "effect"
import { it } from "@effect/vitest"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChannelPortSqlite } from "../src/ChannelPortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import type { ChannelRecord } from "@template/domain/ports"
import type { ChannelId, AgentId, SessionId, ConversationId } from "@template/domain/ids"
import { DateTime } from "effect"

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => { rmSync(path, { force: true }) })

describe("ChannelPortSqlite", () => {
  const dbPath = testDatabasePath("channel-port")

  const sqliteLayer = SqliteRuntime.layer(dbPath)
  const migrationLayer = DomainMigrator.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.orDie
  )
  const portLayer = ChannelPortSqlite.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.provide(migrationLayer)
  )
  const testLayer = Layer.mergeAll(portLayer, sqliteLayer, migrationLayer)

  afterAll(() => {
    rmSync(dbPath, { force: true })
  })

  const makeChannel = (id: string): ChannelRecord => ({
    channelId: `channel:${id}` as ChannelId,
    channelType: "CLI",
    agentId: "agent:bootstrap" as AgentId,
    activeSessionId: `session:${id}` as SessionId,
    activeConversationId: `conv:${id}` as ConversationId,
    createdAt: DateTime.unsafeMake(Date.now())
  })

  it.effect("get returns null for unknown channel", () =>
    Effect.gen(function*() {
      const port = yield* ChannelPortSqlite
      const result = yield* port.get("channel:unknown" as ChannelId)
      expect(result).toBeNull()
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("create + get roundtrip", () =>
    Effect.gen(function*() {
      const port = yield* ChannelPortSqlite
      const channel = makeChannel("test1")
      yield* port.create(channel)
      const result = yield* port.get(channel.channelId)
      expect(result).not.toBeNull()
      expect(result!.channelId).toBe(channel.channelId)
      expect(result!.channelType).toBe("CLI")
      expect(result!.activeSessionId).toBe(channel.activeSessionId)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("create is idempotent (upsert)", () =>
    Effect.gen(function*() {
      const port = yield* ChannelPortSqlite
      const channel = makeChannel("test2")
      yield* port.create(channel)
      yield* port.create({ ...channel, channelType: "HTTP" })
      const result = yield* port.get(channel.channelId)
      expect(result!.channelType).toBe("HTTP")
    }).pipe(Effect.provide(testLayer))
  )
})
```

**Step 6: Run tests**

Run: `bun run test -- packages/server/test/ChannelPortSqlite.test.ts`
Expected: 3 tests pass.

**Step 7: Verify full check**

Run: `bun run check`
Expected: Zero errors.

**Step 8: Commit**

```bash
git add packages/server/src/PortTags.ts packages/server/src/ChannelPortSqlite.ts packages/server/src/persistence/DomainMigrator.ts packages/server/src/SessionTurnPortMemory.ts packages/server/test/ChannelPortSqlite.test.ts
git commit -m "feat(server): add ChannelPortSqlite with migration and tests"
```

---

## Task 4: Create ChannelEntity

**Files:**
- Create: `packages/server/src/entities/ChannelEntity.ts`
- Create: `packages/server/test/ChannelEntity.test.ts`

**Step 1: Create `packages/server/src/entities/ChannelEntity.ts`**

```typescript
import type { AgentId, ChannelId, ConversationId, SessionId } from "@template/domain/ids"
import { ChannelNotFound } from "@template/domain/errors"
import { TurnStreamEvent } from "@template/domain/events"
import { ContentBlock } from "@template/domain/ports"
import { DateTime, Effect, Schema, Stream } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { ChannelPortTag, SessionTurnPortTag } from "../PortTags.js"
import { SessionEntity } from "./SessionEntity.js"
import { TurnProcessingError } from "../turn/TurnProcessingWorkflow.js"

const CreateChannelRpc = Rpc.make("createChannel", {
  payload: {
    channelType: Schema.Literals(["CLI", "HTTP"]),
    agentId: Schema.String
  },
  success: Schema.Void,
  primaryKey: ({ agentId }) => `create:${agentId}`
}).annotate(ClusterSchema.Persisted, true)

const SendMessageRpc = Rpc.make("sendMessage", {
  payload: {
    content: Schema.String
  },
  success: TurnStreamEvent,
  error: Schema.Union([ChannelNotFound, TurnProcessingError]),
  stream: true
})

const TurnRecordSchema = Schema.Struct({
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
  modelFinishReason: Schema.Union([Schema.String, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  createdAt: Schema.DateTimeUtc
})

const GetHistoryRpc = Rpc.make("getHistory", {
  payload: {},
  success: Schema.Array(TurnRecordSchema),
  error: ChannelNotFound,
  primaryKey: () => "history"
})

export const ChannelEntity = Entity.make("Channel", [
  CreateChannelRpc,
  SendMessageRpc,
  GetHistoryRpc
])

export const layer = ChannelEntity.toLayer(Effect.gen(function*() {
  const channelPort = yield* ChannelPortTag
  const sessionTurnPort = yield* SessionTurnPortTag
  const makeSessionClient = yield* SessionEntity.client

  return {
    createChannel: ({ payload, entityId }) =>
      Effect.gen(function*() {
        const channelId = entityId as ChannelId
        const agentId = payload.agentId as AgentId
        const sessionId = `session:${crypto.randomUUID()}` as SessionId
        const conversationId = `conv:${crypto.randomUUID()}` as ConversationId
        const now = yield* DateTime.now

        // Create the channel record
        yield* channelPort.create({
          channelId,
          channelType: payload.channelType,
          agentId,
          activeSessionId: sessionId,
          activeConversationId: conversationId,
          createdAt: now
        })

        // Bootstrap the session via SessionEntity
        const sessionClient = makeSessionClient(sessionId)
        yield* sessionClient.startSession({
          sessionId,
          conversationId,
          tokenCapacity: 200_000,
          tokensUsed: 0
        })
      }),

    sendMessage: ({ payload, entityId }) =>
      Effect.gen(function*() {
        const channelId = entityId as ChannelId
        const channel = yield* channelPort.get(channelId)
        if (channel === null) {
          return yield* new ChannelNotFound({ channelId })
        }

        const turnId = `turn:${crypto.randomUUID()}`
        const now = yield* DateTime.now
        const sessionClient = makeSessionClient(channel.activeSessionId)

        return sessionClient.processTurn({
          turnId,
          sessionId: channel.activeSessionId,
          conversationId: channel.activeConversationId,
          agentId: channel.agentId,
          content: payload.content,
          contentBlocks: [{ contentBlockType: "TextBlock" as const, text: payload.content }],
          createdAt: now,
          inputTokens: 0
        })
      }).pipe(Effect.map(Stream.unwrap)),

    getHistory: ({ entityId }) =>
      Effect.gen(function*() {
        const channelId = entityId as ChannelId
        const channel = yield* channelPort.get(channelId)
        if (channel === null) {
          return yield* new ChannelNotFound({ channelId })
        }

        return yield* sessionTurnPort.listTurns(channel.activeSessionId)
      })
  }
}))
```

**Important implementation note:** The `sendMessage` handler returns a `Stream` (because `stream: true`). The handler wraps the delegation to `SessionEntity.processTurn` — which itself returns a `Stream<TurnStreamEvent>` — in an Effect that resolves the channel, builds the payload, and then returns the inner stream. The `Effect.map(Stream.unwrap)` pattern may need adjustment based on the exact entity handler signature. During implementation, check the reference entity streaming tests at `.reference/effect/packages/effect/test/cluster/Entity.test.ts` for the correct pattern.

**Step 2: Write test `packages/server/test/ChannelEntity.test.ts`**

This test needs both ChannelEntity and SessionEntity wired with their dependencies. Use `Entity.makeTestClient` for ChannelEntity. Since ChannelEntity calls `SessionEntity.client`, we need Sharding context — `makeTestClient` provides this.

```typescript
import { it } from "@effect/vitest"
import { DateTime, Effect, Layer, Stream } from "effect"
import { ShardingConfig } from "effect/unstable/cluster"
import { Entity } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChannelEntity, layer as ChannelEntityLayer } from "../src/entities/ChannelEntity.js"
import { layer as SessionEntityLayer } from "../src/entities/SessionEntity.js"
import { ChannelPortSqlite } from "../src/ChannelPortSqlite.js"
import { SessionTurnPortSqlite } from "../src/SessionTurnPortSqlite.js"
import { ChannelPortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { TurnProcessingRuntime } from "../src/turn/TurnProcessingRuntime.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import type { ChannelId } from "@template/domain/ids"

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

describe("ChannelEntity", () => {
  const dbPath = testDatabasePath("channel-entity")

  const sqliteLayer = SqliteRuntime.layer(dbPath)
  const migrationLayer = DomainMigrator.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.orDie
  )
  const sqlInfra = Layer.mergeAll(sqliteLayer, migrationLayer)

  const channelPortLayer = Layer.effect(
    ChannelPortTag,
    Effect.gen(function*() {
      return (yield* ChannelPortSqlite) as any
    })
  ).pipe(Layer.provide(ChannelPortSqlite.layer.pipe(Layer.provide(sqlInfra))))

  const sessionTurnPortLayer = Layer.effect(
    SessionTurnPortTag,
    Effect.gen(function*() {
      return (yield* SessionTurnPortSqlite) as any
    })
  ).pipe(Layer.provide(SessionTurnPortSqlite.layer.pipe(Layer.provide(sqlInfra))))

  // Mock TurnProcessingRuntime — returns a simple stream for testing
  // Real implementation would need the full workflow stack
  // For this test, we verify channel → session delegation works

  afterAll(() => {
    rmSync(dbPath, { force: true })
  })

  it.effect("createChannel + getHistory returns empty", () =>
    Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(ChannelEntity, ChannelEntityLayer)
      const channelId = `channel:${crypto.randomUUID()}` as ChannelId
      const client = makeClient(channelId)

      yield* client.createChannel({
        channelType: "CLI",
        agentId: "agent:bootstrap"
      })

      const history = yield* client.getHistory({})
      expect(history).toEqual([])
    }).pipe(
      Effect.provide(Layer.mergeAll(
        channelPortLayer,
        sessionTurnPortLayer,
        ShardingConfig.layer()
      )),
      Effect.scoped
    )
  )
})
```

**Note:** Full sendMessage testing requires a mock or real `TurnProcessingRuntime` + workflow stack. The test may need to provide a mock runtime that returns a predetermined stream. Adjust during implementation based on what's feasible. At minimum, verify createChannel + getHistory work.

**Step 3: Run test**

Run: `bun run test -- packages/server/test/ChannelEntity.test.ts`
Expected: Tests pass.

**Step 4: Verify**

Run: `bun run check`
Expected: Zero errors.

**Step 5: Commit**

```bash
git add packages/server/src/entities/ChannelEntity.ts packages/server/test/ChannelEntity.test.ts
git commit -m "feat(server): add ChannelEntity with createChannel, sendMessage, getHistory"
```

---

## Task 5: Create ProxyGateway

Wire EntityProxy to auto-derive HTTP endpoints from all entities.

**Files:**
- Create: `packages/server/src/gateway/ProxyGateway.ts`

**Step 1: Create `packages/server/src/gateway/ProxyGateway.ts`**

```typescript
import { Effect, Layer } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { EntityProxy, EntityProxyServer } from "effect/unstable/cluster"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AgentEntity } from "../entities/AgentEntity.js"
import { SessionEntity } from "../entities/SessionEntity.js"
import { GovernanceEntity } from "../entities/GovernanceEntity.js"
import { MemoryEntity } from "../entities/MemoryEntity.js"
import { ChannelEntity } from "../entities/ChannelEntity.js"

// Auto-derive HTTP API groups from entity RPCs
const ChannelHttpApi = EntityProxy.toHttpApiGroup("channels", ChannelEntity)
const SessionHttpApi = EntityProxy.toHttpApiGroup("sessions", SessionEntity)
const AgentHttpApi = EntityProxy.toHttpApiGroup("agents", AgentEntity)
const GovernanceHttpApi = EntityProxy.toHttpApiGroup("governance", GovernanceEntity)
const MemoryHttpApi = EntityProxy.toHttpApiGroup("memory", MemoryEntity)

// Combine into a single HttpApi
const ProxyApi = HttpApi.make("proxy")
  .add(ChannelHttpApi)
  .add(SessionHttpApi)
  .add(AgentHttpApi)
  .add(GovernanceHttpApi)
  .add(MemoryHttpApi)

// Auto-implement handlers for each group
const handlersLayer = Layer.mergeAll(
  EntityProxyServer.layerHttpApi(ProxyApi, "channels", ChannelEntity),
  EntityProxyServer.layerHttpApi(ProxyApi, "sessions", SessionEntity),
  EntityProxyServer.layerHttpApi(ProxyApi, "agents", AgentEntity),
  EntityProxyServer.layerHttpApi(ProxyApi, "governance", GovernanceEntity),
  EntityProxyServer.layerHttpApi(ProxyApi, "memory", MemoryEntity)
)

// Health check endpoint (plain HttpRouter, not entity-based)
const healthRouter = HttpRouter.add(
  "GET",
  "/health",
  () =>
    Effect.succeed(
      HttpServerResponse.json({
        status: "ok",
        service: "personal-agent"
      })
    )
)

// Export the combined API layer + health route
export const ProxyApiLive = HttpApiBuilder.layer(ProxyApi).pipe(
  Layer.provide(handlersLayer)
)

export const ProxyHealthRoute = healthRouter

export { ProxyApi }
```

**Important:** The exact import paths and API may differ. During implementation:
1. Check if `EntityProxy` and `EntityProxyServer` are exported from `effect/unstable/cluster` or need separate imports
2. Check if `HttpApi.make("proxy").add(group)` or `.addGroup(group)` is the correct API
3. Check if `HttpApiBuilder` is from `effect/unstable/httpapi`
4. Consult `.reference/effect/packages/effect/src/unstable/cluster/EntityProxy.ts` for exact exports

**Step 2: Verify**

Run: `bun run check`
Expected: Zero errors (or known issues to fix).

**Step 3: Commit**

```bash
git add packages/server/src/gateway/ProxyGateway.ts
git commit -m "feat(server): add ProxyGateway with EntityProxy-derived HTTP endpoints"
```

---

## Task 6: Wire Server and Delete Old Files

**Files:**
- Modify: `packages/server/src/server.ts` (replace ApiLive + TurnStreamingLayer)
- Delete: `packages/server/src/Api.ts`
- Delete: `packages/server/src/TurnStreamingRouter.ts`
- Delete: `packages/domain/src/RuntimeApi.ts`

**Step 1: Update `packages/server/src/server.ts`**

Key changes:
1. Remove imports: `ApiLive` from `./Api.js`, `TurnStreamingLayer` from `./TurnStreamingRouter.js`
2. Add imports: `ProxyApiLive`, `ProxyHealthRoute` from `./gateway/ProxyGateway.js`, `ChannelPortSqlite` from `./ChannelPortSqlite.js`, `ChannelEntity` layer, `ChannelPortTag`
3. Add channel port layers (same pattern as other ports):

```typescript
const channelPortSqliteLayer = ChannelPortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)

const channelPortTagLayer = Layer.effect(
  ChannelPortTag,
  Effect.gen(function*() {
    return (yield* ChannelPortSqlite) as ChannelPort
  })
).pipe(Layer.provide(channelPortSqliteLayer))

const channelEntityLayer = ChannelEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(channelPortTagLayer),
  Layer.provide(sessionTurnPortTagLayer)
)
```

4. Add channel layers to `PortsLive` Layer.mergeAll
5. Replace `HttpApiAndStreamingLive`:

```typescript
const HttpApiAndProxyLive = Layer.mergeAll(
  ProxyApiLive,
  ProxyHealthRoute
).pipe(
  Layer.provide(PortsLive),
  Layer.provide(clusterLayer)
)
```

6. Update `HttpLive` to use `HttpApiAndProxyLive`

**Step 2: Delete old files**

```bash
rm packages/server/src/Api.ts
rm packages/server/src/TurnStreamingRouter.ts
rm packages/domain/src/RuntimeApi.ts
```

**Step 3: Fix any remaining imports**

Search for imports of deleted files and update:
- `RuntimeClient.ts` imports `RuntimeApi` — will be rewritten in Task 7
- Any test files importing from RuntimeApi — update to events.ts

**Step 4: Verify**

Run: `bun run check`
Expected: Errors only in CLI package (RuntimeClient.ts references deleted RuntimeApi). Server package should compile.

**Step 5: Run server tests**

Run: `bun run test -- packages/server/`
Expected: All server tests pass. (Existing tests that imported RuntimeApi events should have been updated in Task 1.)

**Step 6: Commit**

```bash
git add -u
git add packages/server/src/gateway/ProxyGateway.ts packages/server/src/server.ts
git commit -m "feat(server): wire ProxyGateway, delete hand-coded Api + TurnStreamingRouter + RuntimeApi"
```

---

## Task 7: Rewrite CLI for `agent chat`

**Files:**
- Modify: `packages/cli/src/RuntimeClient.ts` (rewrite as ChatClient)
- Modify: `packages/cli/src/Cli.ts` (add chat command)
- Modify: `packages/cli/src/bin.ts` (update layer)

**Step 1: Rewrite `packages/cli/src/RuntimeClient.ts` → ChatClient**

Replace the entire file. Use raw `HttpClient` for POST requests and SSE stream parsing:

```typescript
import { Effect, Layer, Schema, ServiceMap, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { TurnStreamEvent } from "@template/domain/events"

const BASE_URL = "http://localhost:3000"

export class ChatClient extends ServiceMap.Service<ChatClient>()("cli/ChatClient", {
  make: Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient

    const createChannel = (channelId: string, agentId: string) =>
      httpClient.execute(
        HttpClientRequest.post(`${BASE_URL}/createchannel/${channelId}`).pipe(
          HttpClientRequest.jsonBody({ channelType: "CLI", agentId })
        )
      ).pipe(
        Effect.asVoid,
        Effect.scoped
      )

    const sendMessage = (channelId: string, content: string) =>
      httpClient.execute(
        HttpClientRequest.post(`${BASE_URL}/sendmessage/${channelId}`).pipe(
          HttpClientRequest.jsonBody({ content })
        )
      ).pipe(
        Effect.map((response) =>
          response.stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.startsWith("data: ")),
            Stream.map((line) => line.slice(6)),
            Stream.map((json) => JSON.parse(json) as TurnStreamEvent)
          )
        )
      )

    const health = httpClient.execute(
      HttpClientRequest.get(`${BASE_URL}/health`)
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap((body) => Effect.logInfo(body)),
      Effect.scoped
    )

    return {
      createChannel,
      sendMessage,
      health
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
```

**Important SSE parsing note:** The `Stream.splitLines` + filter `data:` approach is a simplified SSE parser. EntityProxy may use a different streaming format (e.g., JSON lines, ndjson, or Effect's internal stream encoding). During implementation, inspect the actual response format from the proxy endpoint and adjust the parser accordingly. You may need to consult `.reference/effect/packages/effect/src/unstable/cluster/EntityProxyServer.ts` to see how streaming responses are encoded.

**Step 2: Rewrite `packages/cli/src/Cli.ts`**

```typescript
import { Args, Command, Options } from "effect/unstable/cli"
import { Console, Effect, Stream } from "effect"
import { ChatClient } from "./RuntimeClient.js"
import * as readline from "node:readline"

const channelOption = Options.text("channel").pipe(
  Options.withDescription("Channel ID to resume"),
  Options.optional
)

const newFlag = Options.boolean("new").pipe(
  Options.withDescription("Start a fresh channel"),
  Options.withDefault(false)
)

const chat = Command.make("chat", { channel: channelOption, new: newFlag }).pipe(
  Command.withDescription("Interactive chat with the agent"),
  Command.withHandler(({ channel, new: isNew }) =>
    ChatClient.use((client) =>
      Effect.gen(function*() {
        // Resolve or create channel
        const channelId = channel ?? `channel:${crypto.randomUUID()}`

        yield* Effect.logInfo(`Creating channel ${channelId}...`)
        yield* client.createChannel(channelId, "agent:bootstrap")
        yield* Effect.logInfo("Channel ready. Type your message (Ctrl+C to exit).\n")

        // REPL loop
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        })

        const prompt = () =>
          Effect.async<string>((resume) => {
            rl.question("> ", (answer) => {
              resume(Effect.succeed(answer))
            })
          })

        let running = true
        rl.on("close", () => { running = false })

        while (running) {
          const input = yield* prompt()
          if (!input.trim()) continue

          const streamEffect = yield* client.sendMessage(channelId, input)
          yield* streamEffect.pipe(
            Stream.tap((event) => {
              switch (event.type) {
                case "turn.started":
                  return Console.log("")
                case "assistant.delta":
                  return Effect.sync(() => process.stdout.write(event.delta))
                case "tool.call":
                  return Console.log(`\n[tool: ${event.toolName}]`)
                case "tool.result":
                  return Console.log(`[result: ${event.outputJson}]`)
                case "turn.completed":
                  return Console.log("\n")
                case "turn.failed":
                  return Console.log(`\n[error: ${event.errorCode}: ${event.message}]\n`)
              }
            }),
            Stream.runDrain
          )
        }

        rl.close()
      })
    )
  )
)

const status = Command.make("status").pipe(
  Command.withDescription("Check server health"),
  Command.withHandler(() => ChatClient.use((client) => client.health))
)

const command = Command.make("agent").pipe(
  Command.withSubcommands([chat, status])
)

export const cli = Command.run(command, {
  version: "0.0.0"
})
```

**Step 3: Update `packages/cli/src/bin.ts`**

```typescript
#!/usr/bin/env bun

import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { cli } from "./Cli.js"
import { ChatClient } from "./RuntimeClient.js"

const MainLive = ChatClient.layer.pipe(
  Layer.provide(BunHttpClient.layer),
  Layer.merge(BunServices.layer)
)

cli.pipe(
  Effect.provide(MainLive),
  BunRuntime.runMain
)
```

**Step 4: Verify**

Run: `bun run check`
Expected: Zero TypeScript errors.

**Step 5: Commit**

```bash
git add packages/cli/src/RuntimeClient.ts packages/cli/src/Cli.ts packages/cli/src/bin.ts
git commit -m "feat(cli): add agent chat command with streaming REPL"
```

---

## Task 8: Integration Test

**Files:**
- Create: `packages/server/test/ProxyGateway.e2e.test.ts`

**Step 1: Create integration test**

This test verifies the HTTP round-trip through EntityProxy. It requires the full server layer stack (SQLite, migrations, cluster, entities, proxy).

```typescript
import { it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// Import the ChannelEntity client for direct entity testing
// (avoids HTTP setup complexity for this first e2e test)
import { ChannelEntity } from "../src/entities/ChannelEntity.js"
import { ShardingConfig } from "effect/unstable/cluster"
// ... layer setup matching server.ts but with test SQLite path

describe("ProxyGateway E2E", () => {
  // Build a test layer stack that mirrors server.ts but uses test SQLite
  // This is a direct entity client test, not HTTP —
  // HTTP testing requires starting an actual server which is complex.
  // For this slice, verify entity-level integration.

  it.effect("createChannel then sendMessage streams events", () =>
    Effect.gen(function*() {
      // Create channel
      const makeChannelClient = yield* ChannelEntity.client
      const channelId = `channel:${crypto.randomUUID()}`
      const client = makeChannelClient(channelId)

      yield* client.createChannel({
        channelType: "CLI",
        agentId: "agent:bootstrap"
      })

      // Send message and collect stream events
      const events = yield* client.sendMessage({ content: "Hello agent" }).pipe(
        Stream.take(1), // At minimum get the first event
        Stream.runCollect
      )

      expect(events.length).toBeGreaterThan(0)
    }).pipe(
      Effect.provide(/* full test layer */),
      Effect.scoped
    )
  )
})
```

**Note:** The full integration test layer is complex — it needs SQLite, migrations, all port layers, all entity layers, TurnProcessingRuntime (which needs WorkflowEngine, ChatPersistence, LanguageModel, ToolRegistry, etc.). During implementation, determine the minimum viable test layer. Consider:
1. Mocking TurnProcessingRuntime to return a predetermined stream
2. Or wiring the full stack with a mock LanguageModel

**Step 2: Run test**

Run: `bun run test -- packages/server/test/ProxyGateway.e2e.test.ts`

**Step 3: Run full test suite**

Run: `bun run test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add packages/server/test/ProxyGateway.e2e.test.ts
git commit -m "test(server): add ProxyGateway integration test"
```

---

## Task 9: Final Verification and Cleanup

**Step 1: Full type check**

Run: `bun run check`
Expected: Zero errors.

**Step 2: Full test suite**

Run: `bun run test`
Expected: All tests pass.

**Step 3: Lint**

Run: `bun run lint`
Expected: No lint errors.

**Step 4: Manual smoke test**

```bash
# Terminal 1: Start server
bun run packages/server/src/server.ts

# Terminal 2: Test health
curl http://localhost:3000/health

# Terminal 3: Test CLI
bun run packages/cli/src/bin.ts agent status
bun run packages/cli/src/bin.ts agent chat
```

**Step 5: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: final cleanup for channel + gateway vertical slice"
```

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| EntityProxy streaming format unknown | Inspect actual response during Task 5. May need to keep thin SSE adapter if proxy uses different format. |
| Entity-to-entity RPC (Channel → Session) | Verify `SessionEntity.client` works inside ChannelEntity handler. Both entities share Sharding context. |
| `HttpApi.add()` vs `.addGroup()` | Check exact API in `.reference/effect/packages/effect/src/unstable/http/HttpApi.ts` |
| EntityProxy import path | May be `effect/unstable/cluster/EntityProxy` not `effect/unstable/cluster` barrel |
| CLI SSE parsing | EntityProxy may encode streams differently than manual SSE. Adjust parser. |
| Full integration test layer | May need significant layer setup. Start with entity-level tests, add HTTP later. |
