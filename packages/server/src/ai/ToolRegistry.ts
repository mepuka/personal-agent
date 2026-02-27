import type {
  AgentId,
  AuditEntryId,
  AuditLogId,
  ConversationId,
  PolicyId,
  SessionId,
  ToolDefinitionId,
  ToolInvocationId,
  ToolName,
  TurnId
} from "@template/domain/ids"
import type { Instant } from "@template/domain/ports"
import type { AuthorizationDecision, ComplianceStatus } from "@template/domain/status"
import { Cause, DateTime, Effect, Exit, Layer, Schema, ServiceMap } from "effect"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import { GovernancePortTag } from "../PortTags.js"

const POLICY_SYSTEM_ERROR = "policy:invoke_tool:system_error:v1" as PolicyId
const DEFAULT_AUDIT_LOG_ID = "auditlog:governance:default:v1" as AuditLogId

const ToolFailure = Schema.Struct({
  errorCode: Schema.String,
  message: Schema.String
})
type ToolFailure = typeof ToolFailure.Type

const TimeNowTool = Tool.make("time_now", {
  description: "Return the current UTC timestamp as ISO 8601.",
  success: Schema.Struct({
    nowIso: Schema.String
  }),
  failure: ToolFailure
})

const MathCalculateTool = Tool.make("math_calculate", {
  description: "Evaluate a basic arithmetic expression.",
  parameters: Schema.Struct({
    expression: Schema.String
  }),
  success: Schema.Struct({
    result: Schema.Number
  }),
  failure: ToolFailure
})

const EchoTextTool = Tool.make("echo_text", {
  description: "Return provided text verbatim.",
  parameters: Schema.Struct({
    text: Schema.String
  }),
  success: Schema.Struct({
    text: Schema.String
  }),
  failure: ToolFailure
})

const SafeToolkit = Toolkit.make(TimeNowTool, MathCalculateTool, EchoTextTool)

export interface ToolExecutionContext {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly turnId: TurnId
  readonly now: Instant
}

export interface ToolRegistryService {
  readonly makeToolkit: (context: ToolExecutionContext) => Effect.Effect<{
    readonly toolkit: typeof SafeToolkit
    readonly handlerLayer: Layer.Layer<any>
  }>
}

