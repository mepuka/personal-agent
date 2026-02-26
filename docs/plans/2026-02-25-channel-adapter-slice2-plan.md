# Channel Adapter Slice 2: Contract Unification + Integration Foundation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify the adapter RPC contract, fix Slice 1 correctness gaps, fill test coverage holes, and lay the ExternalService/Integration foundation.

**Architecture:** Three groups — (A) correctness fixes that unify CLI and WebChat under a single AdapterProtocol, (B) test completeness for WS e2e and concurrency, (C) domain schemas + skeleton persistence + stub entity for ExternalService/Integration. All changes are additive or rename-only; no behavioral regressions.

**Tech Stack:** Effect (Schema.Class, ServiceMap, Entity, Rpc), Bun WebSocket, SQLite migrations

---

## Task 1: Promote TurnRecordSchema to domain

**Files:**
- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/server/src/entities/AdapterProtocol.ts`
- Modify: `packages/server/src/entities/CLIAdapterEntity.ts`

### Requirements

Convert the `TurnRecord` interface in `ports.ts` to a `Schema.Class` so it serves as both the runtime type and the RPC serialisation schema. Remove the duplicate hand-maintained `TurnRecordSchema` from `AdapterProtocol.ts`.

In `packages/domain/src/ports.ts`, replace the `TurnRecord` interface (lines 110-121) with:

```typescript
export class TurnRecord extends Schema.Class<TurnRecord>("TurnRecord")({
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  turnIndex: Schema.Number,
  participantRole: Schema.String,
  participantAgentId: Schema.Union([Schema.String, Schema.Null]),
  message: MessageRecord,
  modelFinishReason: Schema.Union([ModelFinishReason, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  createdAt: Schema.DateTimeUtcFromString
}) {}
```

Add `ModelFinishReason` import from `./status.js`. Export `TurnRecord` from `index.ts` (already exported via `ports.js` barrel).

In `AdapterProtocol.ts`, remove the `TurnRecordSchema` definition (lines 20-42) and import `TurnRecord` from `@template/domain/ports`. Replace `Schema.Array(TurnRecordSchema)` with `Schema.Array(TurnRecord)` in `GetHistoryRpc`.

In `CLIAdapterEntity.ts`, remove the `TurnRecordSchema` import from `./AdapterProtocol.js` and import `TurnRecord` from `@template/domain/ports` instead. Replace `Schema.Array(TurnRecordSchema)` with `Schema.Array(TurnRecord)` in `GetHistoryRpc`.

**Note:** `TurnRecord` was previously an interface used by `SessionTurnPort.listTurns` and `SessionTurnPort.appendTurn`. Converting to Schema.Class keeps the same shape but makes it a class. All places that construct `TurnRecord` objects will still work since Schema.Class instances can be created with plain objects. However, type annotations using `TurnRecord` as an interface will now reference the class — verify that `SessionTurnPortSqlite` and `TurnProcessingWorkflow` still compile.

### Verify

```bash
bun run check
bun run test
```

---

## Task 2: Add `ChannelTypeMismatch` error + re-init validation

**Files:**
- Modify: `packages/domain/src/errors.ts`
- Modify: `packages/server/src/ChannelCore.ts`
- Modify: `packages/server/test/ChannelCore.test.ts`

### Requirements

Add to `packages/domain/src/errors.ts`:

```typescript
export class ChannelTypeMismatch extends Schema.ErrorClass<ChannelTypeMismatch>("ChannelTypeMismatch")({
  _tag: Schema.tag("ChannelTypeMismatch"),
  channelId: Schema.String,
  existingType: Schema.String,
  requestedType: Schema.String
}) {}
```

In `ChannelCore.ts`, modify `initializeChannel` (lines 56-59). When `existing !== null`, validate that `existing.channelType === params.channelType` and `existing.agentId === params.agentId`. If type mismatches, yield `ChannelTypeMismatch`. If agent mismatches, also yield `ChannelTypeMismatch` (reuse the error — agent mismatch is the same class of problem).

Update the `initializeChannel` type signature to include `ChannelTypeMismatch` in its error channel.

Add tests to `ChannelCore.test.ts`:
- Re-init with matching type/agent succeeds (idempotent — already tested, verify still passes)
- Re-init with different channelType fails with `ChannelTypeMismatch`
- Re-init with different agentId fails with `ChannelTypeMismatch`

### Verify

```bash
bun run check
bun run test
```

---

## Task 3: Add userId to AdapterProtocol + turn payloads

**Files:**
- Modify: `packages/server/src/entities/AdapterProtocol.ts`
- Modify: `packages/server/src/ChannelCore.ts`
- Modify: `packages/server/src/turn/TurnProcessingWorkflow.ts`
- Modify: `packages/server/src/entities/CLIAdapterEntity.ts`
- Modify: `packages/server/src/entities/WebChatAdapterEntity.ts`
- Modify: `packages/server/src/gateway/WebChatRoutes.ts`
- Modify: `packages/server/src/gateway/ChannelRoutes.ts`

### Requirements

**AdapterProtocol.ts:** Add `userId: Schema.String` to `InitializeRpc` payload (alongside `channelType` and `agentId`).

**ChannelCore.ts:** Add `userId: string` to `initializeChannel` params. Thread it into `buildTurnPayload` — store on the returned `ProcessTurnPayload`.

**TurnProcessingWorkflow.ts:** Add `userId: Schema.String` to `ProcessTurnPayload` schema (line 30-40). The workflow doesn't need to use it yet — it's carried for audit trail.

**CLIAdapterEntity.ts:** Pass `userId: "user:cli:local"` in the `initialize` handler.

**WebChatAdapterEntity.ts:** Pass `userId: request.payload.userId` in the `initialize` handler.

**WebChatRoutes.ts:** Pass `userId` from the init frame into `client.initialize({ ..., userId: frame.userId })`. Also carry `userId` into `buildTurnPayload` if available (store it on the connection state alongside `initialized`).

**ChannelRoutes.ts:** Pass `userId: "user:cli:local"` in the create channel handler (will be renamed in Task 4).

### Verify

```bash
bun run check
bun run test
```

---

## Task 4: Unify CLI adapter to shared AdapterProtocol RPCs

**Files:**
- Modify: `packages/server/src/entities/CLIAdapterEntity.ts`
- Modify: `packages/server/src/gateway/ChannelRoutes.ts`
- Modify: `packages/cli/src/RuntimeClient.ts`
- Modify: `packages/server/test/CLIAdapterEntity.test.ts`
- Modify: `packages/server/test/ChannelRoutes.e2e.test.ts`

### Requirements

**CLIAdapterEntity.ts:** Remove private RPC definitions (`CreateChannelRpc`, `SendMessageRpc`, `GetHistoryRpc`). Import and use `InitializeRpc`, `ReceiveMessageRpc`, `GetHistoryRpc`, `GetStatusRpc` from `./AdapterProtocol.js`. Update the entity definition:

```typescript
export const CLIAdapterEntity = Entity.make("CLIAdapter", [
  InitializeRpc,
  ReceiveMessageRpc,
  GetHistoryRpc,
  GetStatusRpc
])
```

Update `toLayer` handler names: `createChannel` → `initialize`, `sendMessage` → `receiveMessage`. Add `getStatus` handler (same pattern as WebChatAdapterEntity — read from ChannelPortTag). Add `ChannelPortTag` dependency.

**ChannelRoutes.ts:** Rename routes:
- `POST /channels/:channelId/create` → `POST /channels/:channelId/initialize`
- `POST /channels/:channelId/history` → `GET /channels/:channelId/history`
- Add new `GET /channels/:channelId/status` route
- Keep `POST /channels/:channelId/messages` (calls `receiveMessage` internally)

Update internal calls: `client.createChannel(...)` → `client.initialize(...)`, `client.sendMessage(...)` → `client.receiveMessage(...)`.

**RuntimeClient.ts:** Update `createChannel` to call `/channels/${channelId}/initialize` instead of `/channels/${channelId}/create`. Rename the method from `createChannel` to `initialize` for consistency.

**CLIAdapterEntity.test.ts:** Update test calls from `client.createChannel(...)` to `client.initialize(...)` and `client.sendMessage(...)` to `client.receiveMessage(...)`. Add a test for `getStatus`.

**ChannelRoutes.e2e.test.ts:** Update all HTTP calls to use the new route paths (`/channels/:id/initialize` instead of `/channels/:id/create`).

### Verify

```bash
bun run check
bun run test
```

---

## Task 5: Enforce `channels.cli.enabled` config gating

**Files:**
- Modify: `packages/server/src/server.ts`

### Requirements

Gate `cliAdapterEntityLayer` and `ChannelRoutesLayer` with `Layer.unwrap` + `config.channels.cli.enabled`, mirroring the existing WebChat gating pattern (lines 221-233 in server.ts).

Replace the unconditional `cliAdapterEntityLayer` (line 216-219) with:

```typescript
const cliAdapterEntityLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    if (!config.channels.cli.enabled) {
      return Layer.empty
    }
    return CLIAdapterEntityLayer.pipe(
      Layer.provide(clusterLayer),
      Layer.provide(channelCoreLayer),
      Layer.provide(channelPortTagLayer)
    )
  }).pipe(Effect.provide(agentConfigLayer))
)
```

Similarly gate `ChannelRoutesLayer` in `HttpApiAndRoutesLive`:

```typescript
const cliRoutesLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    if (!config.channels.cli.enabled) {
      return Layer.empty
    }
    return ChannelRoutesLayer
  }).pipe(Effect.provide(agentConfigLayer))
)
```

**Note:** CLIAdapterEntity now needs `channelPortTagLayer` (added in Task 4 for `getStatus`).

### Verify

```bash
bun run check
bun run test
```

---

## Task 6: Align WS message-processing errors with `turn.failed`

**Files:**
- Modify: `packages/server/src/gateway/WebChatRoutes.ts`
- Modify: `packages/server/test/WebChatRoutes.e2e.test.ts`

### Requirements

In `WebChatRoutes.ts`, the `MESSAGE_ERROR` case (lines 156-161) currently sends `{type:"error", code:"MESSAGE_ERROR", message:...}`. Change it to send a `TurnFailedEvent` shape:

```typescript
Stream.runForEach((event) => writeFn(turnEventToFrame(event))),
Effect.catchCause((cause) => {
  const err = Cause.squash(cause)
  const failedEvent = {
    type: "turn.failed" as const,
    sequence: Number.MAX_SAFE_INTEGER,
    turnId: "",
    sessionId: "",
    errorCode: "MESSAGE_ERROR",
    message: err instanceof Error ? err.message : String(err)
  }
  return writeFn(JSON.stringify(failedEvent)).pipe(Effect.ignore)
})
```

Add `Cause` to the Effect imports.

Keep protocol-level errors (`INVALID_FRAME`, `NOT_INITIALIZED`, `ALREADY_INITIALIZED`, `INIT_FAILED`, `UNKNOWN_FRAME`) as `{type:"error"}` — these are transport concerns.

Update the `errorFrame` helper JSDoc to clarify it's for transport-level errors only.

### Verify

```bash
bun run check
bun run test
```

---

## Task 7: Domain types — IntegrationStatus, ConnectionStatus, ExternalService, ServiceCapability

**Files:**
- Modify: `packages/domain/src/status.ts`
- Create: `packages/domain/src/integration.ts`
- Modify: `packages/domain/src/ids.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/test/IntegrationSchema.test.ts`

### Requirements

**ids.ts:** Add:

```typescript
export const IntegrationId = Schema.String.pipe(Schema.brand("IntegrationId"))
export type IntegrationId = typeof IntegrationId.Type

