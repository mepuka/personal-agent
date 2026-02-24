import { DateTime, Effect, Layer, Schema, ServiceMap } from "effect"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import type { AgentId, AuditEntryId, SessionId, ToolName, TurnId } from "../../../domain/src/ids.js"
import type { Instant } from "../../../domain/src/ports.js"
import { GovernancePortTag } from "../PortTags.js"

const ToolFailure = Schema.Struct({
  errorCode: Schema.String,
  message: Schema.String
})
type ToolFailure = typeof ToolFailure.Type

const TimeNowTool = Tool.make("time.now", {
  description: "Return the current UTC timestamp as ISO 8601.",
  success: Schema.Struct({
    nowIso: Schema.String
  }),
  failure: ToolFailure,
  failureMode: "return"
})

const MathCalculateTool = Tool.make("math.calculate", {
  description: "Evaluate a basic arithmetic expression.",
  parameters: Schema.Struct({
    expression: Schema.String
  }),
  success: Schema.Struct({
    result: Schema.Number
  }),
  failure: ToolFailure,
  failureMode: "return"
})

const EchoTextTool = Tool.make("echo.text", {
  description: "Return provided text verbatim.",
  parameters: Schema.Struct({
    text: Schema.String
  }),
  success: Schema.Struct({
    text: Schema.String
  }),
  failure: ToolFailure,
  failureMode: "return"
})

const SafeToolkit = Toolkit.make(TimeNowTool, MathCalculateTool, EchoTextTool)

export interface ToolExecutionContext {
  readonly agentId: AgentId
  readonly sessionId: SessionId
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

      const writeAudit = (
        context: ToolExecutionContext,
        decision: "Allow" | "Deny" | "RequireApproval",
        reason: string
      ) =>
        governance.writeAudit({
          auditEntryId: (`audit:${context.turnId}:${crypto.randomUUID()}`) as AuditEntryId,
          agentId: context.agentId,
          sessionId: context.sessionId,
          decision,
          reason,
          createdAt: context.now
        })

      const failWithAudit = (
        context: ToolExecutionContext,
        decision: "Deny" | "RequireApproval",
        reason: string,
        failure: ToolFailure
      ): Effect.Effect<never, ToolFailure> =>
        writeAudit(context, decision, reason).pipe(
          Effect.andThen(Effect.fail(failure))
        )

      const runGovernedTool = <A>(
        context: ToolExecutionContext,
        toolName: ToolName,
        execute: Effect.Effect<A, ToolFailure>
      ): Effect.Effect<A, ToolFailure> =>
        Effect.gen(function*() {
          const policy = yield* governance.evaluatePolicy({
            agentId: context.agentId,
            sessionId: context.sessionId,
            action: "InvokeTool",
            toolName
          })

          if (policy.decision === "Deny") {
            return yield* failWithAudit(
              context,
              "Deny",
              `tool_policy_denied:${toolName}`,
              {
                errorCode: "PolicyDenied",
                message: policy.reason
              }
            )
          }

          if (policy.decision === "RequireApproval") {
            return yield* failWithAudit(
              context,
              "RequireApproval",
              `tool_requires_approval:${toolName}`,
              {
                errorCode: "RequiresApproval",
                message: policy.reason
              }
            )
          }

          yield* governance.checkToolQuota(
            context.agentId,
            toolName,
            context.now
          ).pipe(
            Effect.catchTag("ToolQuotaExceeded", (error) =>
              failWithAudit(
                context,
                "Deny",
                `tool_quota_exceeded:${toolName}`,
                {
                  errorCode: "ToolQuotaExceeded",
                  message: `remaining_invocations=${error.remainingInvocations}`
                }
              ))
          )

          return yield* execute.pipe(
            Effect.tap(() => writeAudit(context, "Allow", `tool_invoked:${toolName}`)),
            Effect.catch((failure) =>
              writeAudit(
                context,
                "Deny",
                `tool_execution_failed:${toolName}:${failure.errorCode}`
              ).pipe(
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
              "time.now": () =>
                runGovernedTool(
                  context,
                  "time.now" as ToolName,
                  Effect.succeed({
                    nowIso: DateTime.formatIso(context.now)
                  })
                ),
              "math.calculate": ({ expression }) => {
                const result = safeCalculate(expression)
                return runGovernedTool(
                  context,
                  "math.calculate" as ToolName,
                  result === null
                    ? Effect.fail<ToolFailure>({
                      errorCode: "InvalidExpression",
                      message: "Expression must contain only numbers and arithmetic operators."
                    })
                    : Effect.succeed({ result })
                )
              },
              "echo.text": ({ text }) =>
                runGovernedTool(
                  context,
                  "echo.text" as ToolName,
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
