import { Schema } from "effect"

export const PermissionMode = Schema.Literals([
  "Permissive",
  "Standard",
  "Restrictive"
])
export type PermissionMode = typeof PermissionMode.Type

export const AuthorizationDecision = Schema.Literals([
  "Allow",
  "Deny",
  "RequireApproval"
])
export type AuthorizationDecision = typeof AuthorizationDecision.Type

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
