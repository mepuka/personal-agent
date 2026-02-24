import { describe, expect, it } from "@effect/vitest"
import type { AgentId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type {
  AgentState,
  AgentStatePort,
  GovernancePort,
  Instant,
  SessionState,
  SessionTurnPort,
  TurnRecord
} from "@template/domain/ports"
import type { AuthorizationDecision } from "@template/domain/status"
import { DateTime, Effect, Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStatePortSqlite } from "../src/AgentStatePortSqlite.js"
import { GovernancePortSqlite } from "../src/GovernancePortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"
import { AgentStatePortTag, GovernancePortTag, SessionTurnPortTag } from "../src/PortTags.js"
import { SessionTurnPortSqlite } from "../src/SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "../src/turn/TurnProcessingRuntime.js"
import { layer as TurnProcessingWorkflowLayer, TurnPolicyDenied } from "../src/turn/TurnProcessingWorkflow.js"

describe("TurnProcessingWorkflow e2e", () => {
  it.effect("processes one turn and persists audit + state", () => {
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
      expect(persistedSession?.tokensUsed).toBe(25)
      expect(persistedAgent?.tokensConsumed).toBe(25)
      expect(turns).toHaveLength(1)
      expect(turns[0].content).toBe("hello from happy path")
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
      expect(turns).toHaveLength(1)
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
      expect(persisted.turns).toHaveLength(1)
      expect(persisted.turns[0].content).toBe("persist me")
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
})

const makeTurnProcessingLayer = (
  dbPath: string,
  forcedDecision: AuthorizationDecision = "Allow"
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
            reason: `forced_${forcedDecision.toLowerCase()}`
          })
      } as GovernancePort
    })
  ).pipe(Layer.provide(governanceSqliteLayer))

  const clusterLayer = SingleRunner.layer().pipe(
    Layer.provide(sqlInfrastructureLayer),
    Layer.orDie
  )

  const workflowEngineLayer = ClusterWorkflowEngine.layer.pipe(
    Layer.provide(clusterLayer)
  )

  const turnWorkflowLayer = TurnProcessingWorkflowLayer.pipe(
    Layer.provide(workflowEngineLayer),
    Layer.provide(agentStateTagLayer),
    Layer.provide(sessionTurnTagLayer),
    Layer.provide(governanceTagLayer)
  )

  const turnRuntimeLayer = TurnProcessingRuntime.layer.pipe(
    Layer.provide(workflowEngineLayer)
  )

  return Layer.mergeAll(
    sqlInfrastructureLayer,
    agentStateSqliteLayer,
    sessionTurnSqliteLayer,
    governanceSqliteLayer,
    agentStateTagLayer,
    sessionTurnTagLayer,
    governanceTagLayer,
    workflowEngineLayer,
    turnWorkflowLayer,
    turnRuntimeLayer
  ).pipe(
    Layer.provideMerge(clusterLayer)
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const makeAgentState = (overrides: Partial<AgentState>): AgentState => ({
  agentId: "agent:default" as AgentId,
  permissionMode: "Standard",
  tokenBudget: 100,
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

const makeTurnPayload = (overrides: Partial<TurnRecord> & { inputTokens?: number }) => ({
  turnId: (overrides.turnId ?? ("turn:default" as TurnId)) as string,
  sessionId: (overrides.sessionId ?? ("session:default" as SessionId)) as string,
  conversationId: (overrides.conversationId ?? ("conversation:default" as ConversationId)) as string,
  agentId: (overrides.agentId ?? ("agent:default" as AgentId)) as string,
  content: overrides.content ?? "hello",
  createdAt: overrides.createdAt ?? instant("2026-02-24T12:00:00.000Z"),
  inputTokens: overrides.inputTokens ?? 10
})

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
