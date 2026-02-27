import type { MemoryLimits } from "@template/domain/config"
import { ToolName } from "@template/domain/ids"
import type {
  AgentId,
  AuditEntryId,
  AuditLogId,
  ConversationId,
  PolicyId,
  SessionId,
  ToolDefinitionId,
  ToolInvocationId,
  TurnId
} from "@template/domain/ids"
import { toMemoryItemIds } from "@template/domain/memory"
import type { Instant } from "@template/domain/ports"
import type { AuthorizationDecision, ComplianceStatus } from "@template/domain/status"
import { DateTime, Effect, Layer, Match, Schema, ServiceMap } from "effect"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import { AgentConfig } from "./AgentConfig.js"
import { GovernancePortTag, MemoryPortTag } from "../PortTags.js"

const POLICY_SYSTEM_ERROR = "policy:invoke_tool:system_error:v1" as PolicyId
const DEFAULT_AUDIT_LOG_ID = "auditlog:governance:default:v1" as AuditLogId

const TOOL_NAMES = {
  time_now: ToolName.makeUnsafe("time_now"),
  math_calculate: ToolName.makeUnsafe("math_calculate"),
  echo_text: ToolName.makeUnsafe("echo_text"),
  store_memory: ToolName.makeUnsafe("store_memory"),
  retrieve_memories: ToolName.makeUnsafe("retrieve_memories"),
  forget_memories: ToolName.makeUnsafe("forget_memories")
} as const

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

const StoreMemoryTool = Tool.make("store_memory", {
  description: "Store a semantic memory item for this agent.",
  parameters: Schema.Struct({
    content: Schema.String,
    tags: Schema.optional(Schema.Array(Schema.String)),
    scope: Schema.optional(Schema.Literals(["SessionScope", "GlobalScope"]))
  }),
  success: Schema.Struct({
    memoryId: Schema.String,
    stored: Schema.Boolean
  }),
  failure: ToolFailure
})

const RetrieveMemoriesTool = Tool.make("retrieve_memories", {
  description: "Retrieve relevant memories for a natural language query.",
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number)
  }),
  success: Schema.Struct({
    memories: Schema.Array(Schema.Struct({
      memoryId: Schema.String,
      content: Schema.String,
      metadataJson: Schema.Union([Schema.String, Schema.Null]),
      createdAt: Schema.String
    }))
  }),
  failure: ToolFailure
})

const ForgetMemoriesTool = Tool.make("forget_memories", {
  description: "Delete memories by item ID.",
  parameters: Schema.Struct({
    memoryIds: Schema.Array(Schema.String)
  }),
  success: Schema.Struct({
    forgotten: Schema.Number
  }),
  failure: ToolFailure
})

const SafeToolkit = Toolkit.make(
  TimeNowTool,
  MathCalculateTool,
  EchoTextTool,
  StoreMemoryTool,
  RetrieveMemoriesTool,
  ForgetMemoriesTool
)

/**
 * The handler layer produced by SafeToolkit.toLayer, with `any` context
 * stripped to `never`. Toolkit.toLayer leaks `any` context in Effect v4 beta.
 */
type SafeToolkitHandlerLayer =
  ReturnType<typeof SafeToolkit.toLayer> extends Layer.Layer<infer A, infer E, any>
    ? Layer.Layer<A, E>
    : never

export interface ToolExecutionContext {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly turnId: TurnId
  readonly now: Instant
  readonly iteration?: number
}

export interface ToolRegistryService {
  readonly makeToolkit: (context: ToolExecutionContext) => Effect.Effect<{
    readonly toolkit: typeof SafeToolkit
    readonly handlerLayer: SafeToolkitHandlerLayer
  }>
}

