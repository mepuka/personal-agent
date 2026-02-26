/**
 * Shared RPC definitions for channel adapter entities.
 *
 * Both CLIAdapterEntity and WebChatAdapterEntity consume these RPCs so that
 * any client can talk to any adapter through a single, consistent contract.
 */
import { ChannelNotFound } from "@template/domain/errors"
import { TurnStreamEvent } from "@template/domain/events"
import { TurnRecord } from "@template/domain/ports"
import { ChannelCapability, ChannelType } from "@template/domain/status"
import { Schema } from "effect"
import { ClusterSchema } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { TurnProcessingError } from "../turn/TurnProcessingWorkflow.js"

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

/** Status snapshot returned by `GetStatusRpc`. */
export const ChannelStatusSchema = Schema.Struct({
  channelId: Schema.String,
  channelType: ChannelType,
  capabilities: Schema.Array(ChannelCapability),
  activeSessionId: Schema.String,
  activeConversationId: Schema.String,
  createdAt: Schema.DateTimeUtcFromString
})

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

/**
 * One-time channel bootstrap. Persisted and idempotent — safe to replay.
 *
 * Payload carries the `agentId` and desired `channelType` so the adapter can
 * create the underlying channel, session, and conversation records.
 */
export const InitializeRpc = Rpc.make("initialize", {
  payload: {
    channelType: ChannelType,
    agentId: Schema.String
  },
  success: Schema.Void,
  primaryKey: ({ agentId }) => `initialize:${agentId}`
}).annotate(ClusterSchema.Persisted, true)

/**
 * Send user content and receive a streaming sequence of `TurnStreamEvent`s.
 */
export const ReceiveMessageRpc = Rpc.make("receiveMessage", {
  payload: {
    content: Schema.String
  },
  success: TurnStreamEvent,
  error: Schema.Union([ChannelNotFound, TurnProcessingError]),
  stream: true
})

/**
 * Retrieve the full turn history for the channel's active session.
 */
export const GetHistoryRpc = Rpc.make("getHistory", {
  payload: {},
  success: Schema.Array(TurnRecord),
  error: ChannelNotFound
})

/**
 * Return a point-in-time status snapshot for the channel.
 */
export const GetStatusRpc = Rpc.make("getStatus", {
  payload: {},
  success: ChannelStatusSchema,
  error: ChannelNotFound
})
