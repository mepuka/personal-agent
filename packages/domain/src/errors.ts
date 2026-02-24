import { Schema } from "effect"
import { AgentId, SessionId, ToolName } from "./ids.js"

export class TokenBudgetExceeded extends Schema.ErrorClass<TokenBudgetExceeded>("TokenBudgetExceeded")({
  _tag: Schema.tag("TokenBudgetExceeded"),
  agentId: AgentId,
  requestedTokens: Schema.Number,
  remainingTokens: Schema.Number
}) {}

export class ToolQuotaExceeded extends Schema.ErrorClass<ToolQuotaExceeded>("ToolQuotaExceeded")({
  _tag: Schema.tag("ToolQuotaExceeded"),
  agentId: AgentId,
  toolName: ToolName,
  remainingInvocations: Schema.Number
}) {}

export class SandboxViolation extends Schema.ErrorClass<SandboxViolation>("SandboxViolation")({
  _tag: Schema.tag("SandboxViolation"),
  agentId: AgentId,
  reason: Schema.String
}) {}

export class SessionNotFound extends Schema.ErrorClass<SessionNotFound>("SessionNotFound")({
  _tag: Schema.tag("SessionNotFound"),
  sessionId: SessionId
}) {}

export class ContextWindowExceeded extends Schema.ErrorClass<ContextWindowExceeded>("ContextWindowExceeded")({
  _tag: Schema.tag("ContextWindowExceeded"),
  sessionId: SessionId,
  tokenCapacity: Schema.Number,
  attemptedTokensUsed: Schema.Number
}) {}
