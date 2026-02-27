# Governance Hardening + Checkpoint Approval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the governance fail-open hole, expand policy actions beyond InvokeTool, and implement durable checkpoint-based human-in-the-loop approval with replay semantics.

**Architecture:** CheckpointPort as a new persistence port (not an entity). Governance evaluatePolicy expanded to 7 action types with default-deny. Checkpoints created on RequireApproval, with two distinct replay paths: turn-level replay for non-tool actions (re-runs full turn with bypass), tool-level replay for InvokeTool (executes approved tool + model continuation). Orchestration through ChannelCore.

**Tech Stack:** Effect (Schema, ServiceMap, Workflow, Activity), SQLite, Vitest

---

## Replay Contract

Three critical design decisions from review, documented here as binding constraints:

**1. New turnId on replay.** Every replay creates a fresh turnId. The original turn ended (with checkpoint_required). The replay is a new execution. This cleanly avoids idempotency collisions — the ToolRegistry idempotency key is `hash(turnId:iteration:toolName:inputJson)`, so a new turnId produces a new key. The old RequireApproval invocation record is never hit.

**2. Payload-hash binding.** Bypass verification checks that the action being replayed matches the checkpoint's recorded `payloadHash` (SHA-256 of canonical `action + toolName + inputJson` for InvokeTool, or `action` for non-tool). Prevents misuse of a checkpoint ID against a different action.

**3. Two replay paths.**

- **Turn-level replay** (non-tool actions like ReadMemory/WriteMemory): The full turn is re-run through ProcessTurnPayload → SessionEntity → TurnProcessingWorkflow, with `checkpointId` set on the payload. The workflow detects the checkpointId, verifies the checkpoint is Approved and matches the gated action, and bypasses the policy check. The rest of the workflow proceeds normally (token budget, persist user turn, model call, tool loop).

- **Tool-level replay** (InvokeTool): The original turn already completed (the model saw RequiresApproval as a tool error and responded). A new `replayToolCheckpoint` method on TurnProcessingRuntime: (a) executes the approved tool directly via ToolRegistry with bypass, (b) injects the tool call + result into the chat history, (c) calls `chat.generateText({ prompt: Prompt.empty, toolkit })` for the model to continue, (d) persists the assistant response, (e) streams events.

**4. Consumed state.** After successful replay, the checkpoint transitions from Approved → Consumed. If replay fails, the checkpoint stays Approved (retry allowed). Consumed is terminal.

**5. Terminal event behavior.** `turn.checkpoint_required` is NOT terminal alone. It is always followed by `turn.completed` with `accepted: false` and `auditReasonCode: "turn_processing_checkpoint_required"`. Backwards-compatible: clients that don't handle the new event still see a terminal `turn.completed`.

---

### Task 1: Domain types for checkpoints and expanded governance

**Files:**
- Modify: `packages/domain/src/ids.ts` (after line 55)
- Modify: `packages/domain/src/status.ts` (after line 176)
- Modify: `packages/domain/src/errors.ts` (after line 67)
- Modify: `packages/domain/src/events.ts` (after line 86, update union at line 88)
- Modify: `packages/domain/src/ports.ts` (lines 175-180, 209-211, add after ~line 407)

**Addresses review findings:** #5 (payload binding), #6 (consumed state), #7 (audit reason code), #9 (under-scoped governance)

**1a. Add `CheckpointId` to ids.ts** (after line 55):

```typescript
export const CheckpointId = Schema.String.pipe(Schema.brand("CheckpointId"))
export type CheckpointId = typeof CheckpointId.Type
```

**1b. Add `GovernanceAction` and `CheckpointStatus` to status.ts** (after line 176):

```typescript
export const GovernanceAction = Schema.Literals([
  "InvokeTool",
  "ReadMemory",
  "WriteMemory",
  "ExecuteSchedule",
  "SpawnSubAgent",
  "CreateGoal",
  "TransitionTask"
])
export type GovernanceAction = typeof GovernanceAction.Type

export const CheckpointStatus = Schema.Literals([
  "Pending",
  "Approved",
  "Rejected",
  "Deferred",
  "Expired",
  "Consumed"
])
export type CheckpointStatus = typeof CheckpointStatus.Type
```

Note: `Consumed` is the terminal state for successfully-replayed checkpoints.

**1c. Add checkpoint error classes to errors.ts** (after line 67):

```typescript
import { CheckpointId } from "./ids.js"

export class CheckpointNotFound extends Schema.ErrorClass<CheckpointNotFound>("CheckpointNotFound")({
  _tag: Schema.tag("CheckpointNotFound"),
  checkpointId: Schema.String
}) {}

export class CheckpointAlreadyDecided extends Schema.ErrorClass<CheckpointAlreadyDecided>("CheckpointAlreadyDecided")({
  _tag: Schema.tag("CheckpointAlreadyDecided"),
  checkpointId: Schema.String,
  currentStatus: Schema.String
}) {}

export class CheckpointExpired extends Schema.ErrorClass<CheckpointExpired>("CheckpointExpired")({
  _tag: Schema.tag("CheckpointExpired"),
  checkpointId: Schema.String
}) {}
```

**1d. Add `TurnCheckpointRequiredEvent` to events.ts** (after `TurnFailedEvent`, before the union):

```typescript
export class TurnCheckpointRequiredEvent extends Schema.Class<TurnCheckpointRequiredEvent>(
  "TurnCheckpointRequiredEvent"
)({
  type: Schema.Literal("turn.checkpoint_required"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  checkpointId: Schema.String,
  action: Schema.String,
  reason: Schema.String
}) {}
```

Update `TurnStreamEvent` union (line 89):

```typescript
export const TurnStreamEvent = Schema.Union([
  TurnStartedEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  IterationCompletedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  TurnCheckpointRequiredEvent
])
```

**1e. Expand `PolicyInput.action` in ports.ts** (line 178). Add import for `GovernanceAction` from `./status.js`:

```typescript
// Was: readonly action: "InvokeTool" | "WriteMemory" | "ReadMemory" | "ExecuteSchedule"
readonly action: GovernanceAction
```

**1f. Expand `PermissionPolicyRecord.action` in ports.ts** (line 211):

```typescript
// Was: readonly action: "InvokeTool"
readonly action: GovernanceAction
```

**1g. Add `CheckpointRecord` and `CheckpointPort` to ports.ts** (after GovernancePort). Add imports for `CheckpointId` from `./ids.js`, `GovernanceAction`, `CheckpointStatus` from `./status.js`, `CheckpointNotFound`, `CheckpointAlreadyDecided` from `./errors.js`:

