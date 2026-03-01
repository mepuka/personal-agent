import { describe, expect, it } from "@effect/vitest"
import type { AgentId, ScheduledExecutionId, ScheduleId } from "@template/domain/ids"
import type { GovernancePort, Instant, PolicyDecision, PolicyInput } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { GovernancePortTag } from "../src/PortTags.js"
import { SchedulerActionExecutor } from "../src/scheduler/SchedulerActionExecutor.js"
import type { ExecutionTicket } from "../src/SchedulerRuntime.js"
import { CommandRuntime } from "../src/tools/command/CommandRuntime.js"
import type {
  CommandExecutionError
} from "../src/tools/command/CommandErrors.js"
import type {
  CommandInvocationContext,
  CommandRequest,
  CommandResult
} from "../src/tools/command/CommandTypes.js"

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

  it.effect("governance require approval returns ExecutionSkipped", () =>
    Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({ actionRef: "action:log" })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionSkipped")
    }).pipe(Effect.provide(makeTestLayer({
      decision: "RequireApproval",
      reason: "policy_requires_approval"
    }))))

  it.effect("command action succeeds when command runtime exits with code 0", () =>
    Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({
        actionRef: toCommandActionRef("echo scheduled-command")
      })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionSucceeded")
    }).pipe(Effect.provide(makeTestLayer({ decision: "Allow" }))))

  it.effect("command action forwards schedule context to command runtime", () => {
    const captured: Array<{
      readonly context: CommandInvocationContext
      readonly request: CommandRequest
    }> = []

    return Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({
        ownerAgentId: "agent:schedule-owner" as AgentId,
        actionRef: toCommandActionRef("echo context")
      })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionSucceeded")
      expect(captured).toHaveLength(1)
      expect(captured[0].context.source).toBe("schedule")
      expect(captured[0].context.agentId).toBe("agent:schedule-owner")
      expect(captured[0].request.command).toBe("echo context")
    }).pipe(
      Effect.provide(makeTestLayer(
        { decision: "Allow" },
        {
          executeCommand: ({ context, request }) =>
            Effect.sync(() => {
              captured.push({ context, request })
              return makeCommandResult()
            })
        }
      ))
    )
  })

  it.effect("command action fails when command runtime exits non-zero", () =>
    Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({
        actionRef: toCommandActionRef("echo failing-command")
      })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionFailed")
    }).pipe(Effect.provide(makeTestLayer(
      { decision: "Allow" },
      {
        executeCommand: () => Effect.succeed(makeCommandResult(2))
      }
    ))))

  it.effect("unknown actionRef returns ExecutionSkipped", () =>
    Effect.gen(function*() {
      const executor = yield* SchedulerActionExecutor
      const ticket = makeTicket({ actionRef: "action:unknown-future-action" })

      const outcome = yield* executor.execute(ticket)

      expect(outcome).toBe("ExecutionSkipped")
    }).pipe(Effect.provide(makeTestLayer({ decision: "Allow" }))))

  it.effect("passes ownerAgentId and ExecuteSchedule action to governance", () => {
    const captured: Array<PolicyInput> = []
    const capturingGovernanceLayer = Layer.succeed(GovernancePortTag, {
      evaluatePolicy: (input) => {
        captured.push(input)
        return Effect.succeed<PolicyDecision>({
          decision: "Allow",
          policyId: null,
          toolDefinitionId: null,
          reason: "test_capture"
        })
      },
      checkToolQuota: () => Effect.void,
      writeAudit: () => Effect.void,
      recordToolInvocation: () => Effect.void,
      recordToolInvocationWithAudit: () => Effect.void,
      findToolInvocationByIdempotencyKey: () => Effect.succeed(null),
      listToolInvocationsBySession: () => Effect.succeed({ items: [], totalCount: 0 }),
      listPoliciesForAgent: () => Effect.succeed([]),
      listAuditEntries: () => Effect.succeed([]),
      enforceSandbox: (_agentId, effect) => effect
    } as GovernancePort)

    const commandRuntimeLayer = Layer.succeed(CommandRuntime, {
      execute: () => Effect.succeed(makeCommandResult())
    })

    const layer = SchedulerActionExecutor.layer.pipe(
      Layer.provide(capturingGovernanceLayer),
      Layer.provide(commandRuntimeLayer)
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

const makeTestLayer = (
  policyOverrides: Partial<PolicyDecision>,
  options: {
    readonly executeCommand?: (params: {
      readonly context: CommandInvocationContext
      readonly request: CommandRequest
    }) => Effect.Effect<CommandResult, CommandExecutionError>
  } = {}
) => {
  const governanceLayer = Layer.succeed(GovernancePortTag, {
    evaluatePolicy: (_input) =>
      Effect.succeed<PolicyDecision>({
        decision: "Allow",
        policyId: null,
        toolDefinitionId: null,
        reason: "test_default_allow",
        ...policyOverrides
      }),
    checkToolQuota: () => Effect.void,
    writeAudit: () => Effect.void,
    recordToolInvocation: () => Effect.void,
    recordToolInvocationWithAudit: () => Effect.void,
    findToolInvocationByIdempotencyKey: () => Effect.succeed(null),
    listToolInvocationsBySession: () => Effect.succeed({ items: [], totalCount: 0 }),
    listPoliciesForAgent: () => Effect.succeed([]),
    listAuditEntries: () => Effect.succeed([]),
    enforceSandbox: (_agentId, effect) => effect
  } as GovernancePort)

  const commandRuntimeLayer = Layer.succeed(CommandRuntime, {
    execute: options.executeCommand ?? (() => Effect.succeed(makeCommandResult()))
  })

  return SchedulerActionExecutor.layer.pipe(
    Layer.provide(governanceLayer),
    Layer.provide(commandRuntimeLayer)
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const makeCommandResult = (exitCode = 0): CommandResult => ({
  exitCode,
  stdout: "",
  stderr: "",
  truncatedStdout: false,
  truncatedStderr: false,
  startedAt: instant("2026-02-24T12:00:00.000Z"),
  completedAt: instant("2026-02-24T12:00:00.000Z")
})

const toCommandActionRef = (command: string): string =>
  `action:command:${encodeURIComponent(command)}`

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
