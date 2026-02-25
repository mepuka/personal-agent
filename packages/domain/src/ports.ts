import type { Effect } from "effect"
import { Schema } from "effect"
import type {
  ContextWindowExceeded,
  SandboxViolation,
  SessionNotFound,
  TokenBudgetExceeded,
  ToolQuotaExceeded
} from "./errors.js"
import type {
  AgentId,
  AuditEntryId,
  ChannelId,
  ConversationId,
  MemoryItemId,
  PolicyId,
  ScheduledExecutionId,
  ScheduleId,
  SessionId,
  ToolName,
  TurnId
} from "./ids.js"
import { MessageId } from "./ids.js"
import type {
  MemoryScope,
  MemorySource,
  MemoryTier,
  SensitivityLevel
} from "./memory.js"
import type {
  AuthorizationDecision,
  ChannelType,
  ConcurrencyPolicy,
  ExecutionOutcome,
  MemorySortOrder,
  ModelFinishReason,
  PermissionMode,
  QuotaPeriod,
  ScheduleStatus
} from "./status.js"
import { AgentRole } from "./status.js"

export const Instant = Schema.DateTimeUtc
export type Instant = typeof Instant.Type

export interface AgentState {
  readonly agentId: AgentId
  readonly permissionMode: PermissionMode
  readonly tokenBudget: number
  readonly quotaPeriod: QuotaPeriod
  readonly tokensConsumed: number
  readonly budgetResetAt: Instant | null
}

export interface SessionState {
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly tokenCapacity: number
  readonly tokensUsed: number
}

export const TextBlock = Schema.Struct({
  contentBlockType: Schema.Literal("TextBlock"),
  text: Schema.String
})
export type TextBlock = typeof TextBlock.Type

