import { BunFileSystem, BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer, Logger, ServiceMap } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentStatePortSqlite } from "./AgentStatePortSqlite.js"
import { AgentConfig, type AgentConfigService } from "./ai/AgentConfig.js"
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
import { SessionIdleMonitor } from "./memory/SessionIdleMonitor.js"
import { SubroutineCatalog } from "./memory/SubroutineCatalog.js"
import { SubroutineControlPlane } from "./memory/SubroutineControlPlane.js"
import { SubroutineRunner } from "./memory/SubroutineRunner.js"
import { TraceWriter } from "./memory/TraceWriter.js"
import { TranscriptProjector } from "./memory/TranscriptProjector.js"
import { ChannelCore } from "./ChannelCore.js"
import { CheckpointPortSqlite } from "./CheckpointPortSqlite.js"
import { CompactionCheckpointPortSqlite } from "./CompactionCheckpointPortSqlite.js"
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
  CompactionCheckpointPortTag,
  GovernancePortTag,
  IntegrationPortTag,
  MemoryPortTag,
  SchedulePortTag,
  SessionTurnPortTag,
  TurnPostCommitPortTag
} from "./PortTags.js"
import { SchedulePortSqlite } from "./SchedulePortSqlite.js"
import { SchedulerActionExecutor } from "./scheduler/SchedulerActionExecutor.js"
import { layer as SchedulerCommandLayer } from "./scheduler/SchedulerCommandEntity.js"
import { SchedulerDispatchLoop } from "./scheduler/SchedulerDispatchLoop.js"
import { SchedulerTickService } from "./scheduler/SchedulerTickService.js"
import { SchedulerRuntime } from "./SchedulerRuntime.js"
import { SessionTurnPortSqlite } from "./SessionTurnPortSqlite.js"
import { TurnPostCommitPortSqlite } from "./TurnPostCommitPortSqlite.js"
import { layer as TurnPostCommitCommandLayer } from "./turn/TurnPostCommitCommandEntity.js"
import { TurnPostCommitDispatchLoop } from "./turn/TurnPostCommitDispatchLoop.js"
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

const sqliteBackedLayer = <A>(
  serviceLayer: Layer.Layer<A>
): Layer.Layer<A> =>
  serviceLayer.pipe(Layer.provide(sqlInfrastructureLayer))

const exposeAsPortTagLayer = <Tag>(
  tag: ServiceMap.Service<any, Tag>,
  service: ServiceMap.Service<any, Tag>,
  layer: Layer.Layer<any>
): Layer.Layer<Tag> =>
  Layer.effect(
    tag,
    Effect.gen(function*() {
      return yield* (service as unknown as Effect.Effect<Tag>)
    })
  ).pipe(Layer.provide(layer))

const agentStatePortSqliteLayer = sqliteBackedLayer(AgentStatePortSqlite.layer)
const sessionTurnPortSqliteLayer = sqliteBackedLayer(SessionTurnPortSqlite.layer)
const schedulePortSqliteLayer = sqliteBackedLayer(SchedulePortSqlite.layer)
const governancePortSqliteLayer = sqliteBackedLayer(GovernancePortSqlite.layer)

const agentStatePortTagLayer = exposeAsPortTagLayer(
  AgentStatePortTag,
  AgentStatePortSqlite,
  agentStatePortSqliteLayer
)

const sessionTurnPortTagLayer = exposeAsPortTagLayer(
  SessionTurnPortTag,
  SessionTurnPortSqlite,
  sessionTurnPortSqliteLayer
)

const schedulePortTagLayer = exposeAsPortTagLayer(
  SchedulePortTag,
  SchedulePortSqlite,
  schedulePortSqliteLayer
)

const governancePortTagLayer = exposeAsPortTagLayer(
  GovernancePortTag,
  GovernancePortSqlite,
  governancePortSqliteLayer
)

const checkpointPortSqliteLayer = sqliteBackedLayer(CheckpointPortSqlite.layer)

const checkpointPortTagLayer = exposeAsPortTagLayer(
  CheckpointPortTag,
  CheckpointPortSqlite,
  checkpointPortSqliteLayer
)

const compactionCheckpointPortSqliteLayer = sqliteBackedLayer(
  CompactionCheckpointPortSqlite.layer
)

const compactionCheckpointPortTagLayer = exposeAsPortTagLayer(
  CompactionCheckpointPortTag,
  CompactionCheckpointPortSqlite,
  compactionCheckpointPortSqliteLayer
)

const channelPortSqliteLayer = sqliteBackedLayer(ChannelPortSqlite.layer)

const channelPortTagLayer = exposeAsPortTagLayer(
  ChannelPortTag,
  ChannelPortSqlite,
  channelPortSqliteLayer
)

const integrationPortSqliteLayer = sqliteBackedLayer(IntegrationPortSqlite.layer)

