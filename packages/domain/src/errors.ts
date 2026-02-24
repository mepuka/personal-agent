import { Schema } from "effect"
import { AgentId, ToolName } from "./ids.js"

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