```typescript
export interface CheckpointRecord {
  readonly checkpointId: CheckpointId
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly channelId: string
  readonly turnId: string
  readonly action: GovernanceAction
  readonly policyId: PolicyId | null
  readonly reason: string
  readonly payloadJson: string
  readonly payloadHash: string
  readonly status: CheckpointStatus
  readonly requestedAt: Instant
  readonly decidedAt: Instant | null
  readonly decidedBy: string | null
  readonly expiresAt: Instant | null
}

export interface CheckpointPort {
  readonly create: (checkpoint: CheckpointRecord) => Effect.Effect<void>
  readonly get: (checkpointId: CheckpointId) => Effect.Effect<CheckpointRecord | null>
  readonly transition: (
    checkpointId: CheckpointId,
    toStatus: CheckpointStatus,
    decidedBy: string,
    decidedAt: Instant
  ) => Effect.Effect<void, CheckpointNotFound | CheckpointAlreadyDecided>
  readonly listPending: (agentId?: AgentId) => Effect.Effect<ReadonlyArray<CheckpointRecord>>
}
```

Key fields: `channelId` (needed for replay to look up session/conversation), `payloadHash` (SHA-256 binding for bypass verification), `status` includes `Consumed`.

**Verify:** `cd packages/domain && bun run check`

---

### Task 2: Extend ProcessTurnPayload + SessionEntity + ProcessTurnResult

**Files:**
- Modify: `packages/server/src/turn/TurnProcessingWorkflow.ts` (lines 53-59, 62-81, 92-103)
- Modify: `packages/server/src/entities/SessionEntity.ts` (lines 24-43)

**Addresses review findings:** #2 (workflow-level bypass needs checkpointId), #3 (SessionEntity must carry checkpointId), #7 (audit reason code)

**2a. Add `"turn_processing_checkpoint_required"` to `TurnAuditReasonCode`** (TurnProcessingWorkflow.ts line 53-59):

```typescript
export const TurnAuditReasonCode = Schema.Literals([
  "turn_processing_accepted",
  "turn_processing_policy_denied",
  "turn_processing_requires_approval",
  "turn_processing_checkpoint_required",
  "turn_processing_token_budget_exceeded",
  "turn_processing_model_error"
])
```

**2b. Add `checkpointId` to `ProcessTurnPayload`** (TurnProcessingWorkflow.ts lines 62-81):

```typescript
export const ProcessTurnPayload = Schema.Struct({
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  agentId: Schema.String,
  userId: Schema.String,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlockSchema),
  createdAt: Schema.DateTimeUtc,
  inputTokens: Schema.Number,
  modelOverride: Schema.optionalKey(Schema.Struct({
    provider: Schema.String,
    modelId: Schema.String
  })),
  generationConfigOverride: Schema.optionalKey(Schema.Struct({
    temperature: Schema.optionalKey(Schema.Number),
    maxOutputTokens: Schema.optionalKey(Schema.Number),
    topP: Schema.optionalKey(Schema.Number)
  })),
  checkpointId: Schema.optionalKey(Schema.String)
})
```

**2c. Add checkpoint fields to `ProcessTurnResult`** (TurnProcessingWorkflow.ts lines 92-103):

```typescript
export const ProcessTurnResult = Schema.Struct({
  turnId: Schema.String,
  accepted: Schema.Boolean,
  auditReasonCode: TurnAuditReasonCode,
  assistantContent: Schema.String,
  assistantContentBlocks: Schema.Array(ContentBlockSchema),
  iterationsUsed: Schema.Number,
  toolCallsTotal: Schema.Number,
  iterationStats: Schema.Array(TurnIterationStats),
  modelFinishReason: Schema.Union([ModelFinishReason, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null]),
  checkpointId: Schema.optionalKey(Schema.String),
  checkpointAction: Schema.optionalKey(Schema.String),
  checkpointReason: Schema.optionalKey(Schema.String)
})
```

**2d. Add `checkpointId` to SessionEntity `ProcessTurnPayloadFields`** (SessionEntity.ts lines 24-43):

```typescript
const ProcessTurnPayloadFields = {
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  agentId: Schema.String,
  userId: Schema.String,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlock),
  createdAt: Schema.DateTimeUtcFromString,
  inputTokens: Schema.Number,
  modelOverride: Schema.optionalKey(Schema.Struct({
    provider: Schema.String,
    modelId: Schema.String
  })),
  generationConfigOverride: Schema.optionalKey(Schema.Struct({
    temperature: Schema.optionalKey(Schema.Number),
    maxOutputTokens: Schema.optionalKey(Schema.Number),
    topP: Schema.optionalKey(Schema.Number)
  })),
  checkpointId: Schema.optionalKey(Schema.String)
} as const
```

**CRITICAL:** Without this, the sharded path (ChannelCore → SessionEntity RPC) would silently strip checkpointId from the payload.

**Verify:** `cd packages/server && bun run check`

---

### Task 3: Database migration 0012

**Files:**
- Modify: `packages/server/src/persistence/DomainMigrator.ts` (after migration `0011_channel_model_override`)

**Addresses review findings:** #4 (fail-fast migration), #11 (recreate index)

**3a. Add migration `0012_governance_checkpoints_and_actions`:**

