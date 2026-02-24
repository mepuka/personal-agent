import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import type { AgentStatePort, GovernancePort, MemoryPort, SchedulePort, SessionTurnPort } from "@template/domain/ports"
import { Effect, Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import { AgentStatePortSqlite } from "./AgentStatePortSqlite.js"
import { AiConfig } from "./ai/AiConfig.js"
import * as ChatPersistence from "./ai/ChatPersistence.js"
import * as LanguageModelLive from "./ai/LanguageModelLive.js"
import { ToolRegistry } from "./ai/ToolRegistry.js"
import { ApiLive } from "./Api.js"
import { GovernancePortSqlite } from "./GovernancePortSqlite.js"
import { MemoryPortMemory } from "./MemoryPortMemory.js"
import * as DomainMigrator from "./persistence/DomainMigrator.js"
import * as SqliteRuntime from "./persistence/SqliteRuntime.js"
import { AgentStatePortTag, GovernancePortTag, MemoryPortTag, SchedulePortTag, SessionTurnPortTag } from "./PortTags.js"
import { SchedulePortSqlite } from "./SchedulePortSqlite.js"
import { layer as AgentEntityLayer } from "./entities/AgentEntity.js"
import { layer as GovernanceEntityLayer } from "./entities/GovernanceEntity.js"
import { layer as MemoryEntityLayer } from "./entities/MemoryEntity.js"
import { layer as SessionEntityLayer } from "./entities/SessionEntity.js"
import { layer as SchedulerCommandLayer } from "./scheduler/SchedulerCommandEntity.js"
import { SchedulerDispatchLoop } from "./scheduler/SchedulerDispatchLoop.js"
import { SchedulerRuntime } from "./SchedulerRuntime.js"
import { SessionTurnPortSqlite } from "./SessionTurnPortSqlite.js"
import { TurnProcessingRuntime } from "./turn/TurnProcessingRuntime.js"
import { layer as TurnProcessingWorkflowLayer } from "./turn/TurnProcessingWorkflow.js"
import { layer as TurnStreamingLayer } from "./TurnStreamingRouter.js"

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

const memoryPortTagLayer = Layer.effect(
  MemoryPortTag,
  Effect.gen(function*() {
    return (yield* MemoryPortMemory) as MemoryPort
  })
).pipe(Layer.provide(MemoryPortMemory.layer))

const agentEntityLayer = AgentEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(agentStatePortTagLayer)
)

const governanceEntityLayer = GovernanceEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(governancePortTagLayer)
)

const memoryEntityLayer = MemoryEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(memoryPortTagLayer)
)

const workflowEngineLayer = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(clusterLayer)
)

const aiConfigLayer = AiConfig.layer.pipe(
  Layer.orDie
)

const languageModelLayer = LanguageModelLive.layer.pipe(
  Layer.provide(aiConfigLayer)
)

const chatPersistenceLayer = ChatPersistence.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)

const toolRegistryLayer = ToolRegistry.layer.pipe(
  Layer.provide(governancePortTagLayer)
)

const turnProcessingWorkflowLayer = TurnProcessingWorkflowLayer.pipe(
  Layer.provide(workflowEngineLayer),
  Layer.provide(agentStatePortTagLayer),
  Layer.provide(sessionTurnPortTagLayer),
  Layer.provide(governancePortTagLayer),
  Layer.provide(toolRegistryLayer),
  Layer.provide(chatPersistenceLayer),
  Layer.provide(languageModelLayer)
)

const turnProcessingRuntimeLayer = TurnProcessingRuntime.layer.pipe(
  Layer.provide(workflowEngineLayer)
)

const sessionEntityLayer = SessionEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(sessionTurnPortTagLayer),
  Layer.provide(turnProcessingRuntimeLayer)
)

const PortsLive = Layer.mergeAll(
  MemoryPortMemory.layer,
  memoryPortTagLayer,
  agentStatePortTagLayer,
  sessionTurnPortTagLayer,
  schedulePortTagLayer,
  governancePortTagLayer,
  schedulerRuntimeLayer,
  schedulerCommandLayer,
  schedulerDispatchLayer,
  aiConfigLayer,
  languageModelLayer,
  chatPersistenceLayer,
  toolRegistryLayer,
  turnProcessingWorkflowLayer,
  turnProcessingRuntimeLayer,
  agentEntityLayer,
  sessionEntityLayer,
  governanceEntityLayer,
  memoryEntityLayer
).pipe(
  Layer.provideMerge(clusterLayer)
)

const HttpApiAndStreamingLive = Layer.mergeAll(
  ApiLive,
  TurnStreamingLayer
).pipe(
  Layer.provide(PortsLive),
  Layer.provide(clusterLayer)
)

const HttpLive = HttpRouter.serve(
  HttpApiAndStreamingLive
).pipe(
  Layer.provide(clusterLayer),
  Layer.provideMerge(BunHttpServer.layer({ port: 3000 }))
)

Layer.launch(HttpLive).pipe(
  BunRuntime.runMain
)
