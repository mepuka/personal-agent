import { BunFileSystem, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import type {
  AgentStatePort,
  ChannelPort,
  GovernancePort,
  MemoryPort,
  SchedulePort,
  SessionTurnPort
} from "@template/domain/ports"
import { Effect, Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentStatePortSqlite } from "./AgentStatePortSqlite.js"
import { AgentConfig } from "./ai/AgentConfig.js"
import * as ChatPersistence from "./ai/ChatPersistence.js"
import { ModelRegistry } from "./ai/ModelRegistry.js"
import { ToolRegistry } from "./ai/ToolRegistry.js"
import { ChannelPortSqlite } from "./ChannelPortSqlite.js"
import { layer as AgentEntityLayer } from "./entities/AgentEntity.js"
import { layer as ChannelEntityLayer } from "./entities/ChannelEntity.js"
import { layer as SessionEntityLayer } from "./entities/SessionEntity.js"
import { layer as ChannelRoutesLayer } from "./gateway/ChannelRoutes.js"
import { ProxyApi, ProxyHandlersLive } from "./gateway/ProxyGateway.js"
import { GovernancePortSqlite } from "./GovernancePortSqlite.js"
import { MemoryPortMemory } from "./MemoryPortMemory.js"
import * as DomainMigrator from "./persistence/DomainMigrator.js"
import * as SqliteRuntime from "./persistence/SqliteRuntime.js"
import {
  AgentStatePortTag,
  ChannelPortTag,
  GovernancePortTag,
  MemoryPortTag,
  SchedulePortTag,
  SessionTurnPortTag
} from "./PortTags.js"
import { SchedulePortSqlite } from "./SchedulePortSqlite.js"
import { layer as SchedulerCommandLayer } from "./scheduler/SchedulerCommandEntity.js"
import { SchedulerActionExecutor } from "./scheduler/SchedulerActionExecutor.js"
import { SchedulerDispatchLoop } from "./scheduler/SchedulerDispatchLoop.js"
import { SchedulerTickService } from "./scheduler/SchedulerTickService.js"
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

const channelPortSqliteLayer = ChannelPortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)

const channelPortTagLayer = Layer.effect(
  ChannelPortTag,
  Effect.gen(function*() {
    return (yield* ChannelPortSqlite) as ChannelPort
  })
).pipe(Layer.provide(channelPortSqliteLayer))

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

const schedulerActionExecutorLayer = SchedulerActionExecutor.layer.pipe(
  Layer.provide(governancePortTagLayer)
)

const schedulerDispatchLayer = SchedulerDispatchLoop.layer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(schedulerRuntimeLayer),
  Layer.provide(schedulerCommandLayer),
  Layer.provide(schedulerActionExecutorLayer)
)

const schedulerTickLayer = SchedulerTickService.layer.pipe(
  Layer.provide(schedulerDispatchLayer)
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

const workflowEngineLayer = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(clusterLayer)
)

const agentConfigLayer = AgentConfig.layer.pipe(
  Layer.provide(BunFileSystem.layer),
  Layer.orDie
)

const modelRegistryLayer = ModelRegistry.layer.pipe(
  Layer.provide(agentConfigLayer)
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
  Layer.provide(agentConfigLayer),
  Layer.provide(modelRegistryLayer)
)

const turnProcessingRuntimeLayer = TurnProcessingRuntime.layer.pipe(
  Layer.provide(workflowEngineLayer)
)

const sessionEntityLayer = SessionEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(sessionTurnPortTagLayer),
  Layer.provide(turnProcessingRuntimeLayer)
)

const channelEntityLayer = ChannelEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(agentStatePortTagLayer),
  Layer.provide(channelPortTagLayer),
  Layer.provide(sessionTurnPortTagLayer),
  Layer.provide(turnProcessingRuntimeLayer),
  Layer.provide(sessionEntityLayer)
)

const portTagsLayer = Layer.mergeAll(
  memoryPortTagLayer,
  agentStatePortTagLayer,
  sessionTurnPortTagLayer,
  schedulePortTagLayer,
  governancePortTagLayer,
  channelPortTagLayer
)

const schedulerLayer = schedulerTickLayer.pipe(
  Layer.provideMerge(schedulerDispatchLayer),
  Layer.provideMerge(schedulerCommandLayer),
  Layer.provideMerge(schedulerRuntimeLayer)
)

const workflowLayer = turnProcessingRuntimeLayer.pipe(
  Layer.provideMerge(turnProcessingWorkflowLayer)
)

const entityLayer = channelEntityLayer.pipe(
  Layer.provideMerge(sessionEntityLayer),
  Layer.provideMerge(agentEntityLayer)
)

const PortsLive = entityLayer.pipe(
  Layer.provideMerge(workflowLayer),
  Layer.provideMerge(toolRegistryLayer),
  Layer.provideMerge(modelRegistryLayer),
  Layer.provideMerge(chatPersistenceLayer),
  Layer.provideMerge(agentConfigLayer),
  Layer.provideMerge(schedulerLayer),
  Layer.provideMerge(portTagsLayer),
  Layer.provideMerge(MemoryPortMemory.layer),
  Layer.provideMerge(clusterLayer)
)

const ProxyApiLive = HttpApiBuilder.layer(ProxyApi).pipe(
  Layer.provide(ProxyHandlersLive)
)

const HttpApiAndRoutesLive = Layer.mergeAll(
  ProxyApiLive,
  ChannelRoutesLayer
).pipe(
  Layer.provide(PortsLive),
  Layer.provide(clusterLayer)
)

const HttpLive = HttpRouter.serve(
  HttpApiAndRoutesLive
).pipe(
  Layer.provide(clusterLayer),
  Layer.provideMerge(BunHttpServer.layer({ port: 3000 }))
)

Layer.launch(HttpLive).pipe(
  BunRuntime.runMain
)