const integrationPortTagLayer = exposeAsPortTagLayer(
  IntegrationPortTag,
  IntegrationPortSqlite,
  integrationPortSqliteLayer
)

const postCommitPortSqliteLayer = sqliteBackedLayer(TurnPostCommitPortSqlite.layer)

const postCommitPortTagLayer = exposeAsPortTagLayer(
  TurnPostCommitPortTag,
  TurnPostCommitPortSqlite,
  postCommitPortSqliteLayer
)

const schedulerRuntimeLayer = SchedulerRuntime.layer.pipe(
  Layer.provide(schedulePortTagLayer)
)

const clusterLayer = SingleRunner.layer().pipe(
  Layer.provide(sqlInfrastructureLayer),
  Layer.orDie
)

const schedulerCommandLayer = SchedulerCommandLayer.pipe(
  Layer.provide(Layer.mergeAll(
    clusterLayer,
    schedulerRuntimeLayer,
    governancePortTagLayer
  ))
)

const memoryPortSqliteLayer = sqliteBackedLayer(MemoryPortSqlite.layer)

const memoryPortTagLayer = exposeAsPortTagLayer(
  MemoryPortTag,
  MemoryPortSqlite,
  memoryPortSqliteLayer
)

const agentEntityLayer = AgentEntityLayer.pipe(
  Layer.provide(clusterLayer),
  Layer.provide(agentStatePortTagLayer)
)

