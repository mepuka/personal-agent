import { IntegrationNotFound } from "@template/domain/errors"
import type { AgentId, ExternalServiceId, IntegrationId } from "@template/domain/ids"
import { ServiceCapability } from "@template/domain/integration"
import type { ExternalServiceRecord, IntegrationRecord } from "@template/domain/integration"
import { DateTime, Effect, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { AgentConfig } from "../ai/AgentConfig.js"
import { IntegrationPortTag } from "../PortTags.js"

const ConnectRpc = Rpc.make("connect", {
  payload: {
    serviceId: Schema.String,
    name: Schema.String,
    endpoint: Schema.String,
    transport: Schema.Literals(["stdio", "sse", "http"]),
    identifier: Schema.optional(Schema.String)
  },
  success: Schema.Void,
  primaryKey: ({ serviceId }) => `connect:${serviceId}`
}).annotate(ClusterSchema.Persisted, true)

const DisconnectRpc = Rpc.make("disconnect", {
  payload: {},
  success: Schema.Void,
  error: IntegrationNotFound
})

const GetStatusRpc = Rpc.make("getIntegrationStatus", {
  payload: {},
  success: Schema.Struct({
    integrationId: Schema.String,
    serviceId: Schema.String,
    status: Schema.String,
    capabilities: Schema.Array(ServiceCapability)
  }),
  error: IntegrationNotFound
})

export const IntegrationEntity = Entity.make("Integration", [
  ConnectRpc,
  DisconnectRpc,
  GetStatusRpc
])

export const layer = IntegrationEntity.toLayer(Effect.gen(function*() {
  const integrationPort = yield* IntegrationPortTag
  const agentConfig = yield* AgentConfig

  return {
    connect: (request) =>
      Effect.gen(function*() {
        const integrationId = String(request.address.entityId) as IntegrationId
        // Derive agentId from config — agent map keys are identifiers
        const agentKeys = [...agentConfig.agents.keys()]
        const firstKey = agentKeys[0]
        const agentId = (firstKey ? `agent:${firstKey}` : "agent:bootstrap") as AgentId
        const now = yield* DateTime.now

        // Create or upsert the external service record
        const serviceId = request.payload.serviceId as ExternalServiceId
        const serviceRecord = {
          serviceId,
          name: request.payload.name,
          endpoint: request.payload.endpoint,
          transport: request.payload.transport,
          identifier: request.payload.identifier ?? request.payload.endpoint,
          createdAt: now
        } as ExternalServiceRecord

        yield* integrationPort.createService(serviceRecord)

        // Create the integration record with status "Connected" (skeleton)
        const integrationRecord = {
          integrationId,
          agentId,
          serviceId,
          status: "Connected" as const,
          capabilities: [] as ReadonlyArray<ServiceCapability>,
          createdAt: now,
          updatedAt: now
        } as IntegrationRecord

        yield* integrationPort.createIntegration(integrationRecord)
      }).pipe(
        Effect.withSpan("IntegrationEntity.connect"),
        Effect.annotateLogs({ module: "IntegrationEntity", entityId: request.address.entityId })
      ),

    disconnect: (request) =>
      Effect.gen(function*() {
        const integrationId = String(request.address.entityId) as IntegrationId
        const existing = yield* integrationPort.getIntegration(integrationId)
        if (existing === null) {
          return yield* new IntegrationNotFound({ integrationId })
        }
        yield* integrationPort.updateStatus(integrationId, "Disconnected")
      }).pipe(
        Effect.withSpan("IntegrationEntity.disconnect"),
        Effect.annotateLogs({ module: "IntegrationEntity", entityId: request.address.entityId })
      ),

    getIntegrationStatus: (request) =>
      Effect.gen(function*() {
        const integrationId = String(request.address.entityId) as IntegrationId
        const integration = yield* integrationPort.getIntegration(integrationId)
        if (integration === null) {
          return yield* new IntegrationNotFound({ integrationId })
        }
        return {
          integrationId: integration.integrationId,
          serviceId: integration.serviceId,
          status: integration.status,
          capabilities: [...integration.capabilities]
        }
      }).pipe(
        Effect.withSpan("IntegrationEntity.getIntegrationStatus"),
        Effect.annotateLogs({ module: "IntegrationEntity", entityId: request.address.entityId })
      )
  }
}))
