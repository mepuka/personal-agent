import { BunFileSystem, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import type {
  AgentStatePort,
  ChannelPort,
  GovernancePort,
  IntegrationPort,
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
import { ChannelCore } from "./ChannelCore.js"
import { ChannelPortSqlite } from "./ChannelPortSqlite.js"
import { layer as AgentEntityLayer } from "./entities/AgentEntity.js"
import { layer as IntegrationEntityLayer } from "./entities/IntegrationEntity.js"
import { layer as CLIAdapterEntityLayer } from "./entities/CLIAdapterEntity.js"
import { layer as WebChatAdapterEntityLayer } from "./entities/WebChatAdapterEntity.js"
import { layer as MemoryEntityLayer } from "./entities/MemoryEntity.js"
import { layer as SessionEntityLayer } from "./entities/SessionEntity.js"
import { layer as ChannelRoutesLayer, healthLayer as HealthRoutesLayer } from "./gateway/ChannelRoutes.js"
import { layer as WebChatRoutesLayer } from "./gateway/WebChatRoutes.js"
import { ProxyApi, ProxyHandlersLive } from "./gateway/ProxyGateway.js"
import { GovernancePortSqlite } from "./GovernancePortSqlite.js"
import { IntegrationPortSqlite } from "./IntegrationPortSqlite.js"
import { MemoryPortSqlite } from "./MemoryPortSqlite.js"
import * as DomainMigrator from "./persistence/DomainMigrator.js"
import * as SqliteRuntime from "./persistence/SqliteRuntime.js"
import {
  AgentStatePortTag,
  ChannelPortTag,
  GovernancePortTag,
  IntegrationPortTag,
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

const integrationPortSqliteLayer = IntegrationPortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)

const integrationPortTagLayer = Layer.effect(
  IntegrationPortTag,
  Effect.gen(function*() {
    return (yield* IntegrationPortSqlite) as IntegrationPort
  })
).pipe(Layer.provide(integrationPortSqliteLayer))

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

const memoryPortSqliteLayer = MemoryPortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)

const memoryPortTagLayer = Layer.effect(
  MemoryPortTag,
  Effect.gen(function*() {
    return (yield* MemoryPortSqlite) as MemoryPort
  })
).pipe(Layer.provide(memoryPortSqliteLayer))

const agentEntityLayer = AgentEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(agentStatePortTagLayer)
)

const memoryEntityLayer = MemoryEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(memoryPortTagLayer),
  Layer.provide(governancePortTagLayer)
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
  Layer.provide(memoryPortTagLayer),
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

const channelCoreLayer = ChannelCore.layer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(agentStatePortTagLayer),
  Layer.provide(channelPortTagLayer),
  Layer.provide(sessionTurnPortTagLayer),
  Layer.provide(turnProcessingRuntimeLayer),
  Layer.provide(sessionEntityLayer)
)

const cliAdapterEntityLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    if (!config.channels.cli.enabled) {
      return Layer.empty
    }
    return CLIAdapterEntityLayer.pipe(
      Layer.provide(clusterLayer),
      Layer.provide(channelCoreLayer),
      Layer.provide(channelPortTagLayer)
    )
  }).pipe(Effect.provide(agentConfigLayer))
)

const webChatAdapterEntityLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    if (!config.channels.webchat.enabled) {
      return Layer.empty
    }
    return WebChatAdapterEntityLayer.pipe(
      Layer.provide(clusterLayer),
      Layer.provide(channelCoreLayer),
      Layer.provide(channelPortTagLayer)
    )
  }).pipe(Effect.provide(agentConfigLayer))
)

const integrationEntityLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    if (config.integrations.length === 0) {
      return Layer.empty
    }
    return IntegrationEntityLayer.pipe(
      Layer.provide(clusterLayer),
      Layer.provide(integrationPortTagLayer),
      Layer.provide(agentConfigLayer)
    )
  }).pipe(Effect.provide(agentConfigLayer))
)

const portTagsLayer = Layer.mergeAll(
  memoryPortTagLayer,
  agentStatePortTagLayer,
  sessionTurnPortTagLayer,
  schedulePortTagLayer,
  governancePortTagLayer,
  channelPortTagLayer,
  integrationPortTagLayer
)

const schedulerLayer = schedulerTickLayer.pipe(
  Layer.provideMerge(schedulerDispatchLayer),
  Layer.provideMerge(schedulerCommandLayer),
  Layer.provideMerge(schedulerRuntimeLayer)
)

const workflowLayer = turnProcessingRuntimeLayer.pipe(
  Layer.provideMerge(turnProcessingWorkflowLayer)
)

const entityLayer = cliAdapterEntityLayer.pipe(
  Layer.provideMerge(webChatAdapterEntityLayer),
  Layer.provideMerge(integrationEntityLayer),
  Layer.provideMerge(sessionEntityLayer),
  Layer.provideMerge(agentEntityLayer),
  Layer.provideMerge(memoryEntityLayer)
)

const PortsLive = entityLayer.pipe(
  Layer.provideMerge(workflowLayer),
  Layer.provideMerge(toolRegistryLayer),
  Layer.provideMerge(modelRegistryLayer),
  Layer.provideMerge(chatPersistenceLayer),
  Layer.provideMerge(agentConfigLayer),
  Layer.provideMerge(schedulerLayer),
  Layer.provideMerge(portTagsLayer),
  Layer.provideMerge(memoryPortSqliteLayer),
  Layer.provideMerge(clusterLayer)
)

const ProxyApiLive = HttpApiBuilder.layer(ProxyApi).pipe(
  Layer.provide(ProxyHandlersLive)
)

const webChatRoutesLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    if (!config.channels.webchat.enabled) {
      return Layer.empty
    }
    return WebChatRoutesLayer
  }).pipe(Effect.provide(agentConfigLayer))
)

const cliRoutesLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    if (!config.channels.cli.enabled) {
      return Layer.empty
    }
    return ChannelRoutesLayer
  }).pipe(Effect.provide(agentConfigLayer))
)

const HttpApiAndRoutesLive = Layer.mergeAll(
  ProxyApiLive,
  HealthRoutesLayer,
  cliRoutesLayer,
  webChatRoutesLayer
).pipe(
  Layer.provide(PortsLive),
  Layer.provide(clusterLayer)
)

const HttpServerLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AgentConfig
    return BunHttpServer.layer({ port: config.server.port })
  }).pipe(Effect.provide(agentConfigLayer))
)

const HttpLive = HttpRouter.serve(
  HttpApiAndRoutesLive
).pipe(
  Layer.provide(clusterLayer),
  Layer.provideMerge(HttpServerLayer)
)

Layer.launch(HttpLive).pipe(
  BunRuntime.runMain
)
