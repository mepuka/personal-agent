import { describe, expect, it } from "@effect/vitest"
import type { AgentId, ScheduledExecutionId, ScheduleId } from "@template/domain/ids"
import type { GovernancePort, Instant, PolicyDecision, PolicyInput } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { GovernancePortTag } from "../src/PortTags.js"
import { SchedulerActionExecutor } from "../src/scheduler/SchedulerActionExecutor.js"
import type { ExecutionTicket } from "../src/SchedulerRuntime.js"

describe("SchedulerActionExecutor", () => {
  it.effect("action:log returns ExecutionSucceeded when governance allows", () =>
    Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({ actionRef: "action:log" })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionSucceeded")
    }).pipe(Effect.provide(makeTestLayer({ decision: "Allow" }))))

  it.effect("action:health_check returns ExecutionSucceeded when governance allows", () =>
    Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({ actionRef: "action:health_check" })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionSucceeded")
    }).pipe(Effect.provide(makeTestLayer({ decision: "Allow" }))))

  it.effect("governance deny returns ExecutionSkipped", () =>
    Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({ actionRef: "action:log" })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionSkipped")
    }).pipe(Effect.provide(makeTestLayer({ decision: "Deny", reason: "policy_test_deny" }))))

  it.effect("unknown actionRef returns ExecutionSucceeded (no-op forward compat)", () =>
    Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({ actionRef: "action:unknown-future-action" })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionSucceeded")
    }).pipe(Effect.provide(makeTestLayer({ decision: "Allow" }))))

  it.effect("passes ownerAgentId and ExecuteSchedule action to governance", () => {
    const captured: Array<PolicyInput> = []
    const capturingGovernanceLayer = Layer.succeed(GovernancePortTag, {
      evaluatePolicy: (input) => {
        captured.push(input)
        return Effect.succeed<PolicyDecision>({
          decision: "Allow",
          policyId: null,
          reason: "test_capture"
        })
      },
      checkToolQuota: () => Effect.void,
      writeAudit: () => Effect.void,
      enforceSandbox: (_agentId, effect) => effect
    } as GovernancePort)

    const layer = SchedulerActionExecutor.layer.pipe(
      Layer.provide(capturingGovernanceLayer)
    )

    return Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({
        ownerAgentId: "agent:owner-123" as AgentId,
        actionRef: "action:log"
      })

      yield* executor.execute(ticket)

      expect(captured).toHaveLength(1)
      expect(captured[0].agentId).toBe("agent:owner-123")
      expect(captured[0].sessionId).toBeNull()
      expect(captured[0].action).toBe("ExecuteSchedule")
    }).pipe(Effect.provide(layer))
  })
})

const makeTestLayer = (policyOverrides: Partial<PolicyDecision>) => {
  const governanceLayer = Layer.succeed(GovernancePortTag, {
    evaluatePolicy: (_input) =>
      Effect.succeed<PolicyDecision>({
        decision: "Allow",
        policyId: null,
        reason: "test_default_allow",
        ...policyOverrides
      }),
    checkToolQuota: () => Effect.void,
    writeAudit: () => Effect.void,
    enforceSandbox: (_agentId, effect) => effect
  } as GovernancePort)

  return SchedulerActionExecutor.layer.pipe(
    Layer.provide(governanceLayer)
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const makeTicket = (overrides: Partial<ExecutionTicket> = {}): ExecutionTicket => ({
  executionId: crypto.randomUUID() as ScheduledExecutionId,
  scheduleId: "schedule:test" as ScheduleId,
  ownerAgentId: "agent:test" as AgentId,
  dueAt: instant("2026-02-24T12:00:00.000Z"),
  triggerSource: "CronTick",
  startedAt: instant("2026-02-24T12:00:00.000Z"),
  actionRef: "action:default",
  ...overrides
})
