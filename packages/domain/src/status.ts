import { Schema } from "effect"

export const PermissionMode = Schema.Literals([
  "Permissive",
  "Standard",
  "Restrictive"
])
export type PermissionMode = typeof PermissionMode.Type

export const AgentRole = Schema.Literals([
  "SystemRole",
  "UserRole",
  "AssistantRole",
  "ToolRole"
])
export type AgentRole = typeof AgentRole.Type

export const AuthorizationDecision = Schema.Literals([
  "Allow",
  "Deny",
  "RequireApproval"
])
export type AuthorizationDecision = typeof AuthorizationDecision.Type

export const ContentBlockType = Schema.Literals([
  "TextBlock",
  "ToolUseBlock",
  "ToolResultBlock",
  "ImageBlock"
])
export type ContentBlockType = typeof ContentBlockType.Type

export const ScheduleStatus = Schema.Literals([
  "ScheduleActive",
  "SchedulePaused",
  "ScheduleExpired",
  "ScheduleDisabled"
])
export type ScheduleStatus = typeof ScheduleStatus.Type

export const ConcurrencyPolicy = Schema.Literals([
  "ConcurrencyAllow",
  "ConcurrencyForbid",
  "ConcurrencyReplace"
])
export type ConcurrencyPolicy = typeof ConcurrencyPolicy.Type

export const ExecutionOutcome = Schema.Literals([
  "ExecutionSucceeded",
  "ExecutionFailed",
  "ExecutionSkipped"
])
export type ExecutionOutcome = typeof ExecutionOutcome.Type

export const QuotaPeriod = Schema.Literals([
  "Daily",
  "Monthly",
  "Yearly",
  "Lifetime"
])
export type QuotaPeriod = typeof QuotaPeriod.Type

export const ModelFinishReason = Schema.Literals([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "pause",
  "other",
  "unknown"
])
export type ModelFinishReason = typeof ModelFinishReason.Type

export const ChannelType = Schema.Literals([
  "CLI",
  "HTTP"
])
export type ChannelType = typeof ChannelType.Type