export const ExternalServiceId = Schema.String.pipe(Schema.brand("ExternalServiceId"))
export type ExternalServiceId = typeof ExternalServiceId.Type
```

**status.ts:** Add:

```typescript
export const IntegrationStatus = Schema.Literals([
  "Connected",
  "Disconnected",
  "Error",
  "Initializing"
])
export type IntegrationStatus = typeof IntegrationStatus.Type

export const ConnectionStatus = Schema.Literals([
  "Open",
  "Closed",
  "Reconnecting",
  "Failed"
])
export type ConnectionStatus = typeof ConnectionStatus.Type

export const ServiceTransport = Schema.Literals([
  "stdio",
  "sse",
  "http"
])
export type ServiceTransport = typeof ServiceTransport.Type
```

**integration.ts:** Create with:

```typescript
import { Schema } from "effect"
import type { AgentId, ExternalServiceId, IntegrationId } from "./ids.js"
import type { IntegrationStatus, ServiceTransport } from "./status.js"
import type { Instant } from "./ports.js"

export class ServiceToolCapability extends Schema.Class<ServiceToolCapability>("ServiceToolCapability")({
  _tag: Schema.tag("ServiceToolCapability"),
  name: Schema.String,
  description: Schema.optional(Schema.String)
}) {}

export class ServiceResourceCapability extends Schema.Class<ServiceResourceCapability>("ServiceResourceCapability")({
  _tag: Schema.tag("ServiceResourceCapability"),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String)
}) {}

