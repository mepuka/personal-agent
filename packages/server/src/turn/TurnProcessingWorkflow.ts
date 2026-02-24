import { Effect, Schema } from "effect"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { ContextWindowExceeded, SessionNotFound, TokenBudgetExceeded } from "../../../domain/src/errors.js"
import type { AgentId, AuditEntryId, ConversationId, SessionId, TurnId } from "../../../domain/src/ids.js"
import type { AuditEntryRecord } from "../../../domain/src/ports.js"
import { AgentStatePortTag, GovernancePortTag, SessionTurnPortTag } from "../PortTags.js"

export const TurnAuditReasonCode = Schema.Literals([
  "turn_processing_accepted",
  "turn_processing_policy_denied",
  "turn_processing_requires_approval",
  "turn_processing_token_budget_exceeded"
])
export type TurnAuditReasonCode = typeof TurnAuditReasonCode.Type

export const ProcessTurnPayload = Schema.Struct({
  turnId: Schema.String,
  sessionId: Schema.String,
  conversationId: Schema.String,
  agentId: Schema.String,
  content: Schema.String,
  createdAt: Schema.DateTimeUtc,
  inputTokens: Schema.Number
})
export type ProcessTurnPayload = typeof ProcessTurnPayload.Type

export const ProcessTurnResult = Schema.Struct({
  turnId: Schema.String,
  accepted: Schema.Boolean,
  auditReasonCode: TurnAuditReasonCode
})
export type ProcessTurnResult = typeof ProcessTurnResult.Type

export class TurnPolicyDenied extends Schema.ErrorClass<TurnPolicyDenied>(
  "TurnPolicyDenied"
)({
  _tag: Schema.tag("TurnPolicyDenied"),
  turnId: Schema.String,
  reason: Schema.String
}) {}

export const TurnProcessingError = Schema.Union([
  TurnPolicyDenied,
  TokenBudgetExceeded,
  SessionNotFound,
  ContextWindowExceeded
])
export type TurnProcessingError = typeof TurnProcessingError.Type

const PolicyDecisionSchema = Schema.Struct({
  decision: Schema.Literals(["Allow", "Deny", "RequireApproval"]),
  policyId: Schema.Union([Schema.String, Schema.Null]),
  reason: Schema.String
})

const PersistTurnError = Schema.Union([SessionNotFound, ContextWindowExceeded])

export const TurnProcessingWorkflow = Workflow.make({
  name: "TurnProcessingWorkflow",
  payload: ProcessTurnPayload,
  success: ProcessTurnResult,
  error: TurnProcessingError,
  idempotencyKey: (payload) => payload.turnId
})

export const layer = TurnProcessingWorkflow.toLayer(
  Effect.fn("TurnProcessingWorkflow.execute")(function*(payload) {
    const agentStatePort = yield* AgentStatePortTag
    const sessionTurnPort = yield* SessionTurnPortTag
    const governancePort = yield* GovernancePortTag

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
      yield* writeAuditEntry(
        governancePort,
        payload,
        "Deny",
        "turn_processing_policy_denied"
      )
      return yield* new TurnPolicyDenied({
        turnId: payload.turnId,
        reason: policy.reason
      })
    }

    if (policy.decision === "RequireApproval") {
      yield* writeAuditEntry(
        governancePort,
        payload,
        "RequireApproval",
        "turn_processing_requires_approval"
      )
      return yield* new TurnPolicyDenied({
        turnId: payload.turnId,
        reason: policy.reason
      })
    }

    yield* Activity.make({
      name: "CheckTokenBudget",
      error: TokenBudgetExceeded,
      execute: agentStatePort.consumeTokenBudget(
        payload.agentId as AgentId,
        payload.inputTokens,
        payload.createdAt
      )
    }).asEffect().pipe(
      Effect.catchTag("TokenBudgetExceeded", (error) =>
        writeAuditEntry(
          governancePort,
          payload,
          "Deny",
          "turn_processing_token_budget_exceeded"
        ).pipe(
          Effect.andThen(Effect.fail(error))
        ))
    )

    yield* Activity.make({
      name: "PersistTurn",
      error: PersistTurnError,
      execute: Effect.gen(function*() {
        yield* Activity.idempotencyKey("PersistTurn")
        yield* sessionTurnPort.updateContextWindow(
          payload.sessionId as SessionId,
          payload.inputTokens
        )
        yield* sessionTurnPort.appendTurn({
          turnId: payload.turnId as TurnId,
          sessionId: payload.sessionId as SessionId,
          conversationId: payload.conversationId as ConversationId,
          agentId: payload.agentId as AgentId,
          content: payload.content,
          createdAt: payload.createdAt
        })
      })
    }).asEffect()

    yield* writeAuditEntry(
      governancePort,
      payload,
      "Allow",
      "turn_processing_accepted"
    )

    return {
      turnId: payload.turnId,
      accepted: true,
      auditReasonCode: "turn_processing_accepted"
    } as const
  })
)

const writeAuditEntry = (
  governancePort: {
    readonly writeAudit: (entry: AuditEntryRecord) => Effect.Effect<void>
  },
  payload: ProcessTurnPayload,
  decision: AuditEntryRecord["decision"],
  reasonCode: TurnAuditReasonCode
) =>
  Activity.make({
    name: "WriteAudit",
    execute: Effect.gen(function*() {
      const idempotencyKey = yield* Activity.idempotencyKey(`WriteAudit:${reasonCode}`)
      const auditEntryId = (`audit:${idempotencyKey}`) as AuditEntryId
      yield* governancePort.writeAudit({
        auditEntryId,
        agentId: payload.agentId as AgentId,
        sessionId: payload.sessionId as SessionId,
        decision,
        reason: reasonCode,
        createdAt: payload.createdAt
      })
    })
  }).asEffect()
