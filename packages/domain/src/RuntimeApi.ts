import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ClusterEntityError } from "./errors.js"
import { ContentBlock } from "./ports.js"

export class RuntimeStatus extends Schema.Class<RuntimeStatus>("RuntimeStatus")({
  service: Schema.String,
  phase: Schema.String,
  ontologyVersion: Schema.String,
  architectureVersion: Schema.String,
  branch: Schema.String
}) {}

export class CreateSessionRequest extends Schema.Class<CreateSessionRequest>(
  "CreateSessionRequest"
)({
  sessionId: Schema.String,
  conversationId: Schema.String,
  tokenCapacity: Schema.Number
}) {}

export class CreateSessionResponse extends Schema.Class<CreateSessionResponse>(
  "CreateSessionResponse"
)({
  sessionId: Schema.String,
  conversationId: Schema.String,
  tokenCapacity: Schema.Number,
  tokensUsed: Schema.Number
}) {}

export class SubmitTurnRequest extends Schema.Class<SubmitTurnRequest>("SubmitTurnRequest")({
  turnId: Schema.String,
  conversationId: Schema.String,
  agentId: Schema.String,
  content: Schema.String,
  contentBlocks: Schema.Array(ContentBlock),
  createdAt: Schema.DateTimeUtc,
  inputTokens: Schema.Number
}) {}

export class TurnStartedEvent extends Schema.Class<TurnStartedEvent>("TurnStartedEvent")({
  type: Schema.Literal("turn.started"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.DateTimeUtc
}) {}

export class AssistantDeltaEvent extends Schema.Class<AssistantDeltaEvent>("AssistantDeltaEvent")({
  type: Schema.Literal("assistant.delta"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  delta: Schema.String
}) {}

export class ToolCallEvent extends Schema.Class<ToolCallEvent>("ToolCallEvent")({
  type: Schema.Literal("tool.call"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  inputJson: Schema.String
}) {}

export class ToolResultEvent extends Schema.Class<ToolResultEvent>("ToolResultEvent")({
  type: Schema.Literal("tool.result"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  outputJson: Schema.String,
  isError: Schema.Boolean
}) {}

export class TurnCompletedEvent extends Schema.Class<TurnCompletedEvent>(
  "TurnCompletedEvent"
)({
  type: Schema.Literal("turn.completed"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  accepted: Schema.Boolean,
  auditReasonCode: Schema.String,
  modelFinishReason: Schema.Union([Schema.String, Schema.Null]),
  modelUsageJson: Schema.Union([Schema.String, Schema.Null])
}) {}

export class TurnFailedEvent extends Schema.Class<TurnFailedEvent>("TurnFailedEvent")({
  type: Schema.Literal("turn.failed"),
  sequence: Schema.Number,
  turnId: Schema.String,
  sessionId: Schema.String,
  errorCode: Schema.String,
  message: Schema.String
}) {}

export const TurnStreamEvent = Schema.Union([
  TurnStartedEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnCompletedEvent,
  TurnFailedEvent
])
export type TurnStreamEvent = typeof TurnStreamEvent.Type

export class RuntimeApiGroup extends HttpApiGroup.make("runtime")
  .add(HttpApiEndpoint.get("getStatus", "/status", {
    success: RuntimeStatus,
    error: ClusterEntityError
  }))
  .add(HttpApiEndpoint.post("createSession", "/sessions", {
    payload: CreateSessionRequest,
    success: CreateSessionResponse,
    error: ClusterEntityError
  }))
{}

export class RuntimeApi extends HttpApi.make("api").add(RuntimeApiGroup) {}