const memoryEntityLayer = MemoryEntityLayer.pipe(
  Layer.provide(Layer.mergeAll(
    clusterLayer,
    memoryPortTagLayer,
    memoryPortSqliteLayer,
    governancePortTagLayer
  ))
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

const chatPersistenceLayer = sqliteBackedLayer(ChatPersistence.layer)

const withConfigLayer = <A>(
  configLayer: Layer.Layer<any>,
  build: (config: AgentConfigService) => Layer.Layer<A>
): Layer.Layer<A> =>
  Layer.unwrap(
    Effect.gen(function*() {
      const config = yield* AgentConfig
      return build(config)
    }).pipe(Effect.provide(configLayer))
  )

const whenEnabled = <A>(
  configLayer: Layer.Layer<any>,
  isEnabled: (config: AgentConfigService) => boolean,
  build: (config: AgentConfigService) => Layer.Layer<A>
): Layer.Layer<A> =>
  withConfigLayer(configLayer, (config) => isEnabled(config) ? build(config) : Layer.empty as Layer.Layer<A>)

const commandHooksLayer = CommandHooksDefaultLayer

const cliRuntimeLayer = CliRuntimeLocalLayer.pipe(
  Layer.provide(BunServices.layer)
)

const commandBackendLayer = CommandBackendLocalLayer.pipe(
  Layer.provide(cliRuntimeLayer)
)

const commandRuntimeLayer = CommandRuntime.layer.pipe(
  Layer.provide(Layer.mergeAll(
    commandHooksLayer,
    commandBackendLayer,
    BunServices.layer
  ))
)

const fileHooksLayer = FileHooksDefaultLayer

const filePathPolicyLayer = FilePathPolicy.layer.pipe(
  Layer.provide(BunServices.layer)
)

const fileReadTrackerLayer = FileReadTracker.layer

const fileRuntimeLayer = FileRuntime.layer.pipe(
  Layer.provide(Layer.mergeAll(
    fileHooksLayer,
    fileReadTrackerLayer,
    filePathPolicyLayer,
    BunServices.layer
  ))
)

const toolExecutionLayer = ToolExecution.layer.pipe(
  Layer.provide(Layer.mergeAll(
    fileRuntimeLayer,
    filePathPolicyLayer,
    cliRuntimeLayer,
    commandRuntimeLayer,
    sqlInfrastructureLayer,
    BunServices.layer
  ))
)

const toolRegistryLayer = ToolRegistry.layer.pipe(
  Layer.provide(Layer.mergeAll(
    toolExecutionLayer,
    governancePortTagLayer,
    memoryPortTagLayer,
    agentConfigLayer,
    checkpointPortTagLayer
  ))
)

const subroutineCatalogLayer = SubroutineCatalog.layer.pipe(
  Layer.provide(Layer.mergeAll(agentConfigLayer, BunServices.layer))
)

const memoryFileServicesLayer = Layer.mergeAll(BunServices.layer, agentConfigLayer)

const traceWriterLayer = TraceWriter.layer.pipe(
  Layer.provide(memoryFileServicesLayer)
)

const subroutineRunnerLayer = SubroutineRunner.layer.pipe(
  Layer.provide(Layer.mergeAll(
    toolRegistryLayer,
    chatPersistenceLayer,
    agentConfigLayer,
    modelRegistryLayer,
    governancePortTagLayer,
    traceWriterLayer,
    compactionCheckpointPortTagLayer
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
  Layer.provide(Layer.mergeAll(
    clusterLayer,
    schedulerRuntimeLayer,
    schedulerCommandLayer,
    schedulerActionExecutorLayer
  ))
)

const schedulerTickLayer = SchedulerTickService.layer.pipe(
  Layer.provide(schedulerDispatchLayer)
)

const transcriptProjectorLayer = TranscriptProjector.layer.pipe(
  Layer.provide(Layer.mergeAll(memoryFileServicesLayer, sessionTurnPortTagLayer))
)

const postCommitCommandLayer = TurnPostCommitCommandLayer.pipe(
  Layer.provide(Layer.mergeAll(
    clusterLayer,
    subroutineCatalogLayer,
    subroutineRunnerLayer,
    transcriptProjectorLayer
  ))
)

const postCommitDispatchLayer = TurnPostCommitDispatchLoop.layer.pipe(
  Layer.provide(Layer.mergeAll(
    clusterLayer,
    postCommitPortTagLayer,
    postCommitCommandLayer
  ))
)

const sessionIdleMonitorLayer = SessionIdleMonitor.layer.pipe(
  Layer.provide(Layer.mergeAll(
    channelPortTagLayer,
    subroutineControlPlaneLayer,
    subroutineCatalogLayer,
    agentConfigLayer
  ))
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
    subroutineControlPlaneLayer,
    subroutineCatalogLayer
  ))
)

const turnProcessingRuntimeLayer = TurnProcessingRuntime.layer.pipe(
  Layer.provide(workflowEngineLayer)
)

const sessionEntityLayer = SessionEntityLayer.pipe(
  Layer.provide(Layer.mergeAll(
    clusterLayer,
    sessionTurnPortTagLayer,
    turnProcessingRuntimeLayer
  ))
)

const channelCoreLayer = ChannelCore.layer.pipe(
  Layer.provide(Layer.mergeAll(
    clusterLayer,
    agentStatePortTagLayer,
    channelPortTagLayer,
    sessionTurnPortTagLayer,
    turnProcessingRuntimeLayer,
    sessionEntityLayer,
    agentConfigLayer,
    checkpointPortTagLayer,
    toolRegistryLayer
  ))
)

const channelAdapterEntityDepsLayer = () => Layer.mergeAll(
  clusterLayer,
  channelCoreLayer,
  channelPortTagLayer
)

const cliAdapterEntityLayer = whenEnabled(
  agentConfigLayer,
  (config) => config.channels.cli.enabled,
  () => CLIAdapterEntityLayer.pipe(
    Layer.provide(channelAdapterEntityDepsLayer())
  )
)

const webChatAdapterEntityLayer = whenEnabled(
  agentConfigLayer,
  (config) => config.channels.webchat.enabled,
  () => WebChatAdapterEntityLayer.pipe(
    Layer.provide(channelAdapterEntityDepsLayer())
  )
)

const integrationEntityLayer = whenEnabled(
  agentConfigLayer,
  (config) => config.integrations.length > 0,
  () => IntegrationEntityLayer.pipe(
    Layer.provide(Layer.mergeAll(
      clusterLayer,
      integrationPortTagLayer,
      agentConfigLayer
    ))
  )
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
  compactionCheckpointPortTagLayer,
  channelPortTagLayer,
  integrationPortTagLayer,
  postCommitPortTagLayer
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
  Layer.provideMerge(postCommitDispatchLayer),
  Layer.provideMerge(portTagsLayer),
  Layer.provideMerge(memoryPortSqliteLayer),
  Layer.provideMerge(subroutineCatalogLayer),
  Layer.provideMerge(subroutineRunnerLayer),
  Layer.provideMerge(subroutineControlPlaneLayer),
  Layer.provideMerge(transcriptProjectorLayer),
  Layer.provideMerge(sessionIdleMonitorLayer),
  Layer.provideMerge(clusterLayer)
)

const ProxyApiLive = HttpApiBuilder.layer(ProxyApi).pipe(
  Layer.provide(ProxyHandlersLive)
)

const webChatRoutesLayer = whenEnabled(
  agentConfigLayer,
  (config) => config.channels.webchat.enabled,
  () => WebChatRoutesLayer
)

const cliRoutesLayer = whenEnabled(
  agentConfigLayer,
  (config) => config.channels.cli.enabled,
  () => ChannelRoutesLayer
)

const governanceRoutesLayer = GovernanceRoutesLayer.pipe(
  Layer.provide(Layer.mergeAll(
    agentStatePortTagLayer,
    governancePortTagLayer,
    sessionTurnPortTagLayer
  ))
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

const HttpServerLayer = withConfigLayer(
  agentConfigLayer,
  (config) => BunHttpServer.layer({ port: config.server.port })
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