export const ToolUseBlock = Schema.Struct({
  contentBlockType: Schema.Literal("ToolUseBlock"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  inputJson: Schema.String
})
export type ToolUseBlock = typeof ToolUseBlock.Type

export const ToolResultBlock = Schema.Struct({
  contentBlockType: Schema.Literal("ToolResultBlock"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  outputJson: Schema.String,
  isError: Schema.Boolean
})
export type ToolResultBlock = typeof ToolResultBlock.Type

export const ImageBlock = Schema.Struct({
  contentBlockType: Schema.Literal("ImageBlock"),
  mediaType: Schema.String,
  source: Schema.String,
  altText: Schema.Union([Schema.String, Schema.Null])
})
export type ImageBlock = typeof ImageBlock.Type

export const ContentBlock = Schema.Union([
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock
])
export type ContentBlock = typeof ContentBlock.Type

export const MessageRecord = Schema.Struct({
  messageId: MessageId,
  role: AgentRole,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlock)
})
export type MessageRecord = typeof MessageRecord.Type

export interface TurnRecord {
  readonly turnId: TurnId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly turnIndex: number
  readonly participantRole: AgentRole
  readonly participantAgentId: AgentId | null
  readonly message: MessageRecord
  readonly modelFinishReason: ModelFinishReason | null
  readonly modelUsageJson: string | null
  readonly createdAt: Instant
}

export interface MemorySearchQuery {
  readonly query?: string
  readonly tier?: MemoryTier
  readonly scope?: MemoryScope
  readonly source?: MemorySource
  readonly sort?: MemorySortOrder
  readonly limit?: number
  readonly cursor?: string
}

export interface MemorySearchResult {
  readonly items: ReadonlyArray<MemoryItemRecord>
  readonly cursor: string | null
  readonly totalCount: number
}

export interface MemoryItemRecord {
  readonly memoryItemId: MemoryItemId
  readonly agentId: AgentId
  readonly tier: MemoryTier
  readonly scope: MemoryScope
  readonly source: MemorySource
  readonly content: string
  readonly metadataJson: string | null
  readonly generatedByTurnId: TurnId | null
  readonly sessionId: SessionId | null
  readonly sensitivity: SensitivityLevel
  readonly createdAt: Instant
  readonly updatedAt: Instant
}

export interface PolicyInput {
  readonly agentId: AgentId
  readonly sessionId: SessionId | null
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
  readonly createdAt: Instant
}

export interface RecurrencePattern {
  readonly label: string
  readonly cronExpression: string | null
  readonly intervalSeconds: number | null
}

export interface CronTrigger {
  readonly _tag: "CronTrigger"
}

export interface IntervalTrigger {
  readonly _tag: "IntervalTrigger"
}

export interface EventTrigger {
  readonly _tag: "EventTrigger"
}

export type Trigger = CronTrigger | IntervalTrigger | EventTrigger

export const TriggerSource = Schema.Literals([
  "CronTick",
  "IntervalTick",
  "Event",
  "Manual"
])
export type TriggerSource = typeof TriggerSource.Type

export const ScheduleSkipReason = Schema.Literals([
  "ConcurrencyForbid",
  "ConcurrencyReplace",
  "ManualTriggerInactive"
])
export type ScheduleSkipReason = typeof ScheduleSkipReason.Type

export interface ScheduleRecord {
  readonly scheduleId: ScheduleId
  readonly ownerAgentId: AgentId
  readonly recurrencePattern: RecurrencePattern
  readonly trigger: Trigger
  readonly actionRef: string
  readonly scheduleStatus: ScheduleStatus
  readonly concurrencyPolicy: ConcurrencyPolicy
  readonly allowsCatchUp: boolean
  readonly autoDisableAfterRun: boolean
  readonly catchUpWindowSeconds: number
  readonly maxCatchUpRunsPerTick: number
  readonly lastExecutionAt: Instant | null
  readonly nextExecutionAt: Instant | null
}

export interface ScheduledExecutionRecord {
  readonly executionId: ScheduledExecutionId
  readonly scheduleId: ScheduleId
  readonly dueAt: Instant
  readonly triggerSource: TriggerSource
  readonly outcome: ExecutionOutcome
  readonly startedAt: Instant
  readonly endedAt: Instant | null
  readonly skipReason: ScheduleSkipReason | null
}

export interface DueScheduleRecord {
  readonly schedule: ScheduleRecord
  readonly dueAt: Instant
  readonly triggerSource: TriggerSource
}

// Stable MVP ports. Keep these narrow and compose on Effect primitives.
export interface AgentStatePort {
  readonly get: (agentId: AgentId) => Effect.Effect<AgentState | null>
  readonly upsert: (agentState: AgentState) => Effect.Effect<void>
  readonly consumeTokenBudget: (
    agentId: AgentId,
    requestedTokens: number,
    now: Instant
  ) => Effect.Effect<void, TokenBudgetExceeded>
}

export interface SessionTurnPort {
  readonly startSession: (state: SessionState) => Effect.Effect<void>
  readonly appendTurn: (turn: TurnRecord) => Effect.Effect<void>
  readonly updateContextWindow: (
    sessionId: SessionId,
    deltaTokens: number
  ) => Effect.Effect<void, ContextWindowExceeded | SessionNotFound>
  readonly listTurns: (
    sessionId: SessionId
  ) => Effect.Effect<ReadonlyArray<TurnRecord>>
}

export interface MemoryPort {
  readonly search: (
    agentId: AgentId,
    query: MemorySearchQuery
  ) => Effect.Effect<MemorySearchResult>
  readonly encode: (
    agentId: AgentId,
    items: ReadonlyArray<{
      readonly tier: MemoryTier
      readonly scope: MemoryScope
      readonly source: MemorySource
      readonly content: string
      readonly metadataJson?: string | null
      readonly generatedByTurnId?: TurnId | null
      readonly sessionId?: SessionId | null
      readonly sensitivity?: SensitivityLevel
    }>,
    now: Instant
  ) => Effect.Effect<ReadonlyArray<MemoryItemId>>
  readonly forget: (agentId: AgentId, cutoff: Instant) => Effect.Effect<number>
}

export interface GovernancePort {
  readonly evaluatePolicy: (input: PolicyInput) => Effect.Effect<PolicyDecision>
  readonly checkToolQuota: (
    agentId: AgentId,
    toolName: ToolName,
    now: Instant
  ) => Effect.Effect<void, ToolQuotaExceeded>
  readonly writeAudit: (entry: AuditEntryRecord) => Effect.Effect<void>
  readonly enforceSandbox: <A, E, R>(
    agentId: AgentId,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | SandboxViolation, R>
}

export interface SchedulePort {
  readonly upsertSchedule: (schedule: ScheduleRecord) => Effect.Effect<void>
  readonly listDue: (now: Instant) => Effect.Effect<ReadonlyArray<DueScheduleRecord>>
  readonly recordExecution: (record: ScheduledExecutionRecord) => Effect.Effect<void>
}

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
