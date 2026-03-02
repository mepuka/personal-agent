import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type {
  AgentState,
  AgentStatePort,
  CheckpointPort,
  GovernancePort,
  Instant,
  MemoryPort,
  SessionState,
  SessionTurnPort
} from "@template/domain/ports"
import type { AuthorizationDecision } from "@template/domain/status"
import { DateTime, Effect, Layer, Stream } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Response from "effect/unstable/ai/Response"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { AgentConfig } from "../src/ai/AgentConfig.js"
import * as ChatPersistence from "../src/ai/ChatPersistence.js"
import { ModelRegistry } from "../src/ai/ModelRegistry.js"
import { ToolRegistry } from "../src/ai/ToolRegistry.js"
import { layer as CliRuntimeLocalLayer } from "../src/tools/cli/CliRuntimeLocal.js"
import { layer as CommandBackendLocalLayer } from "../src/tools/command/CommandBackendLocal.js"
import { CommandRuntime } from "../src/tools/command/CommandRuntime.js"
import { CommandHooksDefaultLayer } from "../src/tools/command/hooks/CommandHooksDefault.js"
import { FileHooksDefaultLayer } from "../src/tools/file/hooks/FileHooksDefault.js"
import { FilePathPolicy } from "../src/tools/file/FilePathPolicy.js"
import { FileReadTracker } from "../src/tools/file/FileReadTracker.js"
import { FileRuntime } from "../src/tools/file/FileRuntime.js"
import { ToolExecution } from "../src/tools/ToolExecution.js"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import { MemoryPortSqlite } from "../src/MemoryPortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { CheckpointPortSqlite } from "../src/CheckpointPortSqlite.js"
import { AgentStatePortTag, CheckpointPortTag, GovernancePortTag, MemoryPortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { SessionTurnPortSqlite } from "../src/SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "../src/turn/TurnProcessingRuntime.js"
import {
  SubroutineControlPlane,
  type SubroutineControlPlaneService,
  type TriggerContext
} from "../src/memory/SubroutineControlPlane.js"
import {
  TranscriptProjector,
  type TranscriptProjectorService
} from "../src/memory/TranscriptProjector.js"
import {
  layer as TurnProcessingWorkflowLayer,
  type ProcessTurnPayload,
  TurnModelFailure,
  TurnPolicyDenied
} from "../src/turn/TurnProcessingWorkflow.js"

describe("TurnProcessingWorkflow e2e", () => {
  it.effect("processes one turn and persists user + assistant turns", () => {
    const dbPath = testDatabasePath("turn-happy")
    const layer = makeTurnProcessingLayer(dbPath)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const governance = yield* GovernancePortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-24T12:00:00.000Z")
      const agent = makeAgentState({
        agentId: "agent:happy" as AgentId,
        tokenBudget: 200,
        tokensConsumed: 0,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      })
      const session = makeSessionState({
        sessionId: "session:happy" as SessionId,
        conversationId: "conversation:happy" as ConversationId,
        tokenCapacity: 500,
        tokensUsed: 0
      })
      const payload = makeTurnPayload({
        turnId: "turn:happy" as TurnId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        createdAt: now,
        inputTokens: 25,
        content: "hello from happy path"
      })

      yield* agentPort.upsert(agent)
      yield* sessionPort.startSession(session)

      const result = yield* runtime.processTurn(payload)
      const persistedSession = yield* sessionPort.getSession(session.sessionId)
      const turns = yield* sessionPort.listTurns(session.sessionId)
      const persistedAgent = yield* agentPort.get(agent.agentId)
      const audits = yield* governance.listAuditEntries()

      expect(result.accepted).toBe(true)
      expect(result.turnId).toBe("turn:happy")
      expect(result.auditReasonCode).toBe("turn_processing_accepted")
      expect(result.assistantContent).toContain("assistant")
      expect(persistedSession?.tokensUsed).toBe(25)
      expect(persistedAgent?.tokensConsumed).toBe(25)
      expect(turns).toHaveLength(2)
      expect(turns[0].participantRole).toBe("UserRole")
      expect(turns[0].message.content).toBe("hello from happy path")
      expect(turns[1].participantRole).toBe("AssistantRole")
      expect(turns[1].message.content).toContain("assistant")
      expect(audits.some((entry) => entry.reason === "turn_processing_accepted")).toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("is idempotent by turnId and does not double-consume budget", () => {
    const dbPath = testDatabasePath("turn-idempotent")
    const layer = makeTurnProcessingLayer(dbPath)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const governance = yield* GovernancePortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-24T12:00:00.000Z")
      const agent = makeAgentState({
        agentId: "agent:idempotent" as AgentId,
        tokenBudget: 200,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      })
      const session = makeSessionState({
        sessionId: "session:idempotent" as SessionId,
        conversationId: "conversation:idempotent" as ConversationId,
        tokenCapacity: 300,
        tokensUsed: 0
      })
      const payload = makeTurnPayload({
        turnId: "turn:idempotent" as TurnId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        createdAt: now,
        inputTokens: 40,
        content: "same turn twice"
      })

      yield* agentPort.upsert(agent)
      yield* sessionPort.startSession(session)

      const first = yield* runtime.processTurn(payload)
      const second = yield* runtime.processTurn(payload)

      const turns = yield* sessionPort.listTurns(session.sessionId)
      const persistedAgent = yield* agentPort.get(agent.agentId)
      const audits = yield* governance.listAuditEntries()

      expect(first.accepted).toBe(true)
      expect(second.accepted).toBe(true)
      expect(turns).toHaveLength(2)
      expect(persistedAgent?.tokensConsumed).toBe(40)
      expect(audits.filter((entry) => entry.reason === "turn_processing_accepted")).toHaveLength(1)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("retains processed turn state across cold restart", () => {
    const dbPath = testDatabasePath("turn-restart")
    const firstLayer = makeTurnProcessingLayer(dbPath)
    const secondLayer = makeTurnProcessingLayer(dbPath)

    return Effect.gen(function*() {
      const now = instant("2026-02-24T12:00:00.000Z")
      const agentId = "agent:restart" as AgentId
      const sessionId = "session:restart" as SessionId
      const conversationId = "conversation:restart" as ConversationId

      yield* Effect.gen(function*() {
        const agentPort = yield* AgentStatePortSqlite
        const sessionPort = yield* SessionTurnPortSqlite
        const runtime = yield* TurnProcessingRuntime

        yield* agentPort.upsert(makeAgentState({
          agentId,
          tokenBudget: 300,
          budgetResetAt: DateTime.add(now, { hours: 1 })
        }))
        yield* sessionPort.startSession(makeSessionState({
          sessionId,
          conversationId,
          tokenCapacity: 400,
          tokensUsed: 0
        }))

        yield* runtime.processTurn(makeTurnPayload({
          turnId: "turn:restart" as TurnId,
          agentId,
          sessionId,
          conversationId,
          createdAt: now,
          inputTokens: 30,
          content: "persist me"
        }))
      }).pipe(Effect.provide(firstLayer))

      const persisted = yield* Effect.gen(function*() {
        const agentPort = yield* AgentStatePortSqlite
        const sessionPort = yield* SessionTurnPortSqlite
        const governance = yield* GovernancePortSqlite

        const agent = yield* agentPort.get(agentId)
        const session = yield* sessionPort.getSession(sessionId)
        const turns = yield* sessionPort.listTurns(sessionId)
        const audits = yield* governance.listAuditEntries()

        return { agent, session, turns, audits } as const
      }).pipe(Effect.provide(secondLayer))

      expect(persisted.agent?.tokensConsumed).toBe(30)
      expect(persisted.session?.tokensUsed).toBe(30)
      expect(persisted.turns).toHaveLength(2)
      expect(persisted.turns[0].message.content).toBe("persist me")
      expect(persisted.turns[1].message.content).toContain("assistant")
      expect(persisted.audits.some((entry) => entry.reason === "turn_processing_accepted")).toBe(true)
    }).pipe(
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("records deny audit and does not persist turn when policy denies", () => {
    const dbPath = testDatabasePath("turn-deny")
    const layer = makeTurnProcessingLayer(dbPath, "Deny")

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const governance = yield* GovernancePortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-24T12:00:00.000Z")
      const agent = makeAgentState({
        agentId: "agent:deny" as AgentId,
        tokenBudget: 200,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      })
      const session = makeSessionState({
        sessionId: "session:deny" as SessionId,
        conversationId: "conversation:deny" as ConversationId,
        tokenCapacity: 200,
        tokensUsed: 0
      })

      yield* agentPort.upsert(agent)
      yield* sessionPort.startSession(session)

      const denied = (yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:deny" as TurnId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        createdAt: now,
        inputTokens: 20,
        content: "should be denied"
      })).pipe(
        Effect.flip
      )) as TurnPolicyDenied

      const persistedSession = yield* sessionPort.getSession(session.sessionId)
      const turns = yield* sessionPort.listTurns(session.sessionId)
      const persistedAgent = yield* agentPort.get(agent.agentId)
      const audits = yield* governance.listAuditEntries()

      expect(denied).toBeInstanceOf(TurnPolicyDenied)
      expect(denied._tag).toBe("TurnPolicyDenied")
      expect(persistedSession?.tokensUsed).toBe(0)
      expect(persistedAgent?.tokensConsumed).toBe(0)
      expect(turns).toHaveLength(0)
      expect(audits.some((entry) => entry.reason === "turn_processing_policy_denied" && entry.decision === "Deny"))
        .toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("classifies provider credit exhaustion with a specific reason and audit", () => {
    const dbPath = testDatabasePath("turn-credit-exhausted")
    const layer = makeTurnProcessingLayer(
      dbPath,
      "Allow",
      undefined,
      { failWithErrorMessage: "Your credit balance is too low to access the Anthropic API." }
    )

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const governance = yield* GovernancePortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-24T12:00:00.000Z")
      const agent = makeAgentState({
        agentId: "agent:credit" as AgentId,
        tokenBudget: 200,
        tokensConsumed: 0,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      })
      const session = makeSessionState({
        sessionId: "session:credit" as SessionId,
        conversationId: "conversation:credit" as ConversationId,
        tokenCapacity: 200,
        tokensUsed: 0
      })

      yield* agentPort.upsert(agent)
      yield* sessionPort.startSession(session)

      const failed = (yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:credit" as TurnId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        createdAt: now,
        inputTokens: 20,
        content: "hello"
      })).pipe(
        Effect.flip
      )) as TurnModelFailure

      const audits = yield* governance.listAuditEntries()

      expect(failed).toBeInstanceOf(TurnModelFailure)
      expect(failed._tag).toBe("TurnModelFailure")
      expect(failed.reason).toContain("provider_credit_exhausted:")
      expect(failed.reason).toContain("credit balance is too low")
      expect(
        audits.some(
          (entry) =>
            entry.reason === "turn_processing_provider_credit_exhausted" && entry.decision === "Deny"
        )
      ).toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("tool loop recurses on tool-calls finish reason", () => {
    const dbPath = testDatabasePath("turn-tool-loop")
    const layer = makeTurnProcessingLayer(dbPath, "Allow", undefined, {
      finishReasons: ["tool-calls", "stop"]
    })

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime
      const now = instant("2026-02-24T12:00:00.000Z")

      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:loop" as AgentId,
        tokenBudget: 500,
        maxToolIterations: 10,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:loop" as SessionId,
        conversationId: "conversation:loop" as ConversationId,
        tokenCapacity: 1000,
        tokensUsed: 0
      }))

      const result = yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:loop" as TurnId,
        sessionId: "session:loop" as SessionId,
        conversationId: "conversation:loop" as ConversationId,
        agentId: "agent:loop" as AgentId,
        createdAt: now,
        inputTokens: 25,
        content: "use tools"
      }))

      expect(result.accepted).toBe(true)
      expect(result.iterationsUsed).toBe(2)
      expect(result.iterationStats).toHaveLength(2)
      expect(result.iterationStats[0].finishReason).toBe("tool-calls")
      expect(result.iterationStats[1].finishReason).toBe("stop")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("tool loop caps at maxToolIterations", () => {
    const dbPath = testDatabasePath("turn-loop-cap")
    const layer = makeTurnProcessingLayer(dbPath, "Allow", undefined, {
      finishReasons: ["tool-calls", "tool-calls", "tool-calls", "tool-calls", "tool-calls"]
    })

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime
      const now = instant("2026-02-24T12:00:00.000Z")

      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:loop-cap" as AgentId,
        tokenBudget: 500,
        maxToolIterations: 2,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:loop-cap" as SessionId,
        conversationId: "conversation:loop-cap" as ConversationId,
        tokenCapacity: 1000,
        tokensUsed: 0
      }))

      const result = yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:loop-cap" as TurnId,
        sessionId: "session:loop-cap" as SessionId,
        conversationId: "conversation:loop-cap" as ConversationId,
        agentId: "agent:loop-cap" as AgentId,
        createdAt: now,
        inputTokens: 25,
        content: "keep calling tools"
      }))

      expect(result.accepted).toBe(true)
      expect(result.iterationsUsed).toBe(2)
      expect(result.assistantContent).toContain("Stopped after reaching max tool iterations")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("exposes canonical stream events", () => {
    const dbPath = testDatabasePath("turn-stream")
    const layer = makeTurnProcessingLayer(dbPath)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime
      const now = instant("2026-02-24T12:00:00.000Z")

      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:stream" as AgentId,
        tokenBudget: 200,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:stream" as SessionId,
        conversationId: "conversation:stream" as ConversationId,
        tokenCapacity: 300,
        tokensUsed: 0
      }))

      const events = yield* runtime.processTurnStream(makeTurnPayload({
        turnId: "turn:stream" as TurnId,
        sessionId: "session:stream" as SessionId,
        conversationId: "conversation:stream" as ConversationId,
        agentId: "agent:stream" as AgentId,
        createdAt: now,
        inputTokens: 10,
        content: "stream me"
      })).pipe(Stream.runCollect)

      expect(events[0]?.type).toBe("turn.started")
      expect(events.some((event) => event.type === "assistant.delta")).toBe(true)
      expect(events.some((event) => event.type === "turn.completed")).toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("accepted turn calls dispatchByTrigger with PostTurn and correct IDs", () => {
    const dbPath = testDatabasePath("turn-postturn-dispatch")
    const dispatches: Array<{ triggerType: string; context: TriggerContext }> = []
    const layer = makeTurnProcessingLayer(dbPath, "Allow", undefined, undefined, dispatches)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-24T12:00:00.000Z")
      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:dispatch" as AgentId,
        tokenBudget: 200,
        tokensConsumed: 0,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:dispatch" as SessionId,
        conversationId: "conversation:dispatch" as ConversationId,
        tokenCapacity: 500,
        tokensUsed: 0
      }))

      const result = yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:dispatch" as TurnId,
        agentId: "agent:dispatch" as AgentId,
        sessionId: "session:dispatch" as SessionId,
        conversationId: "conversation:dispatch" as ConversationId,
        createdAt: now,
        inputTokens: 25,
        content: "trigger post-turn"
      }))

      expect(result.accepted).toBe(true)
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0].triggerType).toBe("PostTurn")
      expect(dispatches[0].context.agentId).toBe("agent:dispatch")
      expect(dispatches[0].context.sessionId).toBe("session:dispatch")
      expect(dispatches[0].context.conversationId).toBe("conversation:dispatch")
      expect(dispatches[0].context.turnId).toBe("turn:dispatch")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("denied turn does NOT call dispatchByTrigger", () => {
    const dbPath = testDatabasePath("turn-postturn-deny")
    const dispatches: Array<{ triggerType: string; context: TriggerContext }> = []
    const layer = makeTurnProcessingLayer(dbPath, "Deny", undefined, undefined, dispatches)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-24T12:00:00.000Z")
      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:deny-dispatch" as AgentId,
        tokenBudget: 200,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:deny-dispatch" as SessionId,
        conversationId: "conversation:deny-dispatch" as ConversationId,
        tokenCapacity: 200,
        tokensUsed: 0
      }))

      yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:deny-dispatch" as TurnId,
        agentId: "agent:deny-dispatch" as AgentId,
        sessionId: "session:deny-dispatch" as SessionId,
        conversationId: "conversation:deny-dispatch" as ConversationId,
        createdAt: now,
        inputTokens: 20,
        content: "should not dispatch"
      })).pipe(
        Effect.flip
      )

      expect(dispatches).toHaveLength(0)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("emits checkpoint_required and completed(false) when approval is required", () => {
    const dbPath = testDatabasePath("turn-checkpoint-required")
    const layer = makeTurnProcessingLayer(dbPath, "RequireApproval")

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime
      const now = instant("2026-02-24T12:00:00.000Z")

      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:checkpoint" as AgentId,
        tokenBudget: 200,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:checkpoint" as SessionId,
        conversationId: "conversation:checkpoint" as ConversationId,
        tokenCapacity: 300,
        tokensUsed: 0
      }))

      const events = yield* runtime.processTurnStream(makeTurnPayload({
        turnId: "turn:checkpoint" as TurnId,
        sessionId: "session:checkpoint" as SessionId,
        conversationId: "conversation:checkpoint" as ConversationId,
        agentId: "agent:checkpoint" as AgentId,
        createdAt: now,
        inputTokens: 10,
        content: "read memory please"
      })).pipe(Stream.runCollect)

      expect(events[0]?.type).toBe("turn.started")
      expect(events.some((event) => event.type === "turn.checkpoint_required")).toBe(true)
      const completed = events.find((event) => event.type === "turn.completed")
      expect(completed).toBeDefined()
      expect((completed as any).accepted).toBe(false)
      expect((completed as any).auditReasonCode).toBe("turn_processing_checkpoint_required")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("accepted turn calls appendTurn with correct IDs and turn", () => {
    const dbPath = testDatabasePath("turn-transcript-append")
    const capturedAppends: Array<{ agentId: string; sessionId: string; turn: unknown }> = []
    const layer = makeTurnProcessingLayer(dbPath, "Allow", undefined, undefined, undefined, capturedAppends)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-24T12:00:00.000Z")
      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:transcript" as AgentId,
        tokenBudget: 200,
        tokensConsumed: 0,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:transcript" as SessionId,
        conversationId: "conversation:transcript" as ConversationId,
        tokenCapacity: 500,
        tokensUsed: 0
      }))

      const result = yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:transcript" as TurnId,
        agentId: "agent:transcript" as AgentId,
        sessionId: "session:transcript" as SessionId,
        conversationId: "conversation:transcript" as ConversationId,
        createdAt: now,
        inputTokens: 25,
        content: "trigger transcript"
      }))

      expect(result.accepted).toBe(true)
      expect(capturedAppends).toHaveLength(1)
      expect(capturedAppends[0].agentId).toBe("agent:transcript")
      expect(capturedAppends[0].sessionId).toBe("session:transcript")
      expect(capturedAppends[0].turn).toBeDefined()
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("denied turn does NOT call appendTurn", () => {
    const dbPath = testDatabasePath("turn-transcript-deny")
    const capturedAppends: Array<{ agentId: string; sessionId: string; turn: unknown }> = []
    const layer = makeTurnProcessingLayer(dbPath, "Deny", undefined, undefined, undefined, capturedAppends)

    return Effect.gen(function*() {
      const agentPort = yield* AgentStatePortSqlite
      const sessionPort = yield* SessionTurnPortSqlite
      const runtime = yield* TurnProcessingRuntime

      const now = instant("2026-02-24T12:00:00.000Z")
      yield* agentPort.upsert(makeAgentState({
        agentId: "agent:deny-transcript" as AgentId,
        tokenBudget: 200,
        budgetResetAt: DateTime.add(now, { hours: 1 })
      }))
      yield* sessionPort.startSession(makeSessionState({
        sessionId: "session:deny-transcript" as SessionId,
        conversationId: "conversation:deny-transcript" as ConversationId,
        tokenCapacity: 200,
        tokensUsed: 0
      }))

      yield* runtime.processTurn(makeTurnPayload({
        turnId: "turn:deny-transcript" as TurnId,
        agentId: "agent:deny-transcript" as AgentId,
        sessionId: "session:deny-transcript" as SessionId,
        conversationId: "conversation:deny-transcript" as ConversationId,
        createdAt: now,
        inputTokens: 20,
        content: "should not append transcript"
      })).pipe(
        Effect.flip
      )

      expect(capturedAppends).toHaveLength(0)
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

const makeTurnProcessingLayer = (
  dbPath: string,
  forcedDecision: AuthorizationDecision = "Allow",
  capturedPrompts?: Array<string>,
  mockOptions?: {
    readonly finishReasons?: ReadonlyArray<Response.FinishReason>
    readonly failWithErrorMessage?: string
  },
  capturedDispatches?: Array<{ triggerType: string; context: TriggerContext }>,
  capturedTranscriptAppends?: Array<{ agentId: string; sessionId: string; turn: unknown }>
) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(
    Layer.provide(sqliteLayer),
    Layer.orDie
  )
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

  const agentStateSqliteLayer = AgentStatePortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const sessionTurnSqliteLayer = SessionTurnPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const governanceSqliteLayer = GovernancePortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const memoryPortSqliteLayer = MemoryPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
  const checkpointPortSqliteLayer = CheckpointPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )

  const checkpointPortTagLayer = Layer.effect(
    CheckpointPortTag,
    Effect.gen(function*() {
      return (yield* CheckpointPortSqlite) as CheckpointPort
    })
  ).pipe(Layer.provide(checkpointPortSqliteLayer))

  const memoryPortTagLayer = Layer.effect(
    MemoryPortTag,
    Effect.gen(function*() {
      return (yield* MemoryPortSqlite) as MemoryPort
    })
  ).pipe(Layer.provide(memoryPortSqliteLayer))

  const agentStateTagLayer = Layer.effect(
    AgentStatePortTag,
    Effect.gen(function*() {
      return (yield* AgentStatePortSqlite) as AgentStatePort
    })
  ).pipe(Layer.provide(agentStateSqliteLayer))

  const sessionTurnTagLayer = Layer.effect(
    SessionTurnPortTag,
    Effect.gen(function*() {
      return (yield* SessionTurnPortSqlite) as SessionTurnPort
    })
  ).pipe(Layer.provide(sessionTurnSqliteLayer))

  const governanceTagLayer = Layer.effect(
    GovernancePortTag,
    Effect.gen(function*() {
      const governance = yield* GovernancePortSqlite
      if (forcedDecision === "Allow") {
        return governance as GovernancePort
      }

      return {
        ...governance,
        evaluatePolicy: (_input) =>
          Effect.succeed({
            decision: forcedDecision,
            policyId: null,
            toolDefinitionId: null,
            reason: `forced_${forcedDecision.toLowerCase()}`
          })
      } as GovernancePort
    })
  ).pipe(Layer.provide(governanceSqliteLayer))

  const agentConfigLayer = AgentConfig.layerFromParsed({
    providers: { anthropic: { apiKeyEnv: "PA_ANTHROPIC_API_KEY" } },
    agents: {
      default: {
        persona: { name: "Test", systemPrompt: "Test system prompt." },
        model: { provider: "anthropic", modelId: "test" },
        generation: { temperature: 0.7, maxOutputTokens: 4096 }
      }
    },
    server: { port: 3000 }
  })

  const mockModelRegistryLayer = Layer.effect(
    ModelRegistry,
    Effect.succeed({
      get: (_provider: string, _modelId: string) =>
        Effect.succeed(
          Layer.succeed(LanguageModel.LanguageModel, makeMockLanguageModel(capturedPrompts, mockOptions))
        )
    })
  )

  const chatPersistenceLayer = ChatPersistence.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )

  const commandHooksLayer = CommandHooksDefaultLayer

  const cliRuntimeLayer = CliRuntimeLocalLayer.pipe(
    Layer.provide(NodeServices.layer)
  )

  const commandBackendLayer = CommandBackendLocalLayer.pipe(
    Layer.provide(cliRuntimeLayer)
  )

  const commandRuntimeLayer = CommandRuntime.layer.pipe(
    Layer.provide(commandHooksLayer),
    Layer.provide(commandBackendLayer),
    Layer.provide(NodeServices.layer)
  )

  const fileHooksLayer = FileHooksDefaultLayer

  const filePathPolicyLayer = FilePathPolicy.layer.pipe(
    Layer.provide(NodeServices.layer)
  )

  const fileReadTrackerLayer = FileReadTracker.layer

  const fileRuntimeLayer = FileRuntime.layer.pipe(
    Layer.provide(fileHooksLayer),
    Layer.provide(fileReadTrackerLayer),
    Layer.provide(filePathPolicyLayer),
    Layer.provide(NodeServices.layer)
  )

  const toolExecutionLayer = ToolExecution.layer.pipe(
    Layer.provide(fileRuntimeLayer),
    Layer.provide(filePathPolicyLayer),
    Layer.provide(cliRuntimeLayer),
    Layer.provide(commandRuntimeLayer),
    Layer.provide(sqlInfrastructureLayer),
    Layer.provide(NodeServices.layer)
  )

  const toolRegistryLayer = ToolRegistry.layer.pipe(
    Layer.provide(toolExecutionLayer),
    Layer.provide(governanceTagLayer),
    Layer.provide(memoryPortTagLayer),
    Layer.provide(agentConfigLayer),
    Layer.provide(checkpointPortTagLayer)
  )

  const clusterLayer = SingleRunner.layer().pipe(
    Layer.provide(sqlInfrastructureLayer),
    Layer.orDie
  )

  const workflowEngineLayer = ClusterWorkflowEngine.layer.pipe(
    Layer.provide(clusterLayer)
  )

  const mockControlPlane: SubroutineControlPlaneService = {
    enqueue: () => Effect.succeed({ accepted: false, reason: "deduped", runId: null }),
    dispatchByTrigger: (triggerType, context) => {
      capturedDispatches?.push({ triggerType, context })
      return Effect.succeed([])
    }
  }
  const subroutineControlPlaneLayer = Layer.succeed(
    SubroutineControlPlane,
    mockControlPlane as any
  )

  const mockTranscriptProjector: TranscriptProjectorService = {
    appendTurn: (agentId, sessionId, turn) =>
      Effect.sync(() => {
        capturedTranscriptAppends?.push({ agentId, sessionId, turn })
      }),
    projectSession: () => Effect.void
  }
  const transcriptProjectorLayer = Layer.succeed(
    TranscriptProjector,
    mockTranscriptProjector as any
  )

  const turnWorkflowLayer = TurnProcessingWorkflowLayer.pipe(
    Layer.provide(workflowEngineLayer),
    Layer.provide(agentStateTagLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(governanceTagLayer),
    Layer.provide(toolRegistryLayer),
    Layer.provide(chatPersistenceLayer),
    Layer.provide(agentConfigLayer),
    Layer.provide(mockModelRegistryLayer),
    Layer.provide(checkpointPortTagLayer),
    Layer.provide(subroutineControlPlaneLayer),
    Layer.provide(transcriptProjectorLayer)
  )

  const turnRuntimeLayer = TurnProcessingRuntime.layer.pipe(
    Layer.provide(workflowEngineLayer)
  )

  return turnRuntimeLayer.pipe(
    Layer.provideMerge(turnWorkflowLayer),
    Layer.provideMerge(workflowEngineLayer),
    Layer.provideMerge(Layer.mergeAll(
      toolRegistryLayer,
      mockModelRegistryLayer
    )),
    Layer.provideMerge(Layer.mergeAll(
      chatPersistenceLayer,
      agentConfigLayer
    )),
    Layer.provideMerge(Layer.mergeAll(
      agentStateTagLayer,
      sessionTurnTagLayer,
      governanceTagLayer,
      memoryPortTagLayer
    )),
    Layer.provideMerge(Layer.mergeAll(
      agentStateSqliteLayer,
      sessionTurnSqliteLayer,
      governanceSqliteLayer,
      memoryPortSqliteLayer
    )),
    Layer.provideMerge(clusterLayer),
    Layer.provideMerge(sqlInfrastructureLayer)
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const makeAgentState = (overrides: Partial<AgentState>): AgentState => ({
  agentId: "agent:default" as AgentId,
  permissionMode: "Standard",
  tokenBudget: 100,
  maxToolIterations: 10,
  quotaPeriod: "Daily",
  tokensConsumed: 0,
  budgetResetAt: null,
  ...overrides
})

const makeSessionState = (overrides: Partial<SessionState>): SessionState => ({
  sessionId: "session:default" as SessionId,
  conversationId: "conversation:default" as ConversationId,
  tokenCapacity: 512,
  tokensUsed: 0,
  ...overrides
})

const makeTurnPayload = (overrides: Partial<ProcessTurnPayload>): ProcessTurnPayload => ({
  turnId: overrides.turnId ?? "turn:default",
  sessionId: overrides.sessionId ?? "session:default",
  conversationId: overrides.conversationId ?? "conversation:default",
  agentId: overrides.agentId ?? "agent:default",
  userId: overrides.userId ?? "user:test",
  channelId: overrides.channelId ?? "channel:test",
  content: overrides.content ?? "hello",
  contentBlocks: overrides.contentBlocks ?? [{ contentBlockType: "TextBlock", text: "hello" }],
  createdAt: overrides.createdAt ?? instant("2026-02-24T12:00:00.000Z"),
  inputTokens: overrides.inputTokens ?? 10
})

const makeMockLanguageModel = (
  capturedPrompts?: Array<string>,
  mockOptions?: {
    readonly finishReasons?: ReadonlyArray<Response.FinishReason>
    readonly failWithErrorMessage?: string
  }
): LanguageModel.Service => {
  let callCount = 0

  return {
    generateText: (options: any) => {
      if (capturedPrompts) {
        capturedPrompts.push(JSON.stringify(options))
      }
      if (mockOptions?.failWithErrorMessage) {
        return Effect.fail({
          _tag: "MockModelProviderError",
          message: mockOptions.failWithErrorMessage
        }) as any
      }
      const finishReasons = mockOptions?.finishReasons
      const currentCall = callCount++
      const finishReason = finishReasons
        ? (finishReasons[currentCall] ?? finishReasons[finishReasons.length - 1] ?? "stop")
        : "stop"

      const mockUsage = new Response.Usage({
        inputTokens: {
          uncached: 10,
          total: 10,
          cacheRead: undefined,
          cacheWrite: undefined
        },
        outputTokens: {
          total: 6,
          text: 6,
          reasoning: undefined
        }
      })

      const parts: Array<Response.Part<any>> = [
        Response.makePart("tool-call", {
          id: `call_echo_${currentCall}`,
          name: "echo.text",
          params: { text: "hello" },
          providerExecuted: false
        }),
        Response.makePart("tool-result", {
          id: `call_echo_${currentCall}`,
          name: "echo.text",
          isFailure: false,
          result: { text: "hello" },
          encodedResult: { text: "hello" },
          providerExecuted: false,
          preliminary: false
        })
      ]

      if (finishReason !== "tool-calls") {
        parts.push(Response.makePart("text", {
          text: "assistant mock response"
        }))
      }

      parts.push(Response.makePart("finish", {
        reason: finishReason,
        usage: mockUsage,
        response: undefined
      }))

      return Effect.succeed(
        new LanguageModel.GenerateTextResponse(parts)
      ) as any
    },
    streamText: (_options: any) => Stream.empty as any,
    generateObject: (_options: any) => Effect.die(new Error("generateObject not implemented in tests")) as any
  }
}

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
