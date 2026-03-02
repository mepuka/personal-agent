import { BunFileSystem, BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import type {
  AgentStatePort,
  ChannelPort,
  CheckpointPort,
  GovernancePort,
  IntegrationPort,
  MemoryPort,
  SchedulePort,
  SessionTurnPort
} from "@template/domain/ports"
import { Effect, Layer, Logger } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentStatePortSqlite } from "./AgentStatePortSqlite.js"
import { AgentConfig } from "./ai/AgentConfig.js"
import * as ChatPersistence from "./ai/ChatPersistence.js"
import { ModelRegistry } from "./ai/ModelRegistry.js"
import { ToolRegistry } from "./ai/ToolRegistry.js"
import { layer as CliRuntimeLocalLayer } from "./tools/cli/CliRuntimeLocal.js"
import { layer as CommandBackendLocalLayer } from "./tools/command/CommandBackendLocal.js"
import { CommandRuntime } from "./tools/command/CommandRuntime.js"
import { CommandHooksDefaultLayer } from "./tools/command/hooks/CommandHooksDefault.js"
import { FileHooksDefaultLayer } from "./tools/file/hooks/FileHooksDefault.js"
import { FilePathPolicy } from "./tools/file/FilePathPolicy.js"
import { FileReadTracker } from "./tools/file/FileReadTracker.js"
import { FileRuntime } from "./tools/file/FileRuntime.js"
import { ToolExecution } from "./tools/ToolExecution.js"
import { SubroutineCatalog } from "./memory/SubroutineCatalog.js"
import { SubroutineControlPlane } from "./memory/SubroutineControlPlane.js"
import { SubroutineRunner } from "./memory/SubroutineRunner.js"
import { ChannelCore } from "./ChannelCore.js"
import { CheckpointPortSqlite } from "./CheckpointPortSqlite.js"
import { ChannelPortSqlite } from "./ChannelPortSqlite.js"
import { layer as AgentEntityLayer } from "./entities/AgentEntity.js"
import { layer as CLIAdapterEntityLayer } from "./entities/CLIAdapterEntity.js"
import { layer as IntegrationEntityLayer } from "./entities/IntegrationEntity.js"
import { layer as MemoryEntityLayer } from "./entities/MemoryEntity.js"
import { layer as SessionEntityLayer } from "./entities/SessionEntity.js"
import { layer as WebChatAdapterEntityLayer } from "./entities/WebChatAdapterEntity.js"
import { healthLayer as HealthRoutesLayer, layer as ChannelRoutesLayer } from "./gateway/ChannelRoutes.js"
import { layer as CheckpointRoutesLayer } from "./gateway/CheckpointRoutes.js"
import { layer as GovernanceRoutesLayer } from "./gateway/GovernanceRoutes.js"
import { ProxyApi, ProxyHandlersLive } from "./gateway/ProxyGateway.js"
import { layer as WebChatRoutesLayer } from "./gateway/WebChatRoutes.js"
import { GovernancePortSqlite } from "./GovernancePortSqlite.js"
import { IntegrationPortSqlite } from "./IntegrationPortSqlite.js"
import { MemoryPortSqlite } from "./MemoryPortSqlite.js"
import * as DomainMigrator from "./persistence/DomainMigrator.js"
import * as SqliteRuntime from "./persistence/SqliteRuntime.js"
import {
  AgentStatePortTag,
  ChannelPortTag,
  CheckpointPortTag,
  GovernancePortTag,
  IntegrationPortTag,
  MemoryPortTag,
  SchedulePortTag,
  SessionTurnPortTag
} from "./PortTags.js"
import { SchedulePortSqlite } from "./SchedulePortSqlite.js"
import { SchedulerActionExecutor } from "./scheduler/SchedulerActionExecutor.js"
import { layer as SchedulerCommandLayer } from "./scheduler/SchedulerCommandEntity.js"
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

const checkpointPortSqliteLayer = CheckpointPortSqlite.layer.pipe(
  Layer.provide(sqlInfrastructureLayer)
)

const checkpointPortTagLayer = Layer.effect(
  CheckpointPortTag,
  Effect.gen(function*() {
    return (yield* CheckpointPortSqlite) as CheckpointPort
  })
).pipe(Layer.provide(checkpointPortSqliteLayer))

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
  Layer.provide(memoryPortSqliteLayer),
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

const commandHooksLayer = CommandHooksDefaultLayer

const cliRuntimeLayer = CliRuntimeLocalLayer.pipe(
  Layer.provide(BunServices.layer)
)

const commandBackendLayer = CommandBackendLocalLayer.pipe(
  Layer.provide(cliRuntimeLayer)
)

