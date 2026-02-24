import { ToolQuotaExceeded } from "@template/domain/errors"
import type { AgentId, ToolName } from "@template/domain/ids"
import type { AuditEntryRecord, GovernancePort, Instant, PolicyDecision } from "@template/domain/ports"
import { DateTime, Effect, HashMap, Layer, Option, Ref, ServiceMap } from "effect"

interface ToolQuotaState {
  readonly maxPerDay: number
  readonly usedToday: number
  readonly resetAt: Instant
}

export class GovernancePortMemory extends ServiceMap.Service<GovernancePortMemory>()("server/GovernancePortMemory", {
  make: Effect.gen(function*() {
    const auditEntries = yield* Ref.make(Array<AuditEntryRecord>())
    const toolQuotaState = yield* Ref.make(HashMap.empty<string, ToolQuotaState>())

    const evaluatePolicy: GovernancePort["evaluatePolicy"] = (_input) =>
      Effect.succeed<PolicyDecision>({
        decision: "Allow",
        policyId: null,
        reason: "mvp_default_allow"
      })

    const checkToolQuota: GovernancePort["checkToolQuota"] = (agentId, toolName, now) =>
      Ref.get(toolQuotaState).pipe(
        Effect.flatMap((map) => {
          const key = quotaKey(agentId, toolName)
          const current = HashMap.get(map, key)
          if (Option.isNone(current)) {
            return Effect.void
          }

          const normalized = DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(current.value.resetAt)
            ? { ...current.value, usedToday: 0, resetAt: endOfUtcDay(now) }
            : current.value

          if (normalized.usedToday >= normalized.maxPerDay) {
            return Effect.fail(
              new ToolQuotaExceeded({
                agentId,
                toolName,
                remainingInvocations: 0
              })
            )
          }

          return Ref.set(
            toolQuotaState,
            HashMap.set(map, key, {
              ...normalized,
              usedToday: normalized.usedToday + 1
            })
          )
        })
      )

    const writeAudit: GovernancePort["writeAudit"] = (entry) =>
      Ref.update(auditEntries, (entries) => [...entries, entry])

    const enforceSandbox: GovernancePort["enforceSandbox"] = (_agentId, effect) => effect

    return {
      evaluatePolicy,
      checkToolQuota,
      writeAudit,
      enforceSandbox
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}

const quotaKey = (agentId: AgentId, toolName: ToolName): string => `${agentId}:${toolName}`

const endOfUtcDay = (from: Instant): Instant => DateTime.add(DateTime.removeTime(from), { days: 1 })
