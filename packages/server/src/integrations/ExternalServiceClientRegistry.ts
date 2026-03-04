import type { AgentId, ExternalServiceId, IntegrationId } from "@template/domain/ids"
import type { ExternalServiceRecord, IntegrationRecord, ServiceCapability } from "@template/domain/integration"
import type { Instant } from "@template/domain/ports"
import type { IntegrationStatus } from "@template/domain/status"
import { DateTime, Deferred, Duration, Effect, Layer, Ref, Schedule, ServiceMap, Semaphore } from "effect"
import { AgentConfig } from "../ai/AgentConfig.js"
import { IntegrationPortTag } from "../PortTags.js"
import { RuntimeSupervisor } from "../runtime/RuntimeSupervisor.js"
import {
  type IntegrationRuntimeHealth,
  type StdioConnectResult,
  type StdioProcessHandle,
  StdioIntegrationClient
} from "./StdioIntegrationClient.js"

const RECONNECT_DELAY = Duration.seconds(5)
const HEALTH_CHECK_INTERVAL = Duration.seconds(5)

export interface RuntimeIntegrationStatus {
  readonly integrationId: IntegrationId
  readonly agentId: AgentId
  readonly serviceId: ExternalServiceId
  readonly status: IntegrationStatus
  readonly health: IntegrationRuntimeHealth
  readonly capabilities: ReadonlyArray<ServiceCapability>
  readonly pid: number | null
  readonly lastError: string | null
  readonly updatedAt: Instant
}

export interface RuntimeIntegrationSummary {
  readonly total: number
  readonly connected: number
  readonly initializing: number
  readonly error: number
  readonly disconnected: number
  readonly degraded: number
}

export interface RuntimeIntegrationSnapshot {
  readonly summary: RuntimeIntegrationSummary
  readonly integrations: ReadonlyArray<RuntimeIntegrationStatus>
}

export interface ExternalServiceConnectRequest {
  readonly integrationId: IntegrationId
  readonly agentId: AgentId
  readonly service: ExternalServiceRecord
}

interface RegistryEntry {
  readonly integrationId: IntegrationId
  readonly agentId: AgentId
  readonly service: ExternalServiceRecord
  readonly status: IntegrationStatus
  readonly health: IntegrationRuntimeHealth
  readonly capabilities: ReadonlyArray<ServiceCapability>
  readonly createdAt: Instant
  readonly updatedAt: Instant
  readonly lastError: string | null
  readonly process: StdioProcessHandle | null
}

export interface ExternalServiceClientRegistryService {
  readonly connect: (request: ExternalServiceConnectRequest) => Effect.Effect<void>
  readonly disconnect: (serviceId: ExternalServiceId) => Effect.Effect<void>
  readonly getStatus: (integrationId: IntegrationId) => Effect.Effect<RuntimeIntegrationStatus | null>
  readonly snapshot: () => Effect.Effect<RuntimeIntegrationSnapshot>
}

const workerKeyForService = (serviceId: ExternalServiceId): string =>
  `runtime.integration.${serviceId}`

const toRuntimeStatus = (entry: RegistryEntry): RuntimeIntegrationStatus => ({
  integrationId: entry.integrationId,
  agentId: entry.agentId,
  serviceId: entry.service.serviceId,
  status: entry.status,
  health: entry.health,
  capabilities: entry.capabilities,
  pid: entry.process === null ? null : Number(entry.process.child.pid),
  lastError: entry.lastError,
  updatedAt: entry.updatedAt
})

const summarizeIntegrations = (
  integrations: ReadonlyArray<RuntimeIntegrationStatus>
): RuntimeIntegrationSummary => ({
  total: integrations.length,
  connected: integrations.filter((item) => item.status === "Connected").length,
  initializing: integrations.filter((item) => item.status === "Initializing").length,
  error: integrations.filter((item) => item.status === "Error").length,
  disconnected: integrations.filter((item) => item.status === "Disconnected").length,
  degraded: integrations.filter((item) => item.health === "degraded").length
})