```typescript
"0012_governance_checkpoints_and_actions": Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const now = new Date().toISOString()

  // 1. Create checkpoints table
  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      action TEXT NOT NULL,
      policy_id TEXT,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Deferred', 'Expired', 'Consumed')),
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      expires_at TEXT
    )
  `.unprepared

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_checkpoints_status
    ON checkpoints(status)
  `.unprepared

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_status
    ON checkpoints(agent_id, status)
  `.unprepared

  // 2. Expand permission_policies action CHECK constraint.
  // SQLite cannot ALTER CHECK constraints — must rebuild.
  // This is fail-fast: if any step fails, the migration errors out.
  // The DomainMigrator's version tracking prevents partial re-runs.

  // Read existing data
  const existingPolicies = yield* sql`
    SELECT * FROM permission_policies
  `.unprepared

  const existingPolicyTools = yield* sql`
    SELECT * FROM permission_policy_tools
  `.unprepared

  // Drop old table (rename first for safety)
  yield* sql`ALTER TABLE permission_policies RENAME TO _pp_migration_backup`.unprepared

  // Create new table with expanded CHECK
  yield* sql`
    CREATE TABLE permission_policies (
      policy_id TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK (action IN (
        'InvokeTool', 'ReadMemory', 'WriteMemory', 'ExecuteSchedule',
        'SpawnSubAgent', 'CreateGoal', 'TransitionTask'
      )),
      permission_mode TEXT CHECK (permission_mode IN ('Permissive', 'Standard', 'Restrictive')),
      selector TEXT NOT NULL CHECK (selector IN (
        'AllTools', 'SafeStandardTools', 'ExplicitToolList',
        'UnknownTool', 'MissingAgent', 'InvalidRequest', 'GovernanceError'
      )),
      decision TEXT NOT NULL CHECK (decision IN ('Allow', 'Deny', 'RequireApproval')),
      reason_template TEXT NOT NULL,
      precedence INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.unprepared

  // Restore data
  yield* sql`
    INSERT INTO permission_policies
    SELECT * FROM _pp_migration_backup
  `.unprepared

  yield* sql`DROP TABLE _pp_migration_backup`.unprepared

  // Recreate hot-path index (was permission_policies_mode_idx)
  yield* sql`
    CREATE INDEX IF NOT EXISTS permission_policies_mode_idx
    ON permission_policies (action, permission_mode, active, precedence)
  `.unprepared

  // 3. Seed policies for expanded actions (18 new: 6 actions × 3 modes)
  yield* sql`
    INSERT OR IGNORE INTO permission_policies (
      policy_id, action, permission_mode, selector, decision,
      reason_template, precedence, active, created_at, updated_at
    ) VALUES
      ('policy:read_memory:permissive:v1', 'ReadMemory', 'Permissive', 'AllTools', 'Allow', 'read_memory_permissive_allow', 10, 1, ${now}, ${now}),
      ('policy:read_memory:standard:v1', 'ReadMemory', 'Standard', 'AllTools', 'Allow', 'read_memory_standard_allow', 10, 1, ${now}, ${now}),
      ('policy:read_memory:restrictive:v1', 'ReadMemory', 'Restrictive', 'AllTools', 'RequireApproval', 'read_memory_restrictive_requires_approval', 10, 1, ${now}, ${now}),

      ('policy:write_memory:permissive:v1', 'WriteMemory', 'Permissive', 'AllTools', 'Allow', 'write_memory_permissive_allow', 10, 1, ${now}, ${now}),
      ('policy:write_memory:standard:v1', 'WriteMemory', 'Standard', 'AllTools', 'Allow', 'write_memory_standard_allow', 10, 1, ${now}, ${now}),
      ('policy:write_memory:restrictive:v1', 'WriteMemory', 'Restrictive', 'AllTools', 'RequireApproval', 'write_memory_restrictive_requires_approval', 10, 1, ${now}, ${now}),

      ('policy:execute_schedule:permissive:v1', 'ExecuteSchedule', 'Permissive', 'AllTools', 'Allow', 'execute_schedule_permissive_allow', 10, 1, ${now}, ${now}),
      ('policy:execute_schedule:standard:v1', 'ExecuteSchedule', 'Standard', 'AllTools', 'Allow', 'execute_schedule_standard_allow', 10, 1, ${now}, ${now}),
      ('policy:execute_schedule:restrictive:v1', 'ExecuteSchedule', 'Restrictive', 'AllTools', 'RequireApproval', 'execute_schedule_restrictive_requires_approval', 10, 1, ${now}, ${now}),

      ('policy:spawn_sub_agent:permissive:v1', 'SpawnSubAgent', 'Permissive', 'AllTools', 'Allow', 'spawn_sub_agent_permissive_allow', 10, 1, ${now}, ${now}),
      ('policy:spawn_sub_agent:standard:v1', 'SpawnSubAgent', 'Standard', 'AllTools', 'RequireApproval', 'spawn_sub_agent_standard_requires_approval', 10, 1, ${now}, ${now}),
      ('policy:spawn_sub_agent:restrictive:v1', 'SpawnSubAgent', 'Restrictive', 'AllTools', 'RequireApproval', 'spawn_sub_agent_restrictive_requires_approval', 10, 1, ${now}, ${now}),

      ('policy:create_goal:permissive:v1', 'CreateGoal', 'Permissive', 'AllTools', 'Allow', 'create_goal_permissive_allow', 10, 1, ${now}, ${now}),
      ('policy:create_goal:standard:v1', 'CreateGoal', 'Standard', 'AllTools', 'RequireApproval', 'create_goal_standard_requires_approval', 10, 1, ${now}, ${now}),
      ('policy:create_goal:restrictive:v1', 'CreateGoal', 'Restrictive', 'AllTools', 'RequireApproval', 'create_goal_restrictive_requires_approval', 10, 1, ${now}, ${now}),

      ('policy:transition_task:permissive:v1', 'TransitionTask', 'Permissive', 'AllTools', 'Allow', 'transition_task_permissive_allow', 10, 1, ${now}, ${now}),
      ('policy:transition_task:standard:v1', 'TransitionTask', 'Standard', 'AllTools', 'Allow', 'transition_task_standard_allow', 10, 1, ${now}, ${now}),
      ('policy:transition_task:restrictive:v1', 'TransitionTask', 'Restrictive', 'AllTools', 'RequireApproval', 'transition_task_restrictive_requires_approval', 10, 1, ${now}, ${now})
  `.unprepared
})
```

**CRITICAL:** No blanket `Effect.catch(() => Effect.void)` around the table rebuild. If any step fails, the migration fails and the version is not bumped. The `_pp_migration_backup` rename + restore pattern means data is preserved on failure.

**Verify:** `cd packages/server && bun run check`

---

### Task 4: GovernancePortSqlite expansion

**Files:**
- Modify: `packages/server/src/GovernancePortSqlite.ts` (lines 32-42, 117-131, 135-207, 490-510)
- Modify: `packages/server/src/GovernancePortMemory.ts`
- Modify: `packages/server/src/gateway/GovernanceRoutes.ts` (line 171)

**Addresses review finding:** #9 (under-scoped governance — hard-coded InvokeTool in SQL/domain/API)

**4a. Update `PolicyRow` type** (GovernancePortSqlite.ts line 32-42):

```typescript
// Was: readonly action: "InvokeTool"
readonly action: GovernanceAction
```

Add import for `GovernanceAction` from `@template/domain/status`.

**4b. Update `listModePolicies` SQL** (GovernancePortSqlite.ts ~line 117-131). Currently hardcodes `p.action = 'InvokeTool'`. Parameterize:

```typescript
const listModePolicies = (permissionMode: PermissionMode, action: GovernanceAction) =>
  sql`
    SELECT
      p.*,
      COALESCE((
        SELECT json_group_array(ppt.tool_definition_id)
        FROM permission_policy_tools ppt
        WHERE ppt.policy_id = p.policy_id
      ), '[]') AS tool_definition_ids_json
    FROM permission_policies p
    WHERE
      p.action = ${action}
      AND p.permission_mode = ${permissionMode}
      AND p.active = 1
    ORDER BY p.precedence ASC, p.policy_id ASC
  `.unprepared.pipe(
    Effect.map((rows) => rows as ReadonlyArray<PolicyRow>)
  )
```

