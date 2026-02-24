import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import type { AgentStatePort, GovernancePort, SchedulePort, SessionTurnPort } from "@template/domain/ports"
import { Effect, Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import { AgentStatePortSqlite } from "./AgentStatePortSqlite.js"
import { ApiLive } from "./Api.js"
import { GovernancePortSqlite } from "./GovernancePortSqlite.js"
import { MemoryPortMemory } from "./MemoryPortMemory.js"
import * as DomainMigrator from "./persistence/DomainMigrator.js"
import * as SqliteRuntime from "./persistence/SqliteRuntime.js"
import { AgentStatePortTag, GovernancePortTag, SchedulePortTag, SessionTurnPortTag } from "./PortTags.js"
import { SchedulePortSqlite } from "./SchedulePortSqlite.js"
import { layer as SchedulerCommandLayer } from "./scheduler/SchedulerCommandEntity.js"
import { SchedulerDispatchLoop } from "./scheduler/SchedulerDispatchLoop.js"
import { SchedulerRuntime } from "./SchedulerRuntime.js"
import { SessionTurnPortSqlite } from "./SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "./turn/TurnProcessingRuntime.js"
import { layer as TurnProcessingWorkflowLayer } from "./turn/TurnProcessingWorkflow.js"

const sqliteLayer = SqliteRuntime.layer()
const migrationLayer = DomainMigrator.layer.pipe(
  Layer.provide(sqliteLayer),
  Layer.orDie
)
const sqlInfrastructureLayer = Layer.mergeAll(
  sqliteLayer,
  migrationLayer
)

const agentStatePortSqliteLayer = AgentStatePortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)
const sessionTurnPortSqliteLayer = SessionTurnPortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)
const schedulePortSqliteLayer = SchedulePortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)
const governancePortSqliteLayer = GovernancePortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)

const agentStatePortTagLayer = Layer.effect(
  AgentStatePortTag,
  Effect.gen(function*() {
    return (yield* AgentStatePortSqlite) as AgentStatePort
  })
).pipe(Layer.provide(agentStatePortSqliteLayer))

const sessionTurnPortTagLayer = Layer.effect(
  SessionTurnPortTag,
  Effect.gen(function*() {
    return (yield* SessionTurnPortSqlite) as SessionTurnPort
  })
).pipe(Layer.provide(sessionTurnPortSqliteLayer))

const schedulePortTagLayer = Layer.effect(
  SchedulePortTag,
  Effect.gen(function*() {
    return (yield* SchedulePortSqlite) as SchedulePort
  })
).pipe(Layer.provide(schedulePortSqliteLayer))

const governancePortTagLayer = Layer.effect(
  GovernancePortTag,
  Effect.gen(function*() {
    return (yield* GovernancePortSqlite) as GovernancePort
  })
).pipe(Layer.provide(governancePortSqliteLayer))

const schedulerRuntimeLayer = SchedulerRuntime.layer.pipe(
  Layer.provide(schedulePortTagLayer)
)

const clusterLayer = SingleRunner.layer().pipe(
  Layer.provide(sqlInfrastructureLayer),
  Layer.orDie
)

const schedulerCommandLayer = SchedulerCommandLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(schedulerRuntimeLayer),
  Layer.provide(governancePortTagLayer)
)

const schedulerDispatchLayer = SchedulerDispatchLoop.layer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(schedulerRuntimeLayer),
  Layer.provide(schedulerCommandLayer)
)

const workflowEngineLayer = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(clusterLayer)
)

const turnProcessingWorkflowLayer = TurnProcessingWorkflowLayer.pipe(
  Layer.provide(workflowEngineLayer),
  Layer.provide(agentStatePortTagLayer),
  Layer.provide(sessionTurnPortTagLayer),
  Layer.provide(governancePortTagLayer)
)

const turnProcessingRuntimeLayer = TurnProcessingRuntime.layer.pipe(
  Layer.provide(workflowEngineLayer)
)

const PortsLive = Layer.mergeAll(
  MemoryPortMemory.layer,
  agentStatePortTagLayer,
  sessionTurnPortTagLayer,
  schedulePortTagLayer,
  governancePortTagLayer,
  schedulerRuntimeLayer,
  schedulerCommandLayer,
  schedulerDispatchLayer,
  turnProcessingWorkflowLayer,
  turnProcessingRuntimeLayer
)

const HttpLive = HttpRouter.serve(
  ApiLive.pipe(Layer.provide(PortsLive))
).pipe(
  Layer.provideMerge(BunHttpServer.layer({ port: 3000 }))
)

Layer.launch(HttpLive).pipe(
  BunRuntime.runMain
)