export class ExternalServiceClientRegistry
  extends ServiceMap.Service<ExternalServiceClientRegistryService>()(
    "server/integrations/ExternalServiceClientRegistry",
    {
      make: Effect.gen(function*() {
        const integrationPort = yield* IntegrationPortTag
        const runtimeSupervisor = yield* RuntimeSupervisor
        const stdioClient = yield* StdioIntegrationClient
        const agentConfig = yield* AgentConfig

        const entriesRef = yield* Ref.make(new Map<ExternalServiceId, RegistryEntry>())
        const mutationLock = yield* Semaphore.make(1)

        const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          mutationLock.withPermits(1)(effect)

        const persistEntry = (entry: RegistryEntry) =>
          Effect.gen(function*() {
            const record: IntegrationRecord = {
              integrationId: entry.integrationId,
              agentId: entry.agentId,
              serviceId: entry.service.serviceId,
              status: entry.status,
              capabilities: [...entry.capabilities],
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt
            }

            yield* integrationPort.createService(entry.service)
            yield* integrationPort.createIntegration(record)
          })

        const updateEntry = (
          serviceId: ExternalServiceId,
          update: (entry: RegistryEntry) => RegistryEntry
        ) =>
          withLock(
            Effect.gen(function*() {
              const map = yield* Ref.get(entriesRef)
              const current = map.get(serviceId)
              if (current === undefined) {
                return null as RegistryEntry | null
              }

              const next = update(current)
              const updatedMap = new Map(map)
              updatedMap.set(serviceId, next)
              yield* Ref.set(entriesRef, updatedMap)
              return next
            })
          )

        const setEntry = (entry: RegistryEntry) =>
          withLock(
            Ref.update(entriesRef, (map) => {
              const next = new Map(map)
              next.set(entry.service.serviceId, entry)
              return next
            })
          )

        const clearProcessHandle = (serviceId: ExternalServiceId) =>
          updateEntry(serviceId, (entry) => ({
            ...entry,
            process: null
          })).pipe(Effect.asVoid)

        const transitionToError = (serviceId: ExternalServiceId, errorMessage: string) =>
          Effect.gen(function*() {
            const now = yield* DateTime.now
            const updated = yield* updateEntry(serviceId, (entry) => ({
              ...entry,
              status: "Error",
              health: "degraded",
              lastError: errorMessage,
              updatedAt: now,
              process: null
            }))

            if (updated !== null) {
              yield* persistEntry(updated)
            }
          })

        const transitionToConnected = (
          serviceId: ExternalServiceId,
          connection: StdioConnectResult
        ) =>
          Effect.gen(function*() {
            const now = yield* DateTime.now
            const updated = yield* updateEntry(serviceId, (entry) => ({
              ...entry,
              status: "Connected",
              health: connection.health,
              capabilities: connection.capabilities,
              lastError: connection.discoveryError,
              updatedAt: now,
              process: connection.handle
            }))

            if (updated !== null) {
              yield* persistEntry(updated)
            }
          })

        const transitionToInitializing = (serviceId: ExternalServiceId) =>
          Effect.gen(function*() {
            const now = yield* DateTime.now
            const updated = yield* updateEntry(serviceId, (entry) => ({
              ...entry,
              status: "Initializing",
              health: "healthy",
              lastError: null,
              updatedAt: now,
              process: null
            }))

            if (updated !== null) {
              yield* persistEntry(updated)
            }
          })

        const waitForExitWithHealthChecks = (handle: StdioProcessHandle): Effect.Effect<number> =>
          Effect.gen(function*() {
            const exitDeferred = yield* Deferred.make<number>()

            const publishExit = (effect: Effect.Effect<number>): Effect.Effect<void> =>
              effect.pipe(
                Effect.flatMap((exitCode) => Deferred.succeed(exitDeferred, exitCode)),
                Effect.asVoid
              )

            const observeByExitSignal = publishExit(
              stdioClient.waitForExit(handle)
            )

            const observeByHealthCheck = stdioClient.isRunning(handle).pipe(
              Effect.flatMap((running) =>
                running
                  ? Effect.void
                  : publishExit(stdioClient.waitForExit(handle))
              ),
              Effect.repeat(Schedule.spaced(HEALTH_CHECK_INTERVAL))
            )

            yield* Effect.raceFirst(observeByExitSignal, observeByHealthCheck)
            return yield* Deferred.await(exitDeferred)
          })

        const runWorkerAttempt = (serviceId: ExternalServiceId): Effect.Effect<void> =>
          Effect.gen(function*() {
            const map = yield* Ref.get(entriesRef)
            const entry = map.get(serviceId)
            if (entry === undefined) {
              return
            }

            if (entry.service.transport !== "stdio") {
              yield* transitionToError(
                serviceId,
                `transport ${entry.service.transport} is not supported by stdio integration kernel`
              )
              return
            }

            yield* transitionToInitializing(serviceId)

            const connection = yield* stdioClient.connect(entry.service)
            if (connection.handle === null) {
              yield* transitionToError(
                serviceId,
                connection.discoveryError ?? "integration connect failed"
              )
              return
            }

            yield* transitionToConnected(serviceId, connection)

            const exitCode = yield* Effect.acquireUseRelease(
              Effect.succeed(connection.handle),
              waitForExitWithHealthChecks,
              (handle) =>
                stdioClient.terminate(handle).pipe(
                  Effect.andThen(clearProcessHandle(serviceId))
                )
            )

            yield* transitionToError(serviceId, `integration process exited with code ${exitCode}`)
          })

        const workerLoop = (serviceId: ExternalServiceId) =>
          runWorkerAttempt(serviceId).pipe(
            Effect.andThen(Effect.sleep(RECONNECT_DELAY)),
            Effect.forever
          )

        const connect = Effect.fn("ExternalServiceClientRegistry.connect")(function*(
          request: ExternalServiceConnectRequest
        ) {
          const now = yield* DateTime.now
          const existing = yield* integrationPort.getIntegrationByService(
            request.agentId,
            request.service.serviceId
          )

          const entry: RegistryEntry = {
            integrationId: request.integrationId,
            agentId: request.agentId,
            service: request.service,
            status: "Initializing",
            health: "healthy",
            capabilities: existing?.capabilities ?? [],
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            lastError: null,
            process: null
          }

          yield* setEntry(entry)
          yield* persistEntry(entry)

          if (request.service.transport !== "stdio") {
            yield* transitionToError(
              request.service.serviceId,
              `transport ${request.service.transport} is not supported by stdio integration kernel`
            )
            return
          }

          yield* runtimeSupervisor.start(
            workerKeyForService(request.service.serviceId),
            workerLoop(request.service.serviceId)
          )

          yield* Effect.log("Integration connect scheduled", {
            serviceId: request.service.serviceId,
            integrationId: request.integrationId,
            agentId: request.agentId,
            transport: request.service.transport
          })
        })

        const disconnect = Effect.fn("ExternalServiceClientRegistry.disconnect")(function*(
          serviceId: ExternalServiceId
        ) {
          const entry = yield* withLock(
            Effect.gen(function*() {
              const map = yield* Ref.get(entriesRef)
              return map.get(serviceId) ?? null
            })
          )

          if (entry?.process !== null && entry !== null) {
            yield* stdioClient.terminate(entry.process)
          }

          yield* runtimeSupervisor.stop(workerKeyForService(serviceId))

          if (entry !== null) {
            const now = yield* DateTime.now
            const disconnected: RegistryEntry = {
              ...entry,
              status: "Disconnected",
              process: null,
              updatedAt: now,
              lastError: null
            }
            yield* setEntry(disconnected)
            yield* persistEntry(disconnected)
          }

          yield* Effect.log("Integration disconnected", {
            serviceId,
            integrationId: entry?.integrationId ?? null
          })
        })

        const getStatus: ExternalServiceClientRegistryService["getStatus"] = (integrationId) =>
          Effect.gen(function*() {
            const inMemory = yield* Ref.get(entriesRef).pipe(
              Effect.map((map) => {
                for (const entry of map.values()) {
                  if (entry.integrationId === integrationId) {
                    return toRuntimeStatus(entry)
                  }
                }
                return null
              })
            )

            if (inMemory !== null) {
              return inMemory
            }

            const persisted = yield* integrationPort.getIntegration(integrationId)
            if (persisted === null) {
              return null
            }

            return {
              integrationId: persisted.integrationId,
              agentId: persisted.agentId,
              serviceId: persisted.serviceId,
              status: persisted.status,
              health: persisted.status === "Connected" ? "healthy" : "degraded",
              capabilities: persisted.capabilities,
              pid: null,
              lastError: null,
              updatedAt: persisted.updatedAt
            } satisfies RuntimeIntegrationStatus
          })

        const snapshot: ExternalServiceClientRegistryService["snapshot"] = () =>
          Effect.gen(function*() {
            const entries = yield* Ref.get(entriesRef)
            const integrations = [...entries.values()]
              .map(toRuntimeStatus)
              .sort((left, right) => left.serviceId.localeCompare(right.serviceId))

            return {
              integrations,
              summary: summarizeIntegrations(integrations)
            } satisfies RuntimeIntegrationSnapshot
          })

        const startupAgentId = (
          [...agentConfig.agents.keys()][0] ?? "default"
        ) as AgentId

        yield* Effect.forEach(
          agentConfig.integrations,
          (configured) =>
            Effect.gen(function*() {
              const service = {
                serviceId: configured.serviceId as ExternalServiceId,
                name: configured.name,
                endpoint: configured.endpoint,
                transport: configured.transport,
                identifier: configured.identifier ?? configured.endpoint,
                createdAt: yield* DateTime.now
              } satisfies ExternalServiceRecord

              const existing = yield* integrationPort.getIntegrationByService(
                startupAgentId,
                service.serviceId
              )
              const integrationId = (
                existing?.integrationId ?? `integration:auto:${service.serviceId}`
              ) as IntegrationId

              yield* connect({
                integrationId,
                agentId: startupAgentId,
                service
              })
            }),
          { concurrency: "unbounded", discard: true }
        )

        return {
          connect,
          disconnect,
          getStatus,
          snapshot
        } satisfies ExternalServiceClientRegistryService
      })
    }
  ) {
  static layer = Layer.effect(this, this.make)
}