**4c. Rewrite `evaluatePolicy`** (GovernancePortSqlite.ts lines 135-207). Replace the fail-open branch with action-aware routing:

```typescript
const evaluatePolicy: GovernancePort["evaluatePolicy"] = (input) =>
  Effect.gen(function*() {
    // 1. Get agent permission mode (shared across all actions)
    const permissionMode = yield* getAgentPermissionMode(input.agentId)
    if (permissionMode === null) {
      return {
        decision: "Deny", policyId: POLICY_MISSING_AGENT,
        toolDefinitionId: null, reason: "missing_agent_state"
      } satisfies PolicyDecision
    }

    // 2. InvokeTool-specific: validate toolName and get tool definition
    if (input.action === "InvokeTool") {
      const toolName = input.toolName?.trim()
      if (toolName === undefined || toolName.length === 0) {
        return {
          decision: "Deny", policyId: POLICY_INVALID_REQUEST,
          toolDefinitionId: null, reason: "invalid_tool_name"
        } satisfies PolicyDecision
      }

      const toolDef = yield* getToolDefinitionByName(toolName as ToolName)
      if (toolDef === null) {
        return {
          decision: "Deny", policyId: POLICY_UNKNOWN_TOOL,
          toolDefinitionId: null, reason: "unknown_tool_definition"
        } satisfies PolicyDecision
      }

      // Match against InvokeTool policies (uses selector matching)
      const policies = yield* listModePolicies(permissionMode, "InvokeTool")
      for (const policy of policies) {
        const explicitToolIds = parseToolDefinitionIds(policy.tool_definition_ids_json)
        if (!selectorMatches(policy.selector, toolDef, explicitToolIds)) continue
        return {
          decision: policy.decision,
          policyId: policy.policy_id as PolicyId,
          toolDefinitionId: toolDef.tool_definition_id as ToolDefinitionId,
          reason: policy.reason_template
        } satisfies PolicyDecision
      }

      return {
        decision: "Deny", policyId: POLICY_SYSTEM_ERROR,
        toolDefinitionId: toolDef.tool_definition_id as ToolDefinitionId,
        reason: "no_matching_policy"
      } satisfies PolicyDecision
    }

    // 3. Non-tool actions: match against action-specific policies
    const policies = yield* listModePolicies(permissionMode, input.action)
    for (const policy of policies) {
      // Non-tool actions: AllTools selector always matches
      if (policy.selector === "AllTools") {
        return {
          decision: policy.decision,
          policyId: policy.policy_id as PolicyId,
          toolDefinitionId: null,
          reason: policy.reason_template
        } satisfies PolicyDecision
      }
    }

    // 4. Default deny (no matching policy)
    return {
      decision: "Deny", policyId: null,
      toolDefinitionId: null, reason: "no_matching_policy"
    } satisfies PolicyDecision
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({
        decision: "Deny", policyId: POLICY_SYSTEM_ERROR,
        toolDefinitionId: null, reason: "governance_evaluate_policy_error"
      } satisfies PolicyDecision)
    )
  )
```

**4d. Update `listPoliciesForAgent` SQL** (GovernancePortSqlite.ts ~line 490-510). Currently hardcodes `p.action = 'InvokeTool'`. Remove the filter or make it a parameter:

```typescript
// Remove: WHERE p.action = 'InvokeTool'
// Replace with: no action filter (returns all action types)
WHERE p.active = 1
  AND (p.permission_mode = ${permissionMode} OR p.permission_mode IS NULL)
```

**4e. Update `GovernanceRoutes.ts`** (line 171). Currently rejects `action !== "InvokeTool"`:

```typescript
// Was: if (action !== null && action !== "" && action !== "InvokeTool") {
//        return yield* badRequest("action must be InvokeTool")
//      }
// Now: validate against GovernanceAction literals
const validActions = ["InvokeTool", "ReadMemory", "WriteMemory", "ExecuteSchedule", "SpawnSubAgent", "CreateGoal", "TransitionTask"]
if (action !== null && action !== "" && !validActions.includes(action)) {
  return yield* badRequest(`action must be one of: ${validActions.join(", ")}`)
}
```

**4f. Update `GovernancePortMemory.ts`** in-memory test implementation. Same evaluatePolicy routing: non-tool actions use mode-based lookup instead of fail-open.

**Verify:** `cd packages/server && bun run check && bun run test -- GovernancePort`

---

### Task 5: CheckpointPortSqlite

**Files:**
- Create: `packages/server/src/CheckpointPortSqlite.ts`
- Modify: `packages/server/src/PortTags.ts`

**Addresses review finding:** #6 (consumed/executed state)

Follow the pattern from `ChannelPortSqlite.ts`:

**5a. Implement `CheckpointPortSqlite`:**

```typescript
import type { CheckpointId, AgentId } from "@template/domain/ids"
import type { CheckpointPort, CheckpointRecord, Instant } from "@template/domain/ports"
import type { CheckpointStatus, GovernanceAction } from "@template/domain/status"
import { CheckpointAlreadyDecided, CheckpointNotFound } from "@template/domain/errors"
import { DateTime, Effect, Layer, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
```

Key behaviors:

- **`create`**: INSERT into `checkpoints` table. All fields from `CheckpointRecord`.
- **`get`**: SELECT by `checkpoint_id`. If `expires_at` is set and past `DateTime.now`, return the record with `status: "Expired"` (lazy expiry, no background reaper).
- **`transition`**: Compare-and-swap semantics:
  - `Pending → Approved|Rejected|Deferred`: `UPDATE ... WHERE checkpoint_id = ? AND status = 'Pending'`
  - `Approved → Consumed`: `UPDATE ... WHERE checkpoint_id = ? AND status = 'Approved'`
  - If no row updated: check existence → `CheckpointNotFound` or `CheckpointAlreadyDecided`
- **`listPending`**: `SELECT WHERE status = 'Pending' AND (expires_at IS NULL OR expires_at > ?)` with optional `agent_id` filter.

Export as `ServiceMap.Service` with static `layer`:

```typescript
export class CheckpointPortSqlite extends ServiceMap.Service<CheckpointPortSqlite>()(
  "server/CheckpointPortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      // ... implement create, get, transition, listPending
      return { create, get, transition, listPending } satisfies CheckpointPort
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
```

**5b. Add `CheckpointPortTag` to PortTags.ts:**

```typescript
export class CheckpointPortTag extends ServiceMap.Tag<CheckpointPort>()(
  "server/ports/CheckpointPort"
) {}
```

Follow the exact pattern used by `GovernancePortTag`, `MemoryPortTag`, etc.

**Verify:** `cd packages/server && bun run check`

---

### Task 6: ToolRegistry — checkpoint signal + bypass

**Files:**
- Modify: `packages/server/src/ai/ToolRegistry.ts`