export class ServicePromptCapability extends Schema.Class<ServicePromptCapability>("ServicePromptCapability")({
  _tag: Schema.tag("ServicePromptCapability"),
  name: Schema.String,
  description: Schema.optional(Schema.String)
}) {}

export const ServiceCapability = Schema.Union([
  ServiceToolCapability,
  ServiceResourceCapability,
  ServicePromptCapability
])
export type ServiceCapability = typeof ServiceCapability.Type

export interface ExternalServiceRecord {
  readonly serviceId: ExternalServiceId
  readonly name: string
  readonly endpoint: string
  readonly transport: ServiceTransport
  readonly identifier: string
  readonly createdAt: Instant
}

export interface IntegrationRecord {
  readonly integrationId: IntegrationId
  readonly agentId: AgentId
  readonly serviceId: ExternalServiceId
  readonly status: IntegrationStatus
  readonly capabilities: ReadonlyArray<ServiceCapability>
  readonly createdAt: Instant
  readonly updatedAt: Instant
}
```

**index.ts:** Add `export * from "./integration.js"`.

**IntegrationSchema.test.ts:** Test encode/decode for each `ServiceCapability` variant and `ExternalServiceRecord`/`IntegrationRecord` shapes.

### Verify

```bash
bun run check
bun run test
```

---

## Task 8: Integration config in AgentConfig

**Files:**
- Modify: `packages/domain/src/config.ts`
- Modify: `packages/server/src/ai/AgentConfig.ts`
- Modify: `packages/domain/test/ConfigSchema.test.ts`
- Modify: `packages/server/test/AgentConfig.test.ts`
- Modify: `agent.yaml.example`

### Requirements

**config.ts:** Add after `ChannelsConfigSchema`:

```typescript
export const IntegrationConfigSchema = Schema.Struct({
  serviceId: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  transport: Schema.Literals(["stdio", "sse", "http"])
})
export type IntegrationConfig = typeof IntegrationConfigSchema.Type

