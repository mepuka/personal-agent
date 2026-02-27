# Governance Hardening + Checkpoint Approval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the governance fail-open hole, expand policy actions beyond InvokeTool, and implement durable checkpoint-based human-in-the-loop approval with replay-from-checkpoint semantics.

**Architecture:** CheckpointPort as a new persistence port (not an entity). Governance evaluatePolicy expanded to 7 action types with default-deny. Checkpoints created on RequireApproval, replayed through existing pipeline on approval. Orchestration through ChannelCore.

**Tech Stack:** Effect (Schema, ServiceMap, Workflow, Activity), SQLite, Vitest

---

### Task 1: Add domain types for checkpoints and expanded governance actions

**Files:**
- Modify: `packages/domain/src/ids.ts` (after line 55)
- Modify: `packages/domain/src/status.ts` (after line 176)
- Modify: `packages/domain/src/errors.ts` (after line 67)
- Modify: `packages/domain/src/events.ts` (after line 86, update union at line 88)
- Modify: `packages/domain/src/ports.ts` (lines 175-180, 209-211, add CheckpointPort after line 407)

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
  "Expired"
])
export type CheckpointStatus = typeof CheckpointStatus.Type
```

**1c. Add checkpoint error classes to errors.ts** (after line 67):

```typescript
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

**1d. Add `TurnCheckpointRequiredEvent` to events.ts** (after line 86, before union):

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

Update `TurnStreamEvent` union (line 88) to include the new event:

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

**1e. Expand `PolicyInput.action` in ports.ts** (line 178):

Change from:
```typescript
readonly action: "InvokeTool" | "WriteMemory" | "ReadMemory" | "ExecuteSchedule"
```
To:
```typescript
readonly action: GovernanceAction
```

Add import for `GovernanceAction` from `./status.js`.

**1f. Expand `PermissionPolicyRecord.action` in ports.ts** (line 211):

Change from:
```typescript
readonly action: "InvokeTool"
```
To:
```typescript
readonly action: GovernanceAction
```

**1g. Add `CheckpointRecord` and `CheckpointPort` to ports.ts** (after GovernancePort, ~line 407):

```typescript
export interface CheckpointRecord {
  readonly checkpointId: CheckpointId
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly turnId: string
  readonly action: GovernanceAction
  readonly policyId: PolicyId | null
  readonly reason: string
  readonly payloadJson: string
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
    status: CheckpointStatus,
    decidedBy: string,
    decidedAt: Instant
  ) => Effect.Effect<void, CheckpointNotFound | CheckpointAlreadyDecided>
  readonly listPending: (agentId?: AgentId) => Effect.Effect<ReadonlyArray<CheckpointRecord>>
}
```

Add imports for `CheckpointId` from `./ids.js`, `GovernanceAction`, `CheckpointStatus` from `./status.js`, `CheckpointNotFound`, `CheckpointAlreadyDecided` from `./errors.js`.

**Verify:** `cd packages/domain && bun run check`

---

### Task 2: Database migration 0012 + CheckpointPortSqlite

**Files:**
- Modify: `packages/server/src/persistence/DomainMigrator.ts` (after migration `0011_channel_model_override`, ~line 540)
- Create: `packages/server/src/CheckpointPortSqlite.ts`
- Modify: `packages/server/src/PortTags.ts`

**2a. Add migration `0012_governance_checkpoints_and_actions`** in DomainMigrator.ts:

