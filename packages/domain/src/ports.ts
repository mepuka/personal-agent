import { Effect } from "effect"
import {
  ContextWindowExceeded,
  SandboxViolation,
  SessionNotFound,
  TokenBudgetExceeded,
  ToolQuotaExceeded
} from "./errors.js"
import {
  AgentId,
  AuditEntryId,
  ConversationId,
  MemoryItemId,
  PolicyId,
  ScheduleId,
  ScheduledExecutionId,
  SessionId,
  ToolName,
  TurnId
} from "./ids.js"
import {
  AuthorizationDecision,
  ConcurrencyPolicy,
  ExecutionOutcome,
  PermissionMode,
  QuotaPeriod,
  ScheduleStatus
} from "./status.js"

export interface AgentState {
  readonly agentId: AgentId
  readonly permissionMode: PermissionMode
  readonly tokenBudget: number
  readonly quotaPeriod: QuotaPeriod
  readonly tokensConsumed: number
  readonly budgetResetAt: Date | null
}

export interface SessionState {
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly tokenCapacity: number
  readonly tokensUsed: number
}

export interface TurnRecord {
  readonly turnId: TurnId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly agentId: AgentId
  readonly content: string
  readonly createdAt: Date
}

export interface MemoryQuery {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly text: string
  readonly limit: number
}

export interface MemoryItemRecord {
  readonly memoryItemId: MemoryItemId
  readonly agentId: AgentId
  readonly tier: "WorkingMemory" | "EpisodicMemory" | "SemanticMemory" | "ProceduralMemory"
  readonly content: string
  readonly generatedByTurnId: TurnId | null
  readonly createdAt: Date
}

export interface PolicyInput {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly action: "InvokeTool" | "WriteMemory" | "ReadMemory" | "ExecuteSchedule"
  readonly toolName?: ToolName
}

export interface PolicyDecision {
  readonly decision: AuthorizationDecision
  readonly policyId: PolicyId | null
  readonly reason: string
}

export interface AuditEntryRecord {
  readonly auditEntryId: AuditEntryId
  readonly agentId: AgentId
  readonly sessionId: SessionId | null
  readonly decision: AuthorizationDecision
  readonly reason: string
  readonly createdAt: Date
}

export interface ScheduleRecord {
  readonly scheduleId: ScheduleId
  readonly ownerAgentId: AgentId
  readonly scheduleStatus: ScheduleStatus
  readonly concurrencyPolicy: ConcurrencyPolicy
  readonly allowsCatchUp: boolean
  readonly autoDisableAfterRun: boolean
  readonly catchUpWindowSeconds: number
  readonly maxCatchUpRunsPerTick: number
  readonly nextExecutionAt: Date | null
}

export interface ScheduledExecutionRecord {
  readonly executionId: ScheduledExecutionId
  readonly scheduleId: ScheduleId
  readonly outcome: ExecutionOutcome
  readonly startedAt: Date
  readonly endedAt: Date | null
  readonly skipReason: string | null
}

// Stable MVP ports. Keep these narrow and compose on Effect primitives.
export interface AgentStatePort {
  readonly get: (agentId: AgentId) => Effect.Effect<AgentState | null>
  readonly upsert: (agentState: AgentState) => Effect.Effect<void>
  readonly consumeTokenBudget: (
    agentId: AgentId,
    requestedTokens: number,
    now: Date
  ) => Effect.Effect<void, TokenBudgetExceeded>
}

export interface SessionTurnPort {
  readonly startSession: (state: SessionState) => Effect.Effect<void>
  readonly appendTurn: (turn: TurnRecord) => Effect.Effect<void>
  readonly updateContextWindow: (
    sessionId: SessionId,
    deltaTokens: number
  ) => Effect.Effect<void, ContextWindowExceeded | SessionNotFound>
}

export interface MemoryPort {
  readonly retrieve: (query: MemoryQuery) => Effect.Effect<ReadonlyArray<MemoryItemRecord>>
  readonly encode: (
    items: ReadonlyArray<MemoryItemRecord>,
    now: Date
  ) => Effect.Effect<ReadonlyArray<MemoryItemId>>
  readonly forget: (agentId: AgentId, cutoff: Date) => Effect.Effect<number>
}

export interface GovernancePort {
  readonly evaluatePolicy: (input: PolicyInput) => Effect.Effect<PolicyDecision>
  readonly checkToolQuota: (
    agentId: AgentId,
    toolName: ToolName,
    now: Date
  ) => Effect.Effect<void, ToolQuotaExceeded>
  readonly writeAudit: (entry: AuditEntryRecord) => Effect.Effect<void>
  readonly enforceSandbox: <A, E, R>(
    agentId: AgentId,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SandboxViolation, R>
}

export interface SchedulePort {
  readonly upsertSchedule: (schedule: ScheduleRecord) => Effect.Effect<void>
  readonly listDue: (now: Date) => Effect.Effect<ReadonlyArray<ScheduleRecord>>
  readonly recordExecution: (record: ScheduledExecutionRecord) => Effect.Effect<void>
}