export class ToolRegistry extends ServiceMap.Service<ToolRegistry>()(
  "server/ai/ToolRegistry",
  {
    make: Effect.gen(function*() {
      const governance = yield* GovernancePortTag
      const memoryPort = yield* MemoryPortTag
      const agentConfig = yield* AgentConfig

      const persistInvocation = (params: {
        readonly context: ToolExecutionContext
        readonly toolName: ToolName
        readonly idempotencyKey: string
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
              idempotencyKey: params.idempotencyKey,
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

      const replayStoredInvocation = <A>(
        outputJson: string
      ): Effect.Effect<A, ToolFailure> =>
        Effect.suspend(() => {
          const parsed = safeJsonParse(outputJson)
          if (isToolFailure(parsed)) {
            return Effect.fail(parsed)
          }
          if (parsed === null || parsed === undefined) {
            return Effect.fail<ToolFailure>({
              errorCode: "ReplayDecodeFailed",
              message: "stored invocation output was null or undefined"
            })
          }
          return Effect.succeed(parsed as A)
        })

      const failWithRecordedInvocation = (params: {
        readonly context: ToolExecutionContext
        readonly toolName: ToolName
        readonly idempotencyKey: string
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
          idempotencyKey: params.idempotencyKey,
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

      const runMemoryPolicy = <A>(params: {
        readonly context: ToolExecutionContext
        readonly toolName: ToolName
        readonly action: "ReadMemory" | "WriteMemory"
        readonly operation: "store" | "retrieve" | "forget"
        readonly allowReason: string
        readonly denyReason: string
        readonly auditBeforeExecute: boolean
        readonly execute: Effect.Effect<A, ToolFailure>
      }): Effect.Effect<A, ToolFailure> =>
        Effect.gen(function*() {
          const policy = yield* governance.evaluatePolicy({
            agentId: params.context.agentId,
            sessionId: params.context.sessionId,
            action: params.action
          }).pipe(
            Effect.catchCause(() =>
              Effect.fail<ToolFailure>({
                errorCode: "MemoryPolicyError",
                message: "memory policy evaluation failed"
              })
            )
          )

          const auditEntryId = (`audit:memory:${params.operation}:${params.context.turnId}:${params.toolName}:${
            params.context.iteration ?? 0
          }`) as AuditEntryId

          yield* Match.value(policy.decision).pipe(
            Match.when("Allow", () => Effect.void),
            Match.orElse(() =>
              governance.writeAudit({
                auditEntryId,
                agentId: params.context.agentId,
                sessionId: params.context.sessionId,
                decision: policy.decision,
                reason: `${params.denyReason}:${policy.reason}`,
                createdAt: params.context.now
              }).pipe(
                Effect.andThen(
                  Effect.fail<ToolFailure>({
                    errorCode: "MemoryAccessDenied",
                    message: policy.reason
                  })
                )
              )
            )
          )

          const writeAllowAudit = governance.writeAudit({
            auditEntryId,
            agentId: params.context.agentId,
            sessionId: params.context.sessionId,
            decision: "Allow",
            reason: params.allowReason,
            createdAt: params.context.now
          })

          if (params.auditBeforeExecute) {
            yield* writeAllowAudit
            return yield* params.execute
          }

          const result = yield* params.execute
          yield* writeAllowAudit
          return result
        })

      const runGovernedTool = <A>(
        context: ToolExecutionContext,
        toolName: ToolName,
        input: Record<string, unknown>,
        execute: Effect.Effect<A, ToolFailure>
      ): Effect.Effect<A, ToolFailure> =>
        Effect.gen(function*() {
          const inputJson = canonicalJsonStringify(input)
          const idempotencyKey = yield* makeIdempotencyKey(
            context.turnId,
            context.iteration ?? 0,
            toolName,
            inputJson
          )

          const existing = yield* governance.findToolInvocationByIdempotencyKey(idempotencyKey)
          if (existing !== null) {
            return yield* replayStoredInvocation(existing.outputJson)
          }

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
                idempotencyKey,
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

          yield* Match.value(policy.decision).pipe(
            Match.when("Deny", () =>
              failWithRecordedInvocation({
                context,
                toolName,
                idempotencyKey,
                inputJson,
                decision: "Deny",
                policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
                toolDefinitionId: policy.toolDefinitionId,
                reason: `tool_policy_denied:${toolName}`,
                failure: { errorCode: "PolicyDenied", message: policy.reason }
              })
            ),
            Match.when("RequireApproval", () =>
              failWithRecordedInvocation({
                context,
                toolName,
                idempotencyKey,
                inputJson,
                decision: "RequireApproval",
                policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
                toolDefinitionId: policy.toolDefinitionId,
                reason: `tool_requires_approval:${toolName}`,
                failure: { errorCode: "RequiresApproval", message: policy.reason }
              })
            ),
            Match.when("Allow", () => Effect.void),
            Match.exhaustive
          )

          yield* governance.checkToolQuota(context.agentId, toolName, context.now).pipe(
            Effect.catchTag("ToolQuotaExceeded", (error) =>
              failWithRecordedInvocation({
                context,
                toolName,
                idempotencyKey,
                inputJson,
                decision: "Deny",
                policyId: policy.policyId ?? POLICY_SYSTEM_ERROR,
                toolDefinitionId: policy.toolDefinitionId,
                reason: `tool_quota_exceeded:${toolName}`,
                failure: {
                  errorCode: "ToolQuotaExceeded",
                  message: `remaining_invocations=${error.remainingInvocations}`
                }
              })
            ),
            Effect.catchDefect(() =>
              failWithRecordedInvocation({
                context,
                toolName,
                idempotencyKey,
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
            )
          )

          return yield* execute.pipe(
            Effect.tap((result) =>
              persistInvocation({
                context,
                toolName,
                idempotencyKey,
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
                idempotencyKey,
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
        Effect.gen(function*() {
          const profile = yield* agentConfig.getAgent(context.agentId as string).pipe(Effect.orDie)
          const memoryLimits = profile.runtime.memory

          return {
            toolkit: SafeToolkit,
            handlerLayer: SafeToolkit.toLayer(
              SafeToolkit.of({
              "time_now": () =>
                runGovernedTool(
                  context,
                  TOOL_NAMES.time_now,
                  {},
                  Effect.succeed({
                    nowIso: DateTime.formatIso(context.now)
                  })
                ),
              "math_calculate": ({ expression }) => {
                const result = safeCalculate(expression)
                return runGovernedTool(
                  context,
                  TOOL_NAMES.math_calculate,
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
                  TOOL_NAMES.echo_text,
                  { text },
                  Effect.succeed({ text })
                ),
              "store_memory": ({ content, tags, scope }) =>
                runGovernedTool(
                  context,
                  TOOL_NAMES.store_memory,
                  { content, tags, scope },
                  runMemoryPolicy({
                    context,
                    toolName: TOOL_NAMES.store_memory,
                    action: "WriteMemory",
                    operation: "store",
                    allowReason: "memory_store_allowed",
                    denyReason: "memory_store_denied",
                    auditBeforeExecute: true,
                    execute: Effect.gen(function*() {
                      const metadataJson = Array.isArray(tags) && tags.length > 0
                        ? safeJsonStringify({ tags: tags.filter((tag) => tag.trim().length > 0) })
                        : null
                      const [memoryId] = yield* memoryPort.encode(
                        context.agentId,
                        [{
                          tier: "SemanticMemory",
                          scope: scope ?? "GlobalScope",
                          source: "AgentSource",
                          content,
                          metadataJson
                        }],
                        context.now
                      )

                      if (memoryId === undefined) {
                        return yield* Effect.fail<ToolFailure>({
                          errorCode: "MemoryStoreFailed",
                          message: "memory store did not return an item id"
                        })
                      }

                      return {
                        memoryId,
                        stored: true
                      } as const
                    })
                  })
                ),
              "retrieve_memories": ({ query, limit }) =>
                runGovernedTool(
                  context,
                  TOOL_NAMES.retrieve_memories,
                  { query, limit },
                  runMemoryPolicy({
                    context,
                    toolName: TOOL_NAMES.retrieve_memories,
                    action: "ReadMemory",
                    operation: "retrieve",
                    allowReason: "memory_retrieve_allowed",
                    denyReason: "memory_retrieve_denied",
                    auditBeforeExecute: false,
                    execute: memoryPort.search(context.agentId, {
                      query,
                      limit: clampMemoryLimit(limit, memoryLimits),
                      sort: "CreatedDesc"
                    }).pipe(
                      Effect.map((result) => ({
                        memories: result.items.map((item) => ({
                          memoryId: item.memoryItemId,
                          content: item.content,
                          metadataJson: item.metadataJson,
                          createdAt: DateTime.formatIso(item.createdAt)
                        }))
                      }))
                    )
                  })
                ),
              "forget_memories": ({ memoryIds }) =>
                runGovernedTool(
                  context,
                  TOOL_NAMES.forget_memories,
                  { memoryIds },
                  runMemoryPolicy({
                    context,
                    toolName: TOOL_NAMES.forget_memories,
                    action: "WriteMemory",
                    operation: "forget",
                    allowReason: "memory_forget_allowed",
                    denyReason: "memory_forget_denied",
                    auditBeforeExecute: true,
                    execute: Effect.gen(function*() {
                      const validIds = toMemoryItemIds(memoryIds)

                      if (validIds.length === 0) {
                        return yield* Effect.fail<ToolFailure>({
                          errorCode: "InvalidMemoryIds",
                          message: "memoryIds must contain at least one non-empty id"
                        })
                      }

                      const forgotten = yield* memoryPort.forget(context.agentId, {
                        itemIds: validIds
                      })
                      return { forgotten } as const
                    })
                  })
                )
            })
          ) as SafeToolkitHandlerLayer
          }
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

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const canonicalJsonStringify = (value: unknown): string => {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(canonicalize)
    }
    if (input !== null && typeof input === "object") {
      const objectInput = input as Record<string, unknown>
      return Object.keys(objectInput)
        .sort((a, b) => a.localeCompare(b))
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = canonicalize(objectInput[key])
          return acc
        }, {})
    }
    return input
  }

  return safeJsonStringify(canonicalize(value))
}

const makeIdempotencyKey = (
  turnId: TurnId,
  iteration: number,
  toolName: ToolName,
  canonicalInputJson: string
): Effect.Effect<string> =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${turnId}:${iteration}:${toolName}:${canonicalInputJson}`)
    )
  ).pipe(
    Effect.map((buffer) => {
      const hex = Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("")
      return `tool-idem:${hex}`
    })
  )

const clampMemoryLimit = (
  limit: number | undefined,
  memoryLimits: MemoryLimits
): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return memoryLimits.defaultRetrieveLimit
  }
  return Math.min(Math.max(Math.floor(limit), 1), memoryLimits.maxRetrieveLimit)
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


const isToolFailure = Schema.is(ToolFailure)