```typescript
"0012_governance_checkpoints_and_actions": Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  // 1. Create checkpoints table
  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      action TEXT NOT NULL,
      policy_id TEXT,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Deferred', 'Expired')),
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

  // 2. Expand permission_policies action constraint.
  // SQLite cannot ALTER CHECK constraints. We rebuild the table.
  // First check if the expanded constraint is already present.
  yield* Effect.gen(function*() {
    // Read existing policies
    const rows = yield* sql`SELECT * FROM permission_policies`.unprepared

    // Drop and recreate with expanded constraint
    yield* sql`DROP TABLE IF EXISTS permission_policies_backup`.unprepared
    yield* sql`ALTER TABLE permission_policies RENAME TO permission_policies_backup`.unprepared

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

    yield* sql`
      INSERT INTO permission_policies
      SELECT * FROM permission_policies_backup
    `.unprepared

    yield* sql`DROP TABLE permission_policies_backup`.unprepared

    // Also recreate the junction table index if needed
    yield* sql`
      CREATE TABLE IF NOT EXISTS permission_policy_tools (
        policy_id TEXT NOT NULL REFERENCES permission_policies(policy_id),
        tool_definition_id TEXT NOT NULL REFERENCES tool_definitions(tool_definition_id),
        PRIMARY KEY (policy_id, tool_definition_id)
      )
    `.unprepared.pipe(Effect.catch(() => Effect.void))
  }).pipe(Effect.catch(() => Effect.void))

  // 3. Seed new policies for expanded actions
  const now = new Date().toISOString()

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

**2b. Create `CheckpointPortSqlite.ts`:**

Follow the pattern from `ChannelPortSqlite.ts`. The implementation needs:

- `CheckpointRowSchema` mapping DB columns to a row type
- `decodeCheckpointRow` to convert DB rows to `CheckpointRecord`
- `create` — INSERT into `checkpoints` table
- `get` — SELECT by `checkpoint_id`, check `expires_at` and auto-transition to `Expired` if past
- `transition` — UPDATE with compare-and-swap: `WHERE checkpoint_id = ? AND status = 'Pending'`. If no row updated, check if checkpoint exists (→ `CheckpointAlreadyDecided`) or not (→ `CheckpointNotFound`)
- `listPending` — SELECT WHERE `status = 'Pending'` with optional `agent_id` filter. Also exclude expired (WHERE `expires_at IS NULL OR expires_at > now`)

```typescript
import type { CheckpointId } from "@template/domain/ids"
import type { AgentId } from "@template/domain/ids"
import type { CheckpointPort, CheckpointRecord } from "@template/domain/ports"
import { CheckpointAlreadyDecided, CheckpointNotFound } from "@template/domain/errors"
import type { CheckpointStatus } from "@template/domain/status"
import { DateTime, Effect, Layer, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const CheckpointRowSchema = Schema.Struct({
  checkpoint_id: Schema.String,
  agent_id: Schema.String,
  session_id: Schema.String,
  turn_id: Schema.String,
  action: Schema.String,
  policy_id: Schema.Union([Schema.String, Schema.Null]),
  reason: Schema.String,
  payload_json: Schema.String,
  status: Schema.String,
  requested_at: Schema.String,
  decided_at: Schema.Union([Schema.String, Schema.Null]),
  decided_by: Schema.Union([Schema.String, Schema.Null]),
  expires_at: Schema.Union([Schema.String, Schema.Null])
})
type CheckpointRow = typeof CheckpointRowSchema.Type

// ... (implement decodeCheckpointRow, create, get, transition, listPending)
// Follow patterns from ChannelPortSqlite.ts and GovernancePortSqlite.ts
```

Export as `ServiceMap.Service` with static `layer`, same pattern as other port implementations.

**2c. Add `CheckpointPortTag` to PortTags.ts:**

```typescript
import type { CheckpointPort } from "@template/domain/ports"
// ...
export const CheckpointPortTag = ServiceMap.Service<CheckpointPort>("server/ports/CheckpointPort")
```

**Verify:** `cd packages/server && bun run check && bun run test -- CheckpointPortSqlite`

---

### Task 3: Remove fail-open and expand GovernancePortSqlite

**Files:**
- Modify: `packages/server/src/GovernancePortSqlite.ts` (lines 135-207)
- Modify: `packages/server/src/GovernancePortMemory.ts` (in-memory test impl)

**3a. Remove the fail-open branch in `evaluatePolicy`** (GovernancePortSqlite.ts, lines 135-144):

Currently:
```typescript
if (input.action !== "InvokeTool") {
  return {
    decision: "Allow",
    policyId: null,
    toolDefinitionId: null,
    reason: "mvp_default_allow"
  }
}
```

Replace with: evaluate policies for ALL action types. For non-tool actions (`!= "InvokeTool"`), skip the tool definition lookup and tool-specific selectors. Query policies matching `input.action` and the agent's permission mode. If no policy matches, return **Deny** with reason `"no_matching_policy"`.

```typescript
const evaluatePolicy: GovernancePort["evaluatePolicy"] = (input) =>
  Effect.gen(function*() {
    // 1. Get agent permission mode
    const agentMode = yield* getAgentPermissionMode(input.agentId)
    if (agentMode === null) {
      return { decision: "Deny", policyId: POLICY_MISSING_AGENT, toolDefinitionId: null, reason: "missing_agent_state" } satisfies PolicyDecision
    }

    // 2. For InvokeTool, validate toolName and get tool definition
    let toolDef: ToolDefinitionRow | null = null
    if (input.action === "InvokeTool") {
      if (!input.toolName) {
        return { decision: "Deny", policyId: POLICY_INVALID_REQUEST, toolDefinitionId: null, reason: "invalid_tool_name" } satisfies PolicyDecision
      }
      toolDef = yield* getToolDefinition(input.toolName)
      if (toolDef === null) {
        return { decision: "Deny", policyId: POLICY_UNKNOWN_TOOL, toolDefinitionId: null, reason: "unknown_tool_definition" } satisfies PolicyDecision
      }
    }

    // 3. Query policies for this action and permission mode
    const policies = yield* sql`
      SELECT p.*, ... FROM permission_policies p
      WHERE p.action = ${input.action}
        AND p.active = 1
        AND (p.permission_mode = ${agentMode} OR p.permission_mode IS NULL)
      ORDER BY p.precedence ASC
    `.unprepared

    // 4. Match policies (for InvokeTool, use existing selector matching; for others, AllTools always matches)
    for (const policy of policies) {
      if (input.action === "InvokeTool") {
        if (selectorMatches(policy, toolDef, toolListMap)) {
          return makePolicyDecision(policy, toolDef)
        }
      } else {
        // Non-tool actions: AllTools selector matches by default
        if (policy.selector === "AllTools") {
          return {
            decision: policy.decision as AuthorizationDecision,
            policyId: policy.policy_id as PolicyId,
            toolDefinitionId: null,
            reason: policy.reason_template
          } satisfies PolicyDecision
        }
      }
    }

    // 5. Default deny (no matching policy)
    return { decision: "Deny", policyId: null, toolDefinitionId: null, reason: "no_matching_policy" } satisfies PolicyDecision
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({
        decision: "Deny",
        policyId: POLICY_SYSTEM_ERROR,
        toolDefinitionId: null,
        reason: "governance_evaluate_policy_error"
      } satisfies PolicyDecision)
    )
  )
```

**3b. Update `GovernancePortMemory.ts`** in-memory test implementation:

Update `evaluatePolicy` to support the expanded actions. For test purposes, default to Allow for all actions (existing behavior) but add a mechanism for tests to override policy decisions per action.

**Verify:** `cd packages/server && bun run check && bun run test -- GovernancePort`

---

### Task 4: ToolRegistry — checkpoint creation on RequireApproval

**Files:**
- Modify: `packages/server/src/ai/ToolRegistry.ts` (lines 131-138, 316-458)

**4a. Extend `ToolExecutionContext`** (line 131-138) to carry a checkpoint signal ref:

```typescript
export interface ToolExecutionContext {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly turnId: TurnId
  readonly now: Instant
  readonly iteration?: number
  readonly checkpointSignal?: { checkpointId: string; action: string; reason: string } | null
}
```

Note: `checkpointSignal` is a mutable slot. When `runGovernedTool` creates a checkpoint, it writes to this slot. The caller (processWithToolLoop) reads it after each iteration.

**4b. Update RequireApproval handling in `runGovernedTool`** (lines 374-386):

Instead of just failing, create a checkpoint first:

```typescript
Match.when("RequireApproval", () =>
  Effect.gen(function*() {
    // Create checkpoint capturing the tool invocation context
    const checkpointId = `ckpt:${crypto.randomUUID()}` as CheckpointId
    const now = yield* DateTime.now
    const payloadJson = Schema.encodeSync(Schema.UnknownFromJsonString)({
      action: "InvokeTool",
      toolName: String(toolName),
      inputJson,
      turnId: context.turnId,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      agentId: context.agentId,
      iteration: context.iteration ?? 0
    })

    yield* checkpointPort.create({
      checkpointId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      action: "InvokeTool",
      policyId: policy.policyId,
      reason: policy.reason,
      payloadJson,
      status: "Pending",
      requestedAt: now,
      decidedAt: null,
      decidedBy: null,
      expiresAt: DateTime.add(now, { hours: 24 })
    })

    // Signal checkpoint to the tool loop
    if (context.checkpointSignal !== undefined) {
      (context as any).checkpointSignal = {
        checkpointId,
        action: "InvokeTool",
        reason: policy.reason
      }
    }

    // Still fail the tool (model sees the error, but turn ends gracefully)
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

**4c. Add checkpoint-authorized bypass** at the start of `runGovernedTool` (after idempotency check, ~line 335):

```typescript
// Checkpoint-authorized bypass: skip policy evaluation
if (context.checkpointId) {
  const checkpoint = yield* checkpointPort.get(context.checkpointId as CheckpointId)
  if (!checkpoint || checkpoint.status !== "Approved") {
    return yield* new ToolFailure({
      toolName,
      errorCode: "CheckpointNotApproved",
      message: "Checkpoint not found or not approved"
    })
  }
  // Skip policy evaluation, proceed directly to quota check + execution
}
```

Also extend `ToolExecutionContext` with optional `checkpointId?: string` for the bypass path.

**4d. Add CheckpointPortTag dependency** to ToolRegistry.make.

**Verify:** `cd packages/server && bun run check`

---

### Task 5: TurnProcessingWorkflow — checkpoint for non-tool RequireApproval

**Files:**
- Modify: `packages/server/src/turn/TurnProcessingWorkflow.ts` (lines 217-228, ~line 405-416)

**5a. Replace RequireApproval failure with checkpoint creation** (lines 217-228):

```typescript
if (policy.decision === "RequireApproval") {
  yield* writeAuditEntry(
    governancePort,
    payload,
    "RequireApproval",
    "turn_processing_requires_approval"
  )

  // Create checkpoint for the entire turn
  const checkpointId = `ckpt:${crypto.randomUUID()}` as CheckpointId
  const now = yield* DateTime.now
  const payloadJson = Schema.encodeSync(Schema.UnknownFromJsonString)({
    action: "ReadMemory",
    turnId: payload.turnId,
    sessionId: payload.sessionId,
    conversationId: payload.conversationId,
    agentId: payload.agentId,
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
    turnId: payload.turnId,
    action: "ReadMemory",
    policyId: policy.policyId,
    reason: policy.reason,
    payloadJson,
    status: "Pending",
    requestedAt: now,
    decidedAt: null,
    decidedBy: null,
    expiresAt: DateTime.add(now, { hours: 24 })
  })

  // Return a non-failure result indicating checkpoint required
  return {
    turnId: payload.turnId,
    accepted: false,
    auditReasonCode: "checkpoint_required",
    checkpointId,
    checkpointAction: "ReadMemory",
    checkpointReason: policy.reason,
    assistantContent: "",
    assistantContentBlocks: [],
    iterationsUsed: 0,
    toolCallsTotal: 0,
    iterationStats: [],
    modelFinishReason: null,
    modelUsageJson: null
  } as const
}
```

**5b. Extend `ProcessTurnResult`** to include optional checkpoint fields:

Add to the result schema (wherever `ProcessTurnResult` is defined):
```typescript
checkpointId: Schema.optionalKey(Schema.String),
checkpointAction: Schema.optionalKey(Schema.String),
checkpointReason: Schema.optionalKey(Schema.String)
```

**5c. Thread checkpoint signal from tool loop** — after `processWithToolLoop` returns, check for checkpoint:

In the workflow, after the tool loop result is processed (~line 395-416), check if a checkpoint was signaled during tool execution:

```typescript
// Check if a checkpoint was created during tool execution
if (checkpointSignal?.checkpointId) {
  return {
    turnId: payload.turnId,
    accepted: false,
    auditReasonCode: "checkpoint_required",
    checkpointId: checkpointSignal.checkpointId,
    checkpointAction: checkpointSignal.action,
    checkpointReason: checkpointSignal.reason,
    assistantContent: assistantResult.assistantContent,
    assistantContentBlocks: assistantResult.assistantContentBlocks,
    iterationsUsed: assistantResult.iterationsUsed,
    toolCallsTotal: assistantResult.toolCallsTotal,
    iterationStats: assistantResult.iterationStats,
    modelFinishReason,
    modelUsageJson: assistantResult.modelUsageJson
  } as const
}
```

**5d. Add `CheckpointPortTag` dependency** to the workflow's `Effect.gen` at the top.

**Verify:** `cd packages/server && bun run check`

---

### Task 6: TurnProcessingRuntime — emit checkpoint events

**Files:**
- Modify: `packages/server/src/turn/TurnProcessingRuntime.ts` (lines 64-119)

**6a. Update `toSuccessEvents`** to handle checkpoint results:

```typescript
const toSuccessEvents = (
  input: ProcessTurnPayload,
  result: ProcessTurnResult
): ReadonlyArray<TurnStreamEvent> => {
  const base = { turnId: input.turnId, sessionId: input.sessionId }

  // If a checkpoint was required, emit checkpoint event instead of normal completion
  if (result.checkpointId) {
    const checkpointEvent: TurnStreamEvent = {
      type: "turn.checkpoint_required" as const,
      ...base,
      sequence: 2,
      checkpointId: result.checkpointId,
      action: result.checkpointAction ?? "unknown",
      reason: result.checkpointReason ?? ""
    }
    return [checkpointEvent]
  }

  // ... existing event mapping (iterationEvents, contentEvents, completedEvent) ...
}
```

**Verify:** `cd packages/server && bun run check`

---

### Task 7: ChannelCore — decideCheckpoint + server wiring

**Files:**
- Modify: `packages/server/src/ChannelCore.ts`
- Create: `packages/server/src/gateway/CheckpointRoutes.ts`
- Modify: `packages/server/src/server.ts`

**7a. Add `decideCheckpoint` to ChannelCore:**

```typescript
const decideCheckpoint = (params: {
  readonly checkpointId: CheckpointId
  readonly decision: "Approved" | "Rejected" | "Deferred"
  readonly decidedBy: string
}) => {
  if (params.decision === "Rejected" || params.decision === "Deferred") {
    return Effect.gen(function*() {
      const now = yield* DateTime.now
      yield* checkpointPort.transition(
        params.checkpointId,
        params.decision,
        params.decidedBy,
        now
      )
    })
  }

  // Approved: transition + replay
  return Effect.gen(function*() {
    const now = yield* DateTime.now
    yield* checkpointPort.transition(
      params.checkpointId,
      "Approved",
      params.decidedBy,
      now
    )

    const checkpoint = yield* checkpointPort.get(params.checkpointId)
    if (checkpoint === null) {
      return yield* new CheckpointNotFound({ checkpointId: params.checkpointId })
    }

    // Deserialize payload and replay
    const payload = JSON.parse(checkpoint.payloadJson)
    return { checkpoint, payload } as const
  })
}
```

For the Approved case with replay-as-stream, `decideCheckpoint` returns the checkpoint and payload. The route handler uses this to build a turn payload and stream results. The route calls `buildTurnPayload` + `processTurn` with a `checkpointId` in the context for the governance bypass.

**7b. Create `CheckpointRoutes.ts`:**

Three routes:

```typescript
// GET /checkpoints/pending?agentId=optional
const listPending = HttpRouter.add("GET", "/checkpoints/pending", ...)

// GET /checkpoints/:checkpointId
const getCheckpoint = HttpRouter.add("GET", "/checkpoints/:checkpointId", ...)

// POST /checkpoints/:checkpointId/decide
// Body: { decision: "Approved" | "Rejected" | "Deferred" }
// For Approved: returns SSE stream with replayed turn events
// For Rejected/Deferred: returns { ok: true }
const decideCheckpoint = HttpRouter.add("POST", "/checkpoints/:checkpointId/decide", ...)
```

Follow patterns from `ChannelRoutes.ts` and `GovernanceRoutes.ts`. The decide route for Approved uses the same SSE stream pattern as `sendMessage` in ChannelRoutes.

**7c. Wire in `server.ts`:**

- Add CheckpointPortSqlite layer
- Add CheckpointPortTag layer
- Add CheckpointRoutes to the HTTP router merge
- Provide CheckpointPortTag to ToolRegistry and TurnProcessingWorkflow layers

**Verify:** `cd packages/server && bun run check`

---

### Task 8: Tests

**Files:**
- Create: `packages/server/test/CheckpointPortSqlite.test.ts`
- Modify: `packages/server/test/GovernancePortSqlite.test.ts`
- Modify: `packages/server/test/ToolRegistry.test.ts`

**8a. CheckpointPortSqlite tests:**

Follow patterns from `ChannelPortSqlite.test.ts`:

```typescript
// Test: create + get round-trips correctly
// Test: get returns null for unknown checkpoint
// Test: transition from Pending to Approved works
// Test: transition from Pending to Rejected works
// Test: transition from Approved fails with CheckpointAlreadyDecided
// Test: transition for unknown checkpoint fails with CheckpointNotFound
// Test: listPending returns only Pending checkpoints
// Test: listPending with agentId filter
// Test: expired checkpoint is treated as Expired on get
```

**8b. GovernancePortSqlite tests — default-deny:**

```typescript
// Test: evaluatePolicy for ReadMemory in Permissive mode returns Allow
// Test: evaluatePolicy for SpawnSubAgent in Standard mode returns RequireApproval
// Test: evaluatePolicy for SpawnSubAgent in Restrictive mode returns RequireApproval
// Test: evaluatePolicy for unknown action with no policy returns Deny (not Allow)
// Test: existing InvokeTool tests still pass
```

**8c. ToolRegistry tests — checkpoint creation:**

```typescript
// Test: RequireApproval creates checkpoint and signals it
// Test: checkpoint-authorized bypass skips policy evaluation
// Test: existing Allow/Deny tests still pass
```

**Verify:** `cd packages/server && bun run test`

---

### Task 9: Final verification

```bash
cd packages/domain && bun run check
cd packages/server && bun run check
bun run test
```

Verify:
1. All existing tests pass (no regressions)
2. New checkpoint tests pass
3. Policy evaluation for expanded actions works per mode
4. Default-deny for unmatched actions
5. Checkpoint lifecycle: create → decide → replay path compiles

---

## Dependency Graph

```
Task 1: Domain types (ids, status, errors, events, ports)
  └─→ Task 2: Migration 0012 + CheckpointPortSqlite
       └─→ Task 3: GovernancePortSqlite changes (remove fail-open)
            └─→ Task 4: ToolRegistry checkpoint creation
                 └─→ Task 5: TurnProcessingWorkflow checkpoint
                      └─→ Task 6: TurnProcessingRuntime events
                           └─→ Task 7: ChannelCore + Routes + wiring
Task 8: Tests (depends on Tasks 1-7)
Task 9: Final verification (after all)
```

**Batch 1:** Tasks 1, 2 (foundation — types + persistence)
**Batch 2:** Tasks 3, 4, 5, 6 (governance + checkpoint creation)
**Batch 3:** Tasks 7, 8, 9 (routes + wiring + tests + verification)

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `packages/domain/src/ids.ts` | Modify | 1 |
| `packages/domain/src/status.ts` | Modify | 1 |
| `packages/domain/src/errors.ts` | Modify | 1 |
| `packages/domain/src/events.ts` | Modify | 1 |
| `packages/domain/src/ports.ts` | Modify | 1 |
| `packages/server/src/persistence/DomainMigrator.ts` | Modify | 2 |
| `packages/server/src/CheckpointPortSqlite.ts` | Create | 2 |
| `packages/server/src/PortTags.ts` | Modify | 2 |
| `packages/server/src/GovernancePortSqlite.ts` | Modify | 3 |
| `packages/server/src/GovernancePortMemory.ts` | Modify | 3 |
| `packages/server/src/ai/ToolRegistry.ts` | Modify | 4 |
| `packages/server/src/turn/TurnProcessingWorkflow.ts` | Modify | 5 |
| `packages/server/src/turn/TurnProcessingRuntime.ts` | Modify | 6 |
| `packages/server/src/ChannelCore.ts` | Modify | 7 |
| `packages/server/src/gateway/CheckpointRoutes.ts` | Create | 7 |
| `packages/server/src/server.ts` | Modify | 7 |
| `packages/server/test/CheckpointPortSqlite.test.ts` | Create | 8 |
| `packages/server/test/GovernancePortSqlite.test.ts` | Modify | 8 |
| `packages/server/test/ToolRegistry.test.ts` | Modify | 8 |