**Addresses review findings:** #1 (idempotency blocks replay), #5 (bypass not bound to payload), #8 (type issues)

**6a. Add `CheckpointSignal` type and return from `makeToolkit`:**

```typescript
export interface CheckpointSignal {
  readonly checkpointId: string
  readonly action: GovernanceAction
  readonly toolName: string
  readonly inputJson: string
  readonly reason: string
}

export interface ToolRegistryService {
  readonly makeToolkit: (context: ToolExecutionContext) => Effect.Effect<{
    readonly toolkit: typeof SafeToolkit
    readonly handlerLayer: SafeToolkitHandlerLayer
    readonly getCheckpointSignals: Effect.Effect<ReadonlyArray<CheckpointSignal>>
  }>
}
```

Internally, `makeToolkit` creates a `Ref<Array<CheckpointSignal>>`. Tool handlers append to it. `getCheckpointSignals` reads it. No mutable slot on the readonly `ToolExecutionContext`.

**6b. Update RequireApproval in `runGovernedTool`** (line 374-386). Create checkpoint + append signal:

```typescript
Match.when("RequireApproval", () =>
  Effect.gen(function*() {
    // Create checkpoint
    const checkpointId = `ckpt:${crypto.randomUUID()}` as CheckpointId
    const now = yield* DateTime.now
    const payloadJson = safeJsonStringify({
      action: "InvokeTool",
      toolName: String(toolName),
      inputJson,
      channelId: context.channelId,
      userId: context.userId,
      content: context.content
    })
    const payloadHash = yield* makePayloadHash("InvokeTool", String(toolName), inputJson)

    yield* checkpointPort.create({
      checkpointId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      channelId: context.channelId ?? "",
      turnId: context.turnId as string,
      action: "InvokeTool",
      policyId: policy.policyId,
      reason: policy.reason,
      payloadJson,
      payloadHash,
      status: "Pending",
      requestedAt: now,
      decidedAt: null,
      decidedBy: null,
      expiresAt: DateTime.add(now, { hours: 24 })
    })

    // Signal to workflow (via Ref)
    yield* Ref.update(checkpointSignalsRef, (signals) => [
      ...signals,
      { checkpointId: checkpointId as string, action: "InvokeTool" as const, toolName: String(toolName), inputJson, reason: policy.reason }
    ])

    // Still fail the tool call (model sees RequiresApproval error)
    return yield* failWithRecordedInvocation({
      context,
      toolName,
      idempotencyKey,
      inputJson,
      decision: "RequireApproval",
      policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
      toolDefinitionId: policy.toolDefinitionId,
      reason: `tool_requires_approval:${toolName}`,
      failure: { errorCode: "RequiresApproval", message: policy.reason }
    })
  })
),
```

Note: `{ errorCode: ..., message: ... }` is an object literal — NOT `new ToolFailure(...)`. `ToolFailure` is a `Schema.Struct` alias, not a class constructor.

**6c. Add checkpoint-authorized bypass in `runGovernedTool`.** This must be checked BEFORE the idempotency lookup (line 331), because the replay uses a new turnId and won't match old idempotency keys, but we still want a clean bypass path:

```typescript
const runGovernedTool = <A>(
  context: ToolExecutionContext,
  toolName: ToolName,
  input: Record<string, unknown>,
  execute: Effect.Effect<A, ToolFailure>
): Effect.Effect<A, ToolFailure> =>
  Effect.gen(function*() {
    const inputJson = canonicalJsonStringify(input)

    // Checkpoint-authorized bypass: skip policy, skip idempotency
    if (context.checkpointId) {
      const checkpoint = yield* checkpointPort.get(context.checkpointId as CheckpointId).pipe(
        Effect.orDie
      )
      if (!checkpoint || checkpoint.status !== "Approved") {
        return yield* Effect.fail<ToolFailure>({
          errorCode: "CheckpointNotApproved",
          message: "checkpoint not found or not in Approved status"
        })
      }
      // Verify payload binding: action + toolName + inputJson must match
      const expectedHash = yield* makePayloadHash("InvokeTool", String(toolName), inputJson)
      if (checkpoint.payloadHash !== expectedHash) {
        return yield* Effect.fail<ToolFailure>({
          errorCode: "CheckpointPayloadMismatch",
          message: "tool call does not match approved checkpoint payload"
        })
      }
      // Bypass policy + idempotency, proceed directly to execution
      return yield* execute
    }

    // Normal path: idempotency check → policy evaluation → quota → execute
    const idempotencyKey = yield* makeIdempotencyKey(/* ... */)
    // ... (rest of existing runGovernedTool logic)
  }) as Effect.Effect<A, ToolFailure>
```

**6d. Extend `ToolExecutionContext`** with optional fields for bypass and checkpoint payload:

```typescript
export interface ToolExecutionContext {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly turnId: TurnId
  readonly now: Instant
  readonly iteration?: number
  readonly checkpointId?: string
  readonly channelId?: string
  readonly userId?: string
  readonly content?: string
}
```

`channelId`, `userId`, `content` are needed to populate the checkpoint payload for replay.

**6e. Add `makePayloadHash` helper:**

```typescript
const makePayloadHash = (action: string, toolName: string, inputJson: string) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${action}:${toolName}:${inputJson}`)
    )
  ).pipe(
    Effect.map((buffer) => {
      const hex = Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("")
      return `ckpt-hash:${hex}`
    })
  )
```

**6f. Add `CheckpointPortTag` dependency** to `ToolRegistry.make`.

**Verify:** `cd packages/server && bun run check`

---

### Task 7: TurnProcessingWorkflow — checkpoint creation + bypass + events

**Files:**
- Modify: `packages/server/src/turn/TurnProcessingWorkflow.ts` (lines 194-228, 312-329, 398-416)
- Modify: `packages/server/src/turn/TurnProcessingRuntime.ts` (lines 37-52, 64-119)

**Addresses review findings:** #2 (non-tool approval loops), #7 (audit reason code), #10 (client-breaking event)

**7a. Add workflow-level checkpoint bypass** (TurnProcessingWorkflow.ts lines 194-228). When `payload.checkpointId` is present and the checkpoint action matches the workflow-level policy check:

```typescript
// Workflow-level policy evaluation
const policy = yield* Activity.make({
  name: "EvaluatePolicy",
  success: PolicyDecisionSchema,
  execute: governancePort.evaluatePolicy({
    agentId: payload.agentId as AgentId,
    sessionId: payload.sessionId as SessionId,
    action: "ReadMemory"
  })
})

if (policy.decision === "Deny") {
  // ... existing Deny handling ...
}

