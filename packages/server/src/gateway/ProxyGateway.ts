import { Layer } from "effect"
import { EntityProxy, EntityProxyServer } from "effect/unstable/cluster"
import { HttpApi } from "effect/unstable/httpapi"
import { AgentEntity } from "../entities/AgentEntity.js"

// ---------------------------------------------------------------------------
// HttpApi definition — auto-derives endpoints from entity RPCs
// ---------------------------------------------------------------------------

export class ProxyApi extends HttpApi.make("proxy")
  .add(EntityProxy.toHttpApiGroup("agents", AgentEntity).prefix("/agents"))
{}

// ---------------------------------------------------------------------------
// Handler layers — one per entity
// ---------------------------------------------------------------------------

export const ProxyHandlersLive = Layer.mergeAll(
  EntityProxyServer.layerHttpApi(ProxyApi, "agents", AgentEntity)
)
