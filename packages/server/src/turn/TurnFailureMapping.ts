import type { TurnFailureCode } from "@template/domain/events"

const getStringField = (value: unknown, key: string): string => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ""
  }
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : ""
}

const normalize = (value: string): string => value.trim().toLowerCase()

const isProviderCreditFailure = (value: string): boolean => {
  const text = normalize(value)
  return text.includes("provider_credit_exhausted")
    || text.includes("credit balance is too low")
    || text.includes("insufficient credits")
    || text.includes("insufficient_quota")
    || text.includes("billing")
}

const classifyByReason = (reason: string): TurnFailureCode => {
  const text = normalize(reason)
  if (isProviderCreditFailure(text)) return "provider_credit_exhausted"
  if (text.includes("checkpointpayloadmismatch") || text.includes("checkpoint_payload_mismatch")) {
    return "checkpoint_payload_mismatch"
  }
  if (text.includes("checkpointnotapproved") || text.includes("checkpoint_not_approved")) {
    return "checkpoint_not_approved"
  }
  if (text.includes("checkpoint_payload_invalid") || text.includes("checkpoint_not_found_after_transition")) {
    return "checkpoint_payload_invalid"
  }
  if (text.includes("toolquotaexceeded") || text.includes("tool_quota_exceeded")) {
    return "tool_quota_exceeded"
  }
  if (text.includes("tool_loop_timeout") || text.includes("tool_timeout")) {
    return "tool_timeout"
  }
  if (text.includes("session_entity_")) {
    return "session_entity_error"
  }
  if (text.includes("policydenied") || text.includes("policy_denied") || text.includes("memoryaccessdenied")) {
    return "policy_denied"
  }
  if (text.includes("toolinvocationerror") || text.includes("tool_execution_failed")) {
    return "tool_execution_error"
  }
  return "turn_processing_error"
}

const classifyByTag = (tag: string): TurnFailureCode | null => {
  switch (tag) {
    case "TurnPolicyDenied":
      return "policy_denied"
    case "TurnModelFailure":
      return null
    case "TokenBudgetExceeded":
    case "ContextWindowExceeded":
    case "SessionNotFound":
      return "turn_processing_error"
    default:
      return null
  }
}

export const toTurnFailureMessage = (error: unknown, fallback: string): string => {
  const reason = getStringField(error, "reason")
  if (reason.length > 0) return reason
  const message = getStringField(error, "message")
  if (message.length > 0) return message
  if (error instanceof Error && error.message.length > 0) return error.message
  const stringified = String(error)
  return stringified.length > 0 ? stringified : fallback
}

export const toTurnFailureCode = (error: unknown, message: string): TurnFailureCode => {
  const tag = getStringField(error, "_tag")
  const byTag = classifyByTag(tag)
  if (byTag !== null && byTag !== "turn_processing_error") {
    return byTag
  }

  const embeddedCode = getStringField(error, "errorCode")
  if (embeddedCode.length > 0) {
    return classifyByReason(embeddedCode)
  }

  const reason = getStringField(error, "reason")
  if (reason.length > 0) {
    return classifyByReason(reason)
  }

  if (byTag !== null) {
    return byTag
  }

  return classifyByReason(message)
}

export const toTurnFailureIdentity = (error: unknown): {
  readonly turnId: string
  readonly sessionId: string
} => ({
  turnId: getStringField(error, "turnId"),
  sessionId: getStringField(error, "sessionId")
})