if (policy.decision === "RequireApproval") {
  // Check for checkpoint bypass
  if (payload.checkpointId) {
    const checkpoint = yield* checkpointPort.get(payload.checkpointId as CheckpointId).pipe(Effect.orDie)
    if (checkpoint && checkpoint.status === "Approved" && checkpoint.action === "ReadMemory") {
      // Bypass: checkpoint authorized this action. Proceed with workflow.
      // (fall through to rest of workflow)
    } else {
      // Checkpoint doesn't match — deny
      return yield* new TurnPolicyDenied({
        turnId: payload.turnId,
        reason: "checkpoint_mismatch"
      })
    }
  } else {
    // No checkpoint: create one and end turn gracefully
    yield* writeAuditEntry(governancePort, payload, "RequireApproval", "turn_processing_checkpoint_required")

    const checkpointId = `ckpt:${crypto.randomUUID()}` as CheckpointId
    const now = yield* DateTime.now
    const payloadHash = yield* makePayloadHash("ReadMemory", "", "")
    const payloadJson = safeJsonStringify({
      action: "ReadMemory",
      channelId: /* from context */,
      userId: payload.userId,
      content: payload.content,
      contentBlocks: payload.contentBlocks,
      inputTokens: payload.inputTokens,
      ...(payload.modelOverride ? { modelOverride: payload.modelOverride } : {}),
      ...(payload.generationConfigOverride ? { generationConfigOverride: payload.generationConfigOverride } : {})
    })

    yield* checkpointPort.create({
      checkpointId,
      agentId: payload.agentId as AgentId,
      sessionId: payload.sessionId as SessionId,
      channelId: /* from ChannelCore context */,
      turnId: payload.turnId,
      action: "ReadMemory",
      policyId: policy.policyId,
      reason: policy.reason,
      payloadJson,
      payloadHash,
      status: "Pending",
      requestedAt: now,
      decidedAt: null,
      decidedBy: null,
      expiresAt: DateTime.add(now, { hours: 24 })
    })

    return {
      turnId: payload.turnId,
      accepted: false,
      auditReasonCode: "turn_processing_checkpoint_required" as const,
      assistantContent: "",
      assistantContentBlocks: [],
      iterationsUsed: 0,
      toolCallsTotal: 0,
      iterationStats: [],
      modelFinishReason: null,
      modelUsageJson: null,
      checkpointId: checkpointId as string,
      checkpointAction: "ReadMemory",
      checkpointReason: policy.reason
    }
  }
}
```

**Note on channelId:** The workflow doesn't currently have channelId. Two options: (a) add it to ProcessTurnPayload, or (b) look it up from the session. Option (a) is simpler — add `channelId: Schema.optionalKey(Schema.String)` to ProcessTurnPayload (and SessionEntity fields). Add this to Task 2 scope.

**7b. Thread tool-level checkpoint signals** — after `processWithToolLoop` returns, check for checkpoint signals:

```typescript
const toolkitBundle = yield* toolRegistry.makeToolkit({
  ...context,
  checkpointId: payload.checkpointId,
  channelId: payload.channelId,
  userId: payload.userId,
  content: payload.content
})

// ... (processWithToolLoop runs) ...

// After tool loop, check for checkpoint signals
const checkpointSignals = yield* toolkitBundle.getCheckpointSignals
if (checkpointSignals.length > 0) {
  // A tool hit RequireApproval — turn completed but with checkpoint info
  const firstSignal = checkpointSignals[0]!
  return {
    turnId: payload.turnId,
    accepted: false,
    auditReasonCode: "turn_processing_checkpoint_required" as const,
    assistantContent: assistantResult.assistantContent,
    assistantContentBlocks: assistantResult.assistantContentBlocks,
    iterationsUsed: assistantResult.iterationsUsed,
    toolCallsTotal: assistantResult.toolCallsTotal,
    iterationStats: assistantResult.iterationStats,
    modelFinishReason,
    modelUsageJson: assistantResult.modelUsageJson,
    checkpointId: firstSignal.checkpointId,
    checkpointAction: firstSignal.action,
    checkpointReason: firstSignal.reason
  }
}
```

**7c. Update `TurnProcessingRuntime.toSuccessEvents`** (TurnProcessingRuntime.ts lines 64-119) to emit checkpoint events. When `result.checkpointId` is present, emit `turn.checkpoint_required` followed by `turn.completed` (for backwards compat):

```typescript
const toSuccessEvents = (
  input: ProcessTurnPayload,
  result: ProcessTurnResult
): ReadonlyArray<TurnStreamEvent> => {
  const base = { turnId: input.turnId, sessionId: input.sessionId }

  const iterationEvents: ReadonlyArray<TurnStreamEvent> = result.iterationStats.map(/* ... existing ... */)
  const contentEvents: ReadonlyArray<TurnStreamEvent> = result.assistantContentBlocks.flatMap(/* ... existing ... */)

  // Checkpoint-required results: emit checkpoint event + completed(accepted=false)
  if (result.checkpointId) {
    const checkpointEvent: TurnStreamEvent = new TurnCheckpointRequiredEvent({
      type: "turn.checkpoint_required",
      sequence: 0,
      ...base,
      checkpointId: result.checkpointId,
      action: result.checkpointAction ?? "unknown",
      reason: result.checkpointReason ?? ""
    })

    const completedEvent: TurnStreamEvent = new TurnCompletedEvent({
      type: "turn.completed",
      ...base,
      sequence: 0,
      accepted: false,
      auditReasonCode: result.auditReasonCode,
      iterationsUsed: result.iterationsUsed,
      toolCallsTotal: result.toolCallsTotal,
      modelFinishReason: result.modelFinishReason,
      modelUsageJson: result.modelUsageJson
    })

    return [...iterationEvents, ...contentEvents, checkpointEvent, completedEvent].map(
      (event, i) => ({ ...event, sequence: i + 2 })
    )
  }

  // Normal path (existing)
  const completedEvent: TurnStreamEvent = { /* ... existing ... */ }
  return [...iterationEvents, ...contentEvents, completedEvent].map(
    (event, i) => ({ ...event, sequence: i + 2 })
  )
}
```

**CRITICAL:** `turn.completed` is always emitted as the terminal event. Clients that don't know about `turn.checkpoint_required` still see a proper terminal event.

**Verify:** `cd packages/server && bun run check`

---

### Task 8: ChannelCore + CheckpointRoutes + replay orchestration

**Files:**
- Modify: `packages/server/src/ChannelCore.ts`
- Create: `packages/server/src/gateway/CheckpointRoutes.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/turn/TurnProcessingRuntime.ts`

**Addresses review findings:** #3 (replay contract), #6 (consumed transition)

**8a. Add `decideCheckpoint` to ChannelCore:**

```typescript
const decideCheckpoint = (params: {
  readonly checkpointId: CheckpointId
  readonly decision: "Approved" | "Rejected" | "Deferred"
  readonly decidedBy: string
}): Effect.Effect<{ readonly ok: true } | Stream.Stream<TurnStreamEvent, TurnProcessingError>> =>
  Effect.gen(function*() {
    const now = yield* DateTime.now

    // Transition Pending → decision
    yield* checkpointPort.transition(params.checkpointId, params.decision, params.decidedBy, now)

    if (params.decision !== "Approved") {
      return { ok: true as const }
    }

    // Approved — replay
    const checkpoint = yield* checkpointPort.get(params.checkpointId)
    if (checkpoint === null) {
      return yield* new CheckpointNotFound({ checkpointId: params.checkpointId as string })
    }

    const deserialized = JSON.parse(checkpoint.payloadJson)

    if (checkpoint.action === "InvokeTool") {
      // Tool-level replay: use replayToolCheckpoint
      const stream = runtime.replayToolCheckpoint({
        checkpoint,
        payload: deserialized
      })
      // After stream completes successfully, transition Approved → Consumed
      return Stream.ensuring(stream,
        checkpointPort.transition(params.checkpointId, "Consumed", params.decidedBy, now).pipe(Effect.ignore)
      )
    }

    // Turn-level replay: build new turn payload with checkpointId
    const channel = yield* channelPort.get(checkpoint.channelId as ChannelId)
    if (channel === null) {
      return yield* new ChannelNotFound({ channelId: checkpoint.channelId })
    }

    const newTurnId = `turn:${crypto.randomUUID()}`
    const turnPayload: ProcessTurnPayload = {
      turnId: newTurnId,
      sessionId: channel.activeSessionId,
      conversationId: channel.activeConversationId,
      agentId: checkpoint.agentId as string,
      userId: deserialized.userId ?? params.decidedBy,
      content: deserialized.content ?? "",
      contentBlocks: deserialized.contentBlocks ?? [],
      createdAt: now,
      inputTokens: deserialized.inputTokens ?? 0,
      checkpointId: params.checkpointId as string,
      ...(deserialized.modelOverride ? { modelOverride: deserialized.modelOverride } : {}),
      ...(deserialized.generationConfigOverride ? { generationConfigOverride: deserialized.generationConfigOverride } : {})
    }

    const stream = processTurn(turnPayload)
    return Stream.ensuring(stream,
      checkpointPort.transition(params.checkpointId, "Consumed", params.decidedBy, now).pipe(Effect.ignore)
    )
  })
