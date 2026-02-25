import { Effect, Layer, Option, Schema, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type { AgentId, ChannelId, ConversationId, SessionId } from "../../domain/src/ids.js"
import type { ChannelPort, ChannelRecord } from "../../domain/src/ports.js"
import { ChannelType } from "../../domain/src/status.js"

const ChannelRowSchema = Schema.Struct({
  channel_id: Schema.String,
  channel_type: ChannelType,
  agent_id: Schema.String,
  active_session_id: Schema.String,
  active_conversation_id: Schema.String,
  created_at: Schema.String
})
type ChannelRow = typeof ChannelRowSchema.Type

const ChannelIdRequest = Schema.Struct({ channelId: Schema.String })
const InstantFromSqlString = Schema.DateTimeUtcFromString
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
            created_at
          ) VALUES (
            ${channel.channelId},
            ${channel.channelType},
            ${channel.agentId},
            ${channel.activeSessionId},
            ${channel.activeConversationId},
            ${encodeSqlInstant(channel.createdAt)}
          )
          ON CONFLICT(channel_id) DO UPDATE SET
            channel_type = excluded.channel_type,
            agent_id = excluded.agent_id,
            active_session_id = excluded.active_session_id,
            active_conversation_id = excluded.active_conversation_id
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.orDie
        )

      return {
        get,
        create
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
  createdAt: decodeSqlInstant(row.created_at)
})