export class ToolRegistry extends ServiceMap.Service<ToolRegistry>()(
  "server/ai/ToolRegistry",
  {
    make: Effect.gen(function*() {
      const governance = yield* GovernancePortTag

      const persistInvocation = (params: {
        readonly context: ToolExecutionContext
        readonly toolName: ToolName
        readonly inputJson: string
        readonly outputJson: string
        readonly decision: AuthorizationDecision
        readonly complianceStatus: ComplianceStatus
        readonly policyId: PolicyId
        readonly toolDefinitionId: ToolDefinitionId | null
        readonly reason: string
      }) =>
        Effect.gen(function*() {
          const toolInvocationId = (`toolinv:${crypto.randomUUID()}`) as ToolInvocationId
          const auditEntryId = (`audit:${params.context.turnId}:${crypto.randomUUID()}`) as AuditEntryId

          yield* governance.recordToolInvocationWithAudit({
            invocation: {
              toolInvocationId,
              auditEntryId,
              toolDefinitionId: params.toolDefinitionId,
              auditLogId: DEFAULT_AUDIT_LOG_ID,
              agentId: params.context.agentId,
              sessionId: params.context.sessionId,
              conversationId: params.context.conversationId,
              turnId: params.context.turnId,
              toolName: params.toolName,
              inputJson: params.inputJson,
              outputJson: params.outputJson,
              decision: params.decision,
              complianceStatus: params.complianceStatus,
              policyId: params.policyId,
              reason: params.reason,
              invokedAt: params.context.now,
              completedAt: params.context.now
            },
            audit: {
              auditEntryId,
              auditLogId: DEFAULT_AUDIT_LOG_ID,
              toolInvocationId,
              agentId: params.context.agentId,
              sessionId: params.context.sessionId,
              decision: params.decision,
              reason: params.reason,
              createdAt: params.context.now
            }
          })
        })

      const failWithRecordedInvocation = (params: {
        readonly context: ToolExecutionContext
        readonly toolName: ToolName
        readonly inputJson: string
        readonly decision: "Deny" | "RequireApproval"
        readonly policyId: PolicyId
        readonly toolDefinitionId: ToolDefinitionId | null
        readonly reason: string
        readonly failure: ToolFailure
      }): Effect.Effect<never, ToolFailure> =>
        persistInvocation({
          context: params.context,
          toolName: params.toolName,
          inputJson: params.inputJson,
          outputJson: safeJsonStringify(params.failure),
          decision: params.decision,
          complianceStatus: "NonCompliant",
          policyId: params.policyId,
          toolDefinitionId: params.toolDefinitionId,
          reason: params.reason
        }).pipe(
          Effect.andThen(Effect.fail(params.failure))
        )

      const runGovernedTool = <A>(
        context: ToolExecutionContext,
        toolName: ToolName,
        input: Record<string, unknown>,
        execute: Effect.Effect<A, ToolFailure>
      ): Effect.Effect<A, ToolFailure> =>
        Effect.gen(function*() {
          const inputJson = safeJsonStringify(input)
          const policy = yield* governance.evaluatePolicy({
            agentId: context.agentId,
            sessionId: context.sessionId,
            action: "InvokeTool",
            toolName
          }).pipe(
            Effect.catchCause(() =>
              failWithRecordedInvocation({
                context,
                toolName,
                inputJson,
                decision: "Deny",
                policyId: POLICY_SYSTEM_ERROR,
                toolDefinitionId: null,
                reason: "governance_system_error:evaluate_policy",
                failure: {
                  errorCode: "GovernancePolicyError",
                  message: "policy evaluation failed"
                }
              })
            )
          )

          if (policy.decision === "Deny") {
            return yield* failWithRecordedInvocation({
              context,
              toolName,
              inputJson,
              decision: "Deny",
              policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
              toolDefinitionId: policy.toolDefinitionId,
              reason: `tool_policy_denied:${toolName}`,
              failure: {
                errorCode: "PolicyDenied",
                message: policy.reason
              }
            })
          }

          if (policy.decision === "RequireApproval") {
            return yield* failWithRecordedInvocation({
              context,
              toolName,
              inputJson,
              decision: "RequireApproval",
              policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
              toolDefinitionId: policy.toolDefinitionId,
              reason: `tool_requires_approval:${toolName}`,
              failure: {
                errorCode: "RequiresApproval",
                message: policy.reason
              }
            })
          }

          const quotaExit = yield* governance.checkToolQuota(context.agentId, toolName, context.now).pipe(
            Effect.exit
          )
          if (Exit.isFailure(quotaExit)) {
            const failReason = quotaExit.cause.reasons.find(Cause.isFailReason)
            if (failReason !== undefined && isToolQuotaExceededError(failReason.error)) {
              return yield* failWithRecordedInvocation({
                context,
                toolName,
                inputJson,
                decision: "Deny",
                policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
                toolDefinitionId: policy.toolDefinitionId,
                reason: `tool_quota_exceeded:${toolName}`,
                failure: {
                  errorCode: "ToolQuotaExceeded",
                  message: `remaining_invocations=${failReason.error.remainingInvocations}`
                }
              })
            }

            return yield* failWithRecordedInvocation({
              context,
              toolName,
              inputJson,
              decision: "Deny",
              policyId: POLICY_SYSTEM_ERROR,
              toolDefinitionId: policy.toolDefinitionId,
              reason: "governance_system_error:check_quota",
              failure: {
                errorCode: "GovernanceQuotaError",
                message: "quota check failed"
              }
            })
          }

          return yield* execute.pipe(
            Effect.tap((result) =>
              persistInvocation({
                context,
                toolName,
                inputJson,
                outputJson: safeJsonStringify(result),
                decision: "Allow",
                complianceStatus: "Compliant",
                policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
                toolDefinitionId: policy.toolDefinitionId,
                reason: `tool_invoked:${toolName}`
              })
            ),
            Effect.catch((failure) =>
              persistInvocation({
                context,
                toolName,
                inputJson,
                outputJson: safeJsonStringify(failure),
                decision: "Allow",
                complianceStatus: "Compliant",
                policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
                toolDefinitionId: policy.toolDefinitionId,
                reason: `tool_execution_failed:${toolName}:${failure.errorCode}`
              }).pipe(
                Effect.andThen(Effect.fail(failure))
              )
            )
          )
        }) as Effect.Effect<A, ToolFailure>

      const makeToolkit: ToolRegistryService["makeToolkit"] = (context) =>
        Effect.succeed({
          toolkit: SafeToolkit,
          handlerLayer: SafeToolkit.toLayer(
            SafeToolkit.of({
              "time_now": () =>
                runGovernedTool(
                  context,
                  "time_now" as ToolName,
                  {},
                  Effect.succeed({
                    nowIso: DateTime.formatIso(context.now)
                  })
                ),
              "math_calculate": ({ expression }) => {
                const result = safeCalculate(expression)
                return runGovernedTool(
                  context,
                  "math_calculate" as ToolName,
                  { expression },
                  result === null
                    ? Effect.fail<ToolFailure>({
                      errorCode: "InvalidExpression",
                      message: "Expression must contain only numbers and arithmetic operators."
                    })
                    : Effect.succeed({ result })
                )
              },
              "echo_text": ({ text }) =>
                runGovernedTool(
                  context,
                  "echo_text" as ToolName,
                  { text },
                  Effect.succeed({ text })
                )
            })
          )
        })

      return {
        makeToolkit
      } satisfies ToolRegistryService
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ value: String(value) })
  }
}

const safeCalculate = (expression: string): number | null => {
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
    return null
  }

  try {
    const evaluated = Number(
      Function(`"use strict"; return (${expression});`)()
    )
    return Number.isFinite(evaluated) ? evaluated : null
  } catch {
    return null
  }
}

const isToolQuotaExceededError = (
  error: unknown
): error is { readonly _tag: "ToolQuotaExceeded"; readonly remainingInvocations: number } =>
  typeof error === "object"
  && error !== null
  && "_tag" in error
  && error._tag === "ToolQuotaExceeded"
  && "remainingInvocations" in error
  && typeof error.remainingInvocations === "number"