```

**8b. Add `replayToolCheckpoint` to TurnProcessingRuntime.** This is a shorter pipeline than `processTurn`: execute tool → inject into chat → model continues → stream events.

```typescript
const replayToolCheckpoint = (params: {
  readonly checkpoint: CheckpointRecord
  readonly payload: { toolName: string; inputJson: string; /* ... */ }
}): Stream.Stream<TurnStreamEvent, TurnProcessingError> => {
  // Implementation:
  // 1. New turnId
  // 2. Get chat persistence (existing session)
  // 3. Execute tool via ToolRegistry with checkpointId (bypass)
  // 4. Inject tool call + result into chat history
  // 5. Call model to continue (Prompt.empty + toolkit)
  // 6. Persist assistant turn
  // 7. Stream events
}
```

This method lives on TurnProcessingRuntime because it needs access to the workflow engine, chat persistence, and model registry.

**8c. Create `CheckpointRoutes.ts`:**

```typescript
// GET /checkpoints/pending?agentId=optional
// → returns JSON array of pending checkpoints

// GET /checkpoints/:checkpointId
// → returns checkpoint details (JSON)

// POST /checkpoints/:checkpointId/decide
// Body: { decision: "Approved" | "Rejected" | "Deferred" }
// For Approved: returns SSE stream with replayed turn events (same pattern as sendMessage)
// For Rejected/Deferred: returns { ok: true }
```

Follow patterns from `ChannelRoutes.ts` for SSE streaming and `GovernanceRoutes.ts` for JSON endpoints.

**8d. Wire in `server.ts`:**
- Add `CheckpointPortSqlite.layer` → `CheckpointPortTag`
- Provide `CheckpointPortTag` to `ToolRegistry.layer` and `TurnProcessingWorkflow` layer
- Add `CheckpointRoutes` to HTTP router merge

**Verify:** `cd packages/server && bun run check`

---

### Task 9: Client stream compatibility

**Files:**
- Modify: `packages/tui/src/hooks/useSendMessage.ts`
- Modify: `packages/cli/src/Cli.ts`

**Addresses review finding:** #10 (client-breaking event)

**9a. Update TUI `dispatchEvent`** (useSendMessage.ts) — add case for `turn.checkpoint_required`:

```typescript
case "turn.checkpoint_required": {
  // Show checkpoint notification in UI
  registry.update(messagesAtom, (msgs) => {
    if (msgs.length === 0) return msgs
    const last = msgs[msgs.length - 1]!
    return [
      ...msgs.slice(0, -1),
      { ...last, status: "checkpoint_required" as const, checkpointId: event.checkpointId }
    ]
  })
  break
}
```

This also requires adding `"checkpoint_required"` to the `ChatMessage.status` type.

**9b. Update CLI `switch`** (Cli.ts) — add case:

```typescript
case "turn.checkpoint_required":
  return Console.log(`\n[checkpoint required: ${event.checkpointId} — ${event.action}: ${event.reason}]\n`)
