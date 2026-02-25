import { ToolQuotaExceeded } from "@template/domain/errors"
import type { AgentId, AuditEntryId, SessionId, ToolName } from "@template/domain/ids"
import { AuthorizationDecision } from "@template/domain/status"
import { Effect, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { GovernancePortTag } from "../PortTags.js"

const PolicyInputFields = {
  agentId: Schema.String,
  sessionId: Schema.String,
  action: Schema.Literals(["InvokeTool", "WriteMemory", "ReadMemory", "ExecuteSchedule"]),
  toolName: Schema.optional(Schema.String)
} as const

const PolicyDecisionSchema = Schema.Struct({
  decision: AuthorizationDecision,
  policyId: Schema.Union([Schema.String, Schema.Null]),
  reason: Schema.String
})

const AuditEntryFields = {
  auditEntryId: Schema.String,
  agentId: Schema.String,
  sessionId: Schema.Union([Schema.String, Schema.Null]),
  decision: AuthorizationDecision,
  reason: Schema.String,
  createdAt: Schema.DateTimeUtc
} as const

const EvaluatePolicyRpc = Rpc.make("evaluatePolicy", {
  payload: PolicyInputFields,
  success: PolicyDecisionSchema,
  primaryKey: ({ agentId, sessionId }) => `policy:${agentId}:${sessionId}`
}).annotate(ClusterSchema.Persisted, true)

const CheckToolQuotaRpc = Rpc.make("checkToolQuota", {
  payload: {
    agentId: Schema.String,
    toolName: Schema.String,
    now: Schema.DateTimeUtc
  },
  success: Schema.Void,
  error: ToolQuotaExceeded,
  primaryKey: ({ agentId, toolName }) => `quota:${agentId}:${toolName}`
}).annotate(ClusterSchema.Persisted, true)

const WriteAuditRpc = Rpc.make("writeAudit", {
  payload: AuditEntryFields,
  success: Schema.Void,
  primaryKey: ({ auditEntryId }) => auditEntryId
}).annotate(ClusterSchema.Persisted, true)

export const GovernanceEntity = Entity.make("Governance", [
  EvaluatePolicyRpc,
  CheckToolQuotaRpc,
  WriteAuditRpc
])

export const layer = GovernanceEntity.toLayer(Effect.gen(function*() {
  const port = yield* GovernancePortTag

  return {
    evaluatePolicy: ({ payload }) =>
      port.evaluatePolicy({
        agentId: payload.agentId as AgentId,
        sessionId: payload.sessionId as SessionId,
        action: payload.action,
        ...(payload.toolName !== undefined ? { toolName: payload.toolName as ToolName } : {})
      }),

    checkToolQuota: ({ payload }) =>
      port.checkToolQuota(
        payload.agentId as AgentId,
        payload.toolName as ToolName,
        payload.now
      ),

    writeAudit: ({ payload }) =>
      port.writeAudit({
        auditEntryId: payload.auditEntryId as AuditEntryId,
        agentId: payload.agentId as AgentId,
        sessionId: payload.sessionId as SessionId | null,
        decision: payload.decision,
        reason: payload.reason,
        createdAt: payload.createdAt
      })
  }
}))