export const IntegrationsConfigSchema = Schema.Array(IntegrationConfigSchema)
export type IntegrationsConfig = typeof IntegrationsConfigSchema.Type
```

Add to `AgentConfigFileSchema`:

```typescript
integrations: IntegrationsConfigSchema.pipe(
  Schema.withDecodingDefaultKey(() => [] as IntegrationsConfig)
)
```

**AgentConfig.ts:** Add `readonly integrations: IntegrationsConfig` to `AgentConfigService` interface. Wire `integrations: config.integrations` in `makeFromParsed`.

**ConfigSchema.test.ts:** Test that `integrations` defaults to `[]`, and test parsing a config with integrations defined.

**AgentConfig.test.ts:** Test that `AgentConfig.integrations` is accessible and defaults empty.

**agent.yaml.example:** Add:

```yaml
# integrations:
#   - serviceId: "svc:example"
#     name: "Example Service"
#     endpoint: "http://localhost:8080"
#     transport: "http"
```

### Verify

```bash
bun run check
bun run test
```

---

## Task 9: IntegrationPort + persistence

**Files:**
- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/server/src/persistence/DomainMigrator.ts`
- Create: `packages/server/src/IntegrationPortSqlite.ts`
- Modify: `packages/server/src/PortTags.ts`
- Create: `packages/server/test/IntegrationPortSqlite.test.ts`

### Requirements

**ports.ts:** Add:

```typescript
export interface IntegrationPort {
  readonly createService: (service: ExternalServiceRecord) => Effect.Effect<void>
  readonly getService: (serviceId: ExternalServiceId) => Effect.Effect<ExternalServiceRecord | null>
  readonly createIntegration: (integration: IntegrationRecord) => Effect.Effect<void>
  readonly getIntegration: (integrationId: IntegrationId) => Effect.Effect<IntegrationRecord | null>
  readonly getIntegrationByService: (agentId: AgentId, serviceId: ExternalServiceId) => Effect.Effect<IntegrationRecord | null>
  readonly updateStatus: (integrationId: IntegrationId, status: IntegrationStatus) => Effect.Effect<void>
}
```

Add necessary imports from `./ids.js`, `./integration.js`, `./status.js`.

**DomainMigrator.ts:** Add migration `0005_integration_tables`:

```typescript
"0005_integration_tables": Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_services (
      service_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('stdio', 'sse', 'http')),
      identifier TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `.unprepared

  yield* sql`
    CREATE TABLE IF NOT EXISTS integrations (
      integration_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Connected', 'Disconnected', 'Error', 'Initializing')),
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `.unprepared

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS integrations_agent_service_idx
    ON integrations (agent_id, service_id)
  `.unprepared
})
```