```

**Note:** The `turn.completed` event still follows, so clients that don't handle `turn.checkpoint_required` will still terminate correctly. These changes are additive.

**Verify:** `cd packages/tui && bun run check && cd ../cli && bun run check`

---

### Task 10: Tests

**Files:**
- Create: `packages/server/test/CheckpointPortSqlite.test.ts`
- Modify: `packages/server/test/GovernancePortSqlite.test.ts`
- Modify: `packages/server/test/ToolRegistry.test.ts`
- Modify: `packages/server/test/TurnProcessingWorkflow.e2e.test.ts` (if exists)

**Addresses review finding:** #12 (missing test coverage)

**10a. CheckpointPortSqlite tests** (new file):

```typescript
// create + get round-trips correctly
// get returns null for unknown checkpoint
// transition Pending → Approved works
// transition Pending → Rejected works
// transition Approved → Consumed works
// double transition from Approved fails with CheckpointAlreadyDecided
// transition for unknown checkpoint fails with CheckpointNotFound
// listPending returns only Pending checkpoints
// listPending with agentId filter
// expired checkpoint returns status "Expired" on get
// listPending excludes expired checkpoints
```

**10b. Migration upgrade-path test:**

```typescript
// Start from a DB with only InvokeTool policies (pre-0012)
// Run migration 0012
// Verify: permission_policies table has expanded CHECK constraint
// Verify: all 18 new policies exist
// Verify: original InvokeTool policies preserved
// Verify: permission_policies_mode_idx exists
// Verify: checkpoints table exists with correct schema
```

**10c. GovernancePortSqlite expanded action tests:**

```typescript
// evaluatePolicy for ReadMemory in Permissive → Allow
// evaluatePolicy for ReadMemory in Restrictive → RequireApproval
// evaluatePolicy for SpawnSubAgent in Standard → RequireApproval
// evaluatePolicy for unknown future action with no policy → Deny (default-deny)
// evaluatePolicy for InvokeTool still works (existing tests pass)
// listPoliciesForAgent returns policies for all action types
```

**10d. ToolRegistry checkpoint tests:**

```typescript
// RequireApproval creates checkpoint and returns signal via getCheckpointSignals
// checkpoint-authorized bypass: Approved checkpoint with matching hash → tool executes
// checkpoint-authorized bypass: wrong hash → CheckpointPayloadMismatch error
// checkpoint-authorized bypass: non-Approved checkpoint → CheckpointNotApproved error
// existing Allow/Deny tests still pass
```

**10e. E2e checkpoint replay contract:**

```typescript
// Turn-level: checkpoint created for ReadMemory RequireApproval
// Turn-level: replay with checkpointId bypasses policy, turn succeeds
// Tool-level: checkpoint created for InvokeTool RequireApproval
// Tool-level: replay executes tool, model continues, events streamed
// Consumed: successful replay transitions checkpoint to Consumed
// Consumed: second replay of Consumed checkpoint fails
```

**10f. SessionEntity serialization:**

```typescript
// ProcessTurnPayload with checkpointId round-trips through ProcessTurnRpc schema
// ProcessTurnPayload without checkpointId still works (backwards compat)
```

**Verify:** `cd packages/server && bun run test`

---

### Task 11: Final verification

```bash
cd packages/domain && bun run check
cd packages/server && bun run check
cd packages/tui && bun run check
cd packages/cli && bun run check
bun run test
```

Verify:
1. All existing tests pass (no regressions)
2. New checkpoint tests pass
3. Policy evaluation for all 7 actions works per mode
4. Default-deny for unmatched actions (not fail-open)
5. Checkpoint lifecycle: create → decide → replay → consumed
6. Stream events: turn.checkpoint_required followed by turn.completed
7. Client handlers don't break on new event type

---

## Dependency Graph

```
Task 1: Domain types (ids, status, errors, events, ports)
  └─→ Task 2: ProcessTurnPayload + SessionEntity + ProcessTurnResult
       ├─→ Task 7: TurnProcessingWorkflow checkpoint + bypass + events
       └─→ Task 8: ChannelCore + Routes + replay
  └─→ Task 3: Migration 0012
       └─→ Task 4: GovernancePortSqlite expansion
       └─→ Task 5: CheckpointPortSqlite
            └─→ Task 6: ToolRegistry checkpoint signal + bypass
                 └─→ Task 7
                      └─→ Task 8
Task 9: Client compatibility (depends on Task 1 — new event type)
Task 10: Tests (depends on Tasks 1-9)
Task 11: Final verification (after all)
```

**Batch 1:** Tasks 1, 2, 3 (domain types + schemas + migration)
**Batch 2:** Tasks 4, 5, 6 (governance expansion + persistence + tool registry)
**Batch 3:** Tasks 7, 8, 9 (workflow + orchestration + clients)
**Batch 4:** Tasks 10, 11 (tests + verification)

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `packages/domain/src/ids.ts` | Modify | 1 |
| `packages/domain/src/status.ts` | Modify | 1 |
| `packages/domain/src/errors.ts` | Modify | 1 |
| `packages/domain/src/events.ts` | Modify | 1 |
| `packages/domain/src/ports.ts` | Modify | 1 |
| `packages/server/src/turn/TurnProcessingWorkflow.ts` | Modify | 2, 7 |
| `packages/server/src/entities/SessionEntity.ts` | Modify | 2 |
| `packages/server/src/persistence/DomainMigrator.ts` | Modify | 3 |
| `packages/server/src/GovernancePortSqlite.ts` | Modify | 4 |
| `packages/server/src/GovernancePortMemory.ts` | Modify | 4 |
| `packages/server/src/gateway/GovernanceRoutes.ts` | Modify | 4 |
| `packages/server/src/CheckpointPortSqlite.ts` | Create | 5 |
| `packages/server/src/PortTags.ts` | Modify | 5 |
| `packages/server/src/ai/ToolRegistry.ts` | Modify | 6 |
| `packages/server/src/turn/TurnProcessingRuntime.ts` | Modify | 7, 8 |
| `packages/server/src/ChannelCore.ts` | Modify | 8 |
| `packages/server/src/gateway/CheckpointRoutes.ts` | Create | 8 |
| `packages/server/src/server.ts` | Modify | 8 |
| `packages/tui/src/hooks/useSendMessage.ts` | Modify | 9 |
| `packages/cli/src/Cli.ts` | Modify | 9 |
| `packages/server/test/CheckpointPortSqlite.test.ts` | Create | 10 |
| `packages/server/test/GovernancePortSqlite.test.ts` | Modify | 10 |
| `packages/server/test/ToolRegistry.test.ts` | Modify | 10 |

## Review Finding Traceability

| Finding | Severity | Fix Location |
|---------|----------|-------------|
| #1: Idempotency blocks replay | Critical | Task 6 — bypass BEFORE idempotency; new turnId |
| #2: Non-tool approval loops | Critical | Task 7 — workflow-level bypass via checkpointId |
| #3: Replay contract incompatible | Critical | Tasks 2, 8 — checkpointId in payload/RPC; two replay paths |
| #4: Migration silent failure | Critical | Task 3 — no blanket catch; rename-restore pattern |
| #5: Bypass not bound to payload | Critical | Tasks 1, 6 — payloadHash on record; hash verification |
| #6: Incomplete lifecycle | High | Tasks 1, 5, 8 — Consumed status; transition after replay |
| #7: Invalid auditReasonCode | High | Task 2 — add to TurnAuditReasonCode literals |
| #8: Type issues | High | Task 6 — object literal for ToolFailure; Ref for signals |
| #9: Under-scoped governance | High | Tasks 1, 4 — GovernanceAction union; SQL/route/type updates |
| #10: Client-breaking event | Medium | Tasks 7, 9 — turn.completed follows checkpoint_required; client handlers |
| #11: Missing index | Medium | Task 3 — recreate permission_policies_mode_idx |
| #12: Missing test coverage | Medium | Task 10 — migration upgrade, e2e replay, SessionEntity round-trip |