const commandRuntimeLayer = CommandRuntime.layer.pipe(
  Layer.provide(commandHooksLayer),
  Layer.provide(commandBackendLayer),
  Layer.provide(BunServices.layer)
)

const fileHooksLayer = FileHooksDefaultLayer

const filePathPolicyLayer = FilePathPolicy.layer.pipe(
  Layer.provide(BunServices.layer)
)

const fileReadTrackerLayer = FileReadTracker.layer

const fileRuntimeLayer = FileRuntime.layer.pipe(
  Layer.provide(fileHooksLayer),
  Layer.provide(fileReadTrackerLayer),
  Layer.provide(filePathPolicyLayer),
  Layer.provide(BunServices.layer)
)

const toolExecutionLayer = ToolExecution.layer.pipe(
  Layer.provide(fileRuntimeLayer),
  Layer.provide(filePathPolicyLayer),
  Layer.provide(cliRuntimeLayer),
  Layer.provide(commandRuntimeLayer),
  Layer.provide(sqlInfrastructureLayer),
  Layer.provide(BunServices.layer)
)

const toolRegistryLayer = ToolRegistry.layer.pipe(
  Layer.provide(toolExecutionLayer),
  Layer.provide(governancePortTagLayer),
  Layer.provide(memoryPortTagLayer),
  Layer.provide(agentConfigLayer),
  Layer.provide(checkpointPortTagLayer)
)

const subroutineCatalogLayer = SubroutineCatalog.layer.pipe(
  Layer.provide(Layer.mergeAll(agentConfigLayer, BunServices.layer))
)

const subroutineRunnerLayer = SubroutineRunner.layer.pipe(
  Layer.provide(Layer.mergeAll(
    toolRegistryLayer,
    chatPersistenceLayer,
    agentConfigLayer,
    modelRegistryLayer,
    governancePortTagLayer
  ))
)

const subroutineControlPlaneLayer = SubroutineControlPlane.layer.pipe(
  Layer.provide(Layer.mergeAll(
    subroutineRunnerLayer,
    subroutineCatalogLayer,
    governancePortTagLayer
  ))
)

const schedulerActionExecutorLayer = SchedulerActionExecutor.layer.pipe(
  Layer.provide(Layer.mergeAll(
    commandRuntimeLayer,
    governancePortTagLayer,
    subroutineRunnerLayer,
    subroutineCatalogLayer
  ))
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

const turnProcessingWorkflowLayer = TurnProcessingWorkflowLayer.pipe(
  Layer.provide(Layer.mergeAll(
    workflowEngineLayer,
    agentStatePortTagLayer,
    sessionTurnPortTagLayer,
    governancePortTagLayer,
    toolRegistryLayer,
    chatPersistenceLayer,
    agentConfigLayer,
    modelRegistryLayer,
    checkpointPortTagLayer,
    subroutineControlPlaneLayer
  ))
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
  Layer.provide(sessionEntityLayer),
  Layer.provide(agentConfigLayer),
  Layer.provide(checkpointPortTagLayer),
  Layer.provide(toolRegistryLayer)
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
  memoryPortSqliteLayer,
  memoryPortTagLayer,
  memoryEntityLayer,
  agentStatePortTagLayer,
  sessionTurnPortTagLayer,
  schedulePortTagLayer,
  governancePortTagLayer,
  checkpointPortTagLayer,
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
  Layer.provideMerge(channelCoreLayer),
  Layer.provideMerge(workflowLayer),
  Layer.provideMerge(toolRegistryLayer),
  Layer.provideMerge(modelRegistryLayer),
  Layer.provideMerge(chatPersistenceLayer),
  Layer.provideMerge(agentConfigLayer),
  Layer.provideMerge(schedulerLayer),
  Layer.provideMerge(portTagsLayer),
  Layer.provideMerge(memoryPortSqliteLayer),
  Layer.provideMerge(subroutineCatalogLayer),
  Layer.provideMerge(subroutineRunnerLayer),
  Layer.provideMerge(subroutineControlPlaneLayer),
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

const governanceRoutesLayer = GovernanceRoutesLayer.pipe(
  Layer.provide(agentStatePortTagLayer),
  Layer.provide(governancePortTagLayer),
  Layer.provide(sessionTurnPortTagLayer)
)

const HttpApiAndRoutesLive = Layer.mergeAll(
  ProxyApiLive,
  HealthRoutesLayer,
  cliRoutesLayer,
  webChatRoutesLayer,
  governanceRoutesLayer,
  CheckpointRoutesLayer
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
  Effect.provide(Layer.mergeAll(
    Logger.layer([Logger.consoleJson]),
    agentStatePortTagLayer,
    governancePortTagLayer,
    sessionTurnPortTagLayer,
    channelCoreLayer
  )),
  BunRuntime.runMain
)