**IntegrationPortSqlite.ts:** Implement `IntegrationPort` using `ServiceMap.Service` pattern (follow `ChannelPortSqlite` as reference). Use `Schema.fromJsonString(Schema.Array(ServiceCapability))` for capabilities JSON encoding (same pattern as `ChannelPortSqlite` uses for capabilities).

**PortTags.ts:** Add:

```typescript
export const IntegrationPortTag = ServiceMap.Service<IntegrationPort>("server/ports/IntegrationPort")
```

**IntegrationPortSqlite.test.ts:** Test CRUD operations: create service, get service, create integration, get by ID, get by agent+service, update status. Test capabilities JSON roundtrip.

### Verify

```bash
bun run check
bun run test
```

---

## Task 10: Skeleton IntegrationEntity

**Files:**
- Create: `packages/server/src/entities/IntegrationEntity.ts`
- Modify: `packages/server/src/server.ts`
- Create: `packages/server/test/IntegrationEntity.test.ts`

### Requirements

**IntegrationEntity.ts:** Create with three RPCs:

```typescript
import { Schema } from "effect"
import { ClusterSchema } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"

const ConnectRpc = Rpc.make("connect", {
  payload: {
    serviceId: Schema.String,
    name: Schema.String,
    endpoint: Schema.String,
    transport: Schema.Literals(["stdio", "sse", "http"])
  },
  success: Schema.Void,
  primaryKey: ({ serviceId }) => `connect:${serviceId}`
}).annotate(ClusterSchema.Persisted, true)

const DisconnectRpc = Rpc.make("disconnect", {
  payload: {},
  success: Schema.Void
})

const GetStatusRpc = Rpc.make("getIntegrationStatus", {
  payload: {},
  success: Schema.Struct({
    integrationId: Schema.String,
    serviceId: Schema.String,
    status: Schema.String,
    capabilities: Schema.Array(ServiceCapability)
  }),
  error: IntegrationNotFound
})
```

Entity name: `"Integration"`. Entity ID is the `integrationId`.

Stub implementation:
- `connect`: Creates ExternalServiceRecord + IntegrationRecord via IntegrationPortTag. Sets status to `"Connected"` directly (no actual connection).
- `disconnect`: Updates status to `"Disconnected"` via `updateStatus`.
- `getIntegrationStatus`: Reads from IntegrationPortTag.

Add `IntegrationNotFound` error to `packages/domain/src/errors.ts`.

**server.ts:** Import and wire `IntegrationEntity`. Conditionally include based on whether `config.integrations` is non-empty:

```typescript
const integrationEntityLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    if (config.integrations.length === 0) {
      return Layer.empty
    }
    return IntegrationEntityLayer.pipe(
      Layer.provide(clusterLayer),
      Layer.provide(integrationPortTagLayer)
    )
  }).pipe(Effect.provide(agentConfigLayer))
)
```

**IntegrationEntity.test.ts:** Test connect (creates records), disconnect (updates status), getIntegrationStatus (returns snapshot), connect idempotency, getStatus for non-existent integration returns error.

### Verify

```bash
bun run check
bun run test
```

---

## Task 11: Bun WebSocket e2e tests

**Files:**
- Create: `packages/server/test/WebChatRoutes.ws.test.ts`

### Requirements

Uses `BunHttpServer` (from `@effect/platform-bun`) with `{ port: 0 }` to start on a random port. Connects via native `new WebSocket(url)`.

Guard tests with a runtime check so they only run under Bun:

```typescript
const isBun = typeof globalThis.Bun !== "undefined"
const describeWs = isBun ? describe : describe.skip
```

Test cases:
1. **Happy path:** connect → receives `{"type":"connected"}` → send init → receives `{"type":"initialized"}` → send message → receives `turn.started`, `assistant.delta`, `turn.completed` events
2. **Malformed frame:** send garbage → receives `{"type":"error","code":"INVALID_FRAME"}`
3. **Message before init:** send message frame before init → receives `NOT_INITIALIZED` error
4. **Double init:** send init twice → receives `ALREADY_INITIALIZED` error
5. **Disconnect cleanup:** connect, init, close socket — verify no unhandled promise rejections

Test layer: same as `WebChatAdapterEntity.test.ts` pattern with mock TurnProcessingRuntime, plus `WebChatRoutesLayer` and `BunHttpServer.layer({ port: 0 })`.

### Verify

```bash
bun run test
```

---

## Task 12: Missing test matrix items

