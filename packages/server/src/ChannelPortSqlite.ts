import { GenerationConfigOverrideSchema, ModelOverrideSchema } from "@template/domain/config"
import { Effect, Layer, Option, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type { AgentId, ChannelId, ConversationId, SessionId } from "../../domain/src/ids.js"
import type { ChannelPort, ChannelRecord, ChannelSummaryRecord } from "../../domain/src/ports.js"
import { ChannelCapability, ChannelType } from "../../domain/src/status.js"

const ChannelRowSchema = Schema.Struct({
  channel_id: Schema.String,
  channel_type: ChannelType,
  agent_id: Schema.String,
  active_session_id: Schema.String,
  active_conversation_id: Schema.String,
  capabilities_json: Schema.String,
  model_override_json: Schema.Union([Schema.String, Schema.Null]),
  generation_config_override_json: Schema.Union([Schema.String, Schema.Null]),
  created_at: Schema.String
})
type ChannelRow = typeof ChannelRowSchema.Type

const ChannelSummaryRowSchema = Schema.Struct({
  channel_id: Schema.String,
  channel_type: ChannelType,
  agent_id: Schema.String,
  active_session_id: Schema.String,
  active_conversation_id: Schema.String,
  created_at: Schema.String,
  last_turn_at: Schema.Union([Schema.String, Schema.Null]),
  message_count: Schema.Number
})
type ChannelSummaryRow = typeof ChannelSummaryRowSchema.Type

const ChannelIdRequest = Schema.Struct({ channelId: Schema.String })
const CapabilitiesFromJsonString = Schema.fromJsonString(Schema.Array(ChannelCapability))
const ModelOverrideFromJsonString = Schema.fromJsonString(ModelOverrideSchema)
const GenerationConfigOverrideFromJsonString = Schema.fromJsonString(GenerationConfigOverrideSchema)
const InstantFromSqlString = Schema.DateTimeUtcFromString
const decodeCapabilitiesJson = Schema.decodeUnknownSync(CapabilitiesFromJsonString)
const encodeCapabilitiesJson = Schema.encodeSync(CapabilitiesFromJsonString)
const decodeModelOverrideJson = Schema.decodeUnknownSync(ModelOverrideFromJsonString)
const encodeModelOverrideJson = Schema.encodeSync(ModelOverrideFromJsonString)
const decodeGenerationConfigOverrideJson = Schema.decodeUnknownSync(GenerationConfigOverrideFromJsonString)
const encodeGenerationConfigOverrideJson = Schema.encodeSync(GenerationConfigOverrideFromJsonString)
const decodeSqlInstant = Schema.decodeUnknownSync(InstantFromSqlString)
const encodeSqlInstant = Schema.encodeSync(InstantFromSqlString)

export class ChannelPortSqlite extends ServiceMap.Service<ChannelPortSqlite>()(
  "server/ChannelPortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const findChannelById = SqlSchema.findOneOption({
        Request: ChannelIdRequest,
        Result: ChannelRowSchema,
        execute: ({ channelId }) =>
          sql`
            SELECT
              channel_id,
              channel_type,
              agent_id,
              active_session_id,
              active_conversation_id,
              capabilities_json,
              model_override_json,
              generation_config_override_json,
              created_at
            FROM channels
            WHERE channel_id = ${channelId}
            LIMIT 1
          `.withoutTransform
      })

      const get: ChannelPort["get"] = (channelId) =>
        findChannelById({ channelId }).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: decodeChannelRow
            })
          ),
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const list: ChannelPort["list"] = (query) =>
        Effect.gen(function*() {
          const rows = query?.agentId
            ? yield* sql`
                SELECT
                  c.channel_id,
                  c.channel_type,
                  c.agent_id,
                  c.active_session_id,
                  c.active_conversation_id,
                  c.created_at,
                  MAX(t.created_at) AS last_turn_at,
                  COALESCE(COUNT(t.turn_id), 0) AS message_count
                FROM channels c
                LEFT JOIN turns t ON t.session_id = c.active_session_id
                WHERE c.agent_id = ${query.agentId}
                GROUP BY
                  c.channel_id,
                  c.channel_type,
                  c.agent_id,
                  c.active_session_id,
                  c.active_conversation_id,
                  c.created_at
                ORDER BY
                  COALESCE(MAX(t.created_at), c.created_at) DESC,
                  c.created_at DESC
              `.withoutTransform
            : yield* sql`
                SELECT
                  c.channel_id,
                  c.channel_type,
                  c.agent_id,
                  c.active_session_id,
                  c.active_conversation_id,
                  c.created_at,
                  MAX(t.created_at) AS last_turn_at,
                  COALESCE(COUNT(t.turn_id), 0) AS message_count
                FROM channels c
                LEFT JOIN turns t ON t.session_id = c.active_session_id
                GROUP BY
                  c.channel_id,
                  c.channel_type,
                  c.agent_id,
                  c.active_session_id,
                  c.active_conversation_id,
                  c.created_at
                ORDER BY
                  COALESCE(MAX(t.created_at), c.created_at) DESC,
                  c.created_at DESC
              `.withoutTransform

          return rows.map((row: any) => {
            const decoded = Schema.decodeUnknownSync(ChannelSummaryRowSchema)(row)
            return decodeChannelSummaryRow(decoded)
          })
        }).pipe(
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const create: ChannelPort["create"] = (channel) =>
        sql`
          INSERT INTO channels (
            channel_id,
            channel_type,
            agent_id,
            active_session_id,
            active_conversation_id,
            capabilities_json,
            model_override_json,
            generation_config_override_json,
            created_at
          ) VALUES (
            ${channel.channelId},
            ${channel.channelType},
            ${channel.agentId},
            ${channel.activeSessionId},
            ${channel.activeConversationId},
            ${encodeCapabilitiesJson(channel.capabilities)},
            ${channel.modelOverride ? encodeModelOverrideJson(channel.modelOverride) : null},
            ${channel.generationConfigOverride ? encodeGenerationConfigOverrideJson(channel.generationConfigOverride) : null},
            ${encodeSqlInstant(channel.createdAt)}
          )
          ON CONFLICT(channel_id) DO UPDATE SET
            channel_type = excluded.channel_type,
            agent_id = excluded.agent_id,
            active_session_id = excluded.active_session_id,
            active_conversation_id = excluded.active_conversation_id,
            capabilities_json = excluded.capabilities_json
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const deleteChannel: ChannelPort["delete"] = (channelId) =>
        sql`
          DELETE FROM channels
          WHERE channel_id = ${channelId}
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      const updateModelPreference: ChannelPort["updateModelPreference"] = (channelId, update) =>
        Effect.gen(function*() {
          if ("modelOverride" in update && "generationConfigOverride" in update) {
            yield* sql`
              UPDATE channels SET
                model_override_json = ${update.modelOverride ? encodeModelOverrideJson(update.modelOverride) : null},
                generation_config_override_json = ${update.generationConfigOverride ? encodeGenerationConfigOverrideJson(update.generationConfigOverride) : null}
              WHERE channel_id = ${channelId}
            `.unprepared
          } else if ("modelOverride" in update) {
            yield* sql`
              UPDATE channels SET
                model_override_json = ${update.modelOverride ? encodeModelOverrideJson(update.modelOverride) : null}
              WHERE channel_id = ${channelId}
            `.unprepared
          } else if ("generationConfigOverride" in update) {
            yield* sql`
              UPDATE channels SET
                generation_config_override_json = ${update.generationConfigOverride ? encodeGenerationConfigOverrideJson(update.generationConfigOverride) : null}
              WHERE channel_id = ${channelId}
            `.unprepared
          }
        }).pipe(
          Effect.asVoid,
          Effect.tapDefect(Effect.logError),
          Effect.orDie
        )

      return {
        get,
        list,
        create,
        delete: deleteChannel,
        updateModelPreference
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const decodeChannelRow = (row: ChannelRow): ChannelRecord => ({
  channelId: row.channel_id as ChannelId,
  channelType: row.channel_type,
  agentId: row.agent_id as AgentId,
  activeSessionId: row.active_session_id as SessionId,
  activeConversationId: row.active_conversation_id as ConversationId,
  capabilities: decodeCapabilitiesJson(row.capabilities_json),
  modelOverride: row.model_override_json ? decodeModelOverrideJson(row.model_override_json) : null,
  generationConfigOverride: row.generation_config_override_json
    ? decodeGenerationConfigOverrideJson(row.generation_config_override_json)
    : null,
  createdAt: decodeSqlInstant(row.created_at)
})

const decodeChannelSummaryRow = (row: ChannelSummaryRow): ChannelSummaryRecord => ({
  channelId: row.channel_id as ChannelSummaryRecord["channelId"],
  channelType: row.channel_type,
  agentId: row.agent_id as ChannelSummaryRecord["agentId"],
  activeSessionId: row.active_session_id as ChannelSummaryRecord["activeSessionId"],
  activeConversationId: row.active_conversation_id as ChannelSummaryRecord["activeConversationId"],
  createdAt: decodeSqlInstant(row.created_at),
  lastTurnAt: row.last_turn_at ? decodeSqlInstant(row.last_turn_at) : null,
  messageCount: row.message_count
})
