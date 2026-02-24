import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

export class RuntimeStatus extends Schema.Class<RuntimeStatus>("RuntimeStatus")({
  service: Schema.String,
  phase: Schema.String,
  ontologyVersion: Schema.String,
  architectureVersion: Schema.String,
  branch: Schema.String
}) {}

export class RuntimeApiGroup extends HttpApiGroup.make("runtime")
  .add(HttpApiEndpoint.get("getStatus", "/status", {
    success: RuntimeStatus
  }))
{}

export class RuntimeApi extends HttpApi.make("api").add(RuntimeApiGroup) {}