**Files:**
- Modify: `packages/server/test/ChannelCore.test.ts`
- Modify: `packages/server/test/CLIAdapterEntity.test.ts`
- Modify: `packages/server/test/WebChatAdapterEntity.test.ts`

### Requirements

Add to `ChannelCore.test.ts`:
- **Cross-channel isolation:** Same `agentId`, two different `channelId`s → independent sessions, independent history
- **History after processed turn:** Initialize channel, send message, verify `getHistory` returns user + assistant turns

Add to `CLIAdapterEntity.test.ts` or `WebChatAdapterEntity.test.ts`:
- **Event ordering:** Verify streamed events come in order: `turn.started` first, then deltas/tool events, then `turn.completed` last
- **Concurrent messages on one channel:** Send two messages rapidly, verify both complete without turn index collision (mock runtime should handle sequentially)

### Verify

```bash
bun run check
bun run test
```

---

## Task 13: End-to-end verification

Run:

```bash
bun run check
bun run test
bun run start
```

Confirm:
- `/channels/:channelId/initialize` works (renamed from `/create`)
- `/channels/:channelId/messages` SSE works
- `/channels/:channelId/status` returns channel info
- `/ws/chat/:channelId` WebSocket flow works (init + message + streamed events)
- Config gating: both CLI and WebChat can be disabled independently

---

## Files Summary

| File | Action |
|------|--------|
| `packages/domain/src/errors.ts` | Add `ChannelTypeMismatch`, `IntegrationNotFound` |
| `packages/domain/src/ids.ts` | Add `IntegrationId`, `ExternalServiceId` |
| `packages/domain/src/ports.ts` | Promote `TurnRecord` to Schema.Class, add `IntegrationPort` |
| `packages/domain/src/status.ts` | Add `IntegrationStatus`, `ConnectionStatus`, `ServiceTransport` |
| `packages/domain/src/integration.ts` | Create — ServiceCapability, ExternalServiceRecord, IntegrationRecord |
| `packages/domain/src/config.ts` | Add `IntegrationConfigSchema`, `IntegrationsConfigSchema` |
| `packages/domain/src/index.ts` | Export integration module |
| `packages/domain/test/IntegrationSchema.test.ts` | Create — schema encode/decode tests |
| `packages/domain/test/ConfigSchema.test.ts` | Add integrations config tests |
| `packages/server/src/ChannelCore.ts` | Re-init validation, userId in buildTurnPayload |
| `packages/server/src/entities/AdapterProtocol.ts` | Add userId to InitializeRpc, import TurnRecord from domain |
| `packages/server/src/entities/CLIAdapterEntity.ts` | Use shared AdapterProtocol RPCs, add getStatus |
| `packages/server/src/entities/WebChatAdapterEntity.ts` | Pass userId through |
| `packages/server/src/entities/IntegrationEntity.ts` | Create — skeleton entity |
| `packages/server/src/gateway/ChannelRoutes.ts` | Rename routes, use AdapterProtocol RPC names |
| `packages/server/src/gateway/WebChatRoutes.ts` | Normalize message errors to turn.failed, pass userId |
| `packages/server/src/server.ts` | Gate CLI, wire IntegrationEntity |
| `packages/server/src/persistence/DomainMigrator.ts` | Add 0005_integration_tables |
| `packages/server/src/IntegrationPortSqlite.ts` | Create — integration persistence |
| `packages/server/src/PortTags.ts` | Add IntegrationPortTag |
| `packages/server/src/ai/AgentConfig.ts` | Surface integrations config |
| `packages/server/src/turn/TurnProcessingWorkflow.ts` | Add userId to ProcessTurnPayload |
| `packages/cli/src/RuntimeClient.ts` | Update endpoint paths, rename createChannel → initialize |
| `packages/server/test/ChannelCore.test.ts` | Add re-init, cross-channel, history tests |
| `packages/server/test/CLIAdapterEntity.test.ts` | Update RPC names, add getStatus test |
| `packages/server/test/WebChatAdapterEntity.test.ts` | Add event ordering, concurrent tests |
| `packages/server/test/ChannelRoutes.e2e.test.ts` | Update route paths |
| `packages/server/test/WebChatRoutes.ws.test.ts` | Create — Bun WS e2e tests |
| `packages/server/test/IntegrationPortSqlite.test.ts` | Create — persistence tests |
| `packages/server/test/IntegrationEntity.test.ts` | Create — entity tests |
| `packages/server/test/AgentConfig.test.ts` | Add integrations config tests |
| `agent.yaml.example` | Add integrations section |
