import { DateTime, Effect, Layer, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { ContextWindowExceeded, SessionNotFound } from "../../domain/src/errors.js"
import type { SessionId, TurnId } from "../../domain/src/ids.js"
import type { Instant, SessionState, SessionTurnPort, TurnRecord } from "../../domain/src/ports.js"

interface SessionRow {
  readonly session_id: string
  readonly conversation_id: string
  readonly token_capacity: number
  readonly tokens_used: number
}

interface TurnRow {
  readonly turn_id: string
  readonly session_id: string
  readonly conversation_id: string
  readonly agent_id: string
  readonly content: string
  readonly created_at: string
}

export class SessionTurnPortSqlite extends ServiceMap.Service<SessionTurnPortSqlite>()(
  "server/SessionTurnPortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const startSession: SessionTurnPort["startSession"] = (state) =>
        sql`
          INSERT INTO sessions (
            session_id,
            conversation_id,
            token_capacity,
            tokens_used,
            updated_at
          ) VALUES (
            ${state.sessionId},
            ${state.conversationId},
            ${state.tokenCapacity},
            ${state.tokensUsed},
            CURRENT_TIMESTAMP
          )
          ON CONFLICT(session_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            token_capacity = excluded.token_capacity,
            tokens_used = excluded.tokens_used,
            updated_at = CURRENT_TIMESTAMP
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.orDie
        )

      const appendTurn: SessionTurnPort["appendTurn"] = (turn) =>
        sql`
          INSERT OR IGNORE INTO turns (
            turn_id,
            session_id,
            conversation_id,
            agent_id,
            content,
            created_at
          ) VALUES (
            ${turn.turnId},
            ${turn.sessionId},
            ${turn.conversationId},
            ${turn.agentId},
            ${turn.content},
            ${toSqlInstant(turn.createdAt)}
          )
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.orDie
        )

      const updateContextWindow: SessionTurnPort["updateContextWindow"] = (
        sessionId,
        deltaTokens
      ) =>
        sql.withTransaction(
          Effect.gen(function*() {
            const current = yield* readSession(sql, sessionId)
            if (current === null) {
              return yield* new SessionNotFound({ sessionId })
            }

            const attemptedTokensUsed = Math.max(current.tokensUsed + deltaTokens, 0)
            if (attemptedTokensUsed > current.tokenCapacity) {
              return yield* new ContextWindowExceeded({
                sessionId,
                tokenCapacity: current.tokenCapacity,
                attemptedTokensUsed
              })
            }

            yield* sql`
              UPDATE sessions
              SET
                tokens_used = ${attemptedTokensUsed},
                updated_at = CURRENT_TIMESTAMP
              WHERE session_id = ${sessionId}
            `.unprepared
          })
        ).pipe(
          Effect.asVoid,
          Effect.catch((error: unknown) =>
            error instanceof SessionNotFound || error instanceof ContextWindowExceeded
              ? Effect.fail(error)
              : Effect.die(error)
          )
        )

      const getSession = (sessionId: SessionId) =>
        readSession(sql, sessionId).pipe(
          Effect.map((state) => state === null ? null : state),
          Effect.orDie
        )

      const listTurns = (sessionId: SessionId) =>
        sql<TurnRow>`
          SELECT
            turn_id,
            session_id,
            conversation_id,
            agent_id,
            content,
            created_at
          FROM turns
          WHERE session_id = ${sessionId}
          ORDER BY created_at ASC, turn_id ASC
        `.withoutTransform.pipe(
          Effect.map((rows) => rows.map(decodeTurnRow)),
          Effect.orDie
        )

      return {
        startSession,
        appendTurn,
        updateContextWindow,
        getSession,
        listTurns
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const readSession = (sql: SqlClient.SqlClient, sessionId: SessionId) =>
  sql<SessionRow>`
    SELECT
      session_id,
      conversation_id,
      token_capacity,
      tokens_used
    FROM sessions
    WHERE session_id = ${sessionId}
    LIMIT 1
  `.withoutTransform.pipe(
    Effect.map((rows) => rows[0] === undefined ? null : decodeSessionRow(rows[0]))
  )

const decodeSessionRow = (row: SessionRow): SessionState => ({
  sessionId: row.session_id as SessionId,
  conversationId: row.conversation_id as SessionState["conversationId"],
  tokenCapacity: row.token_capacity,
  tokensUsed: row.tokens_used
})

const decodeTurnRow = (row: TurnRow): TurnRecord => ({
  turnId: row.turn_id as TurnId,
  sessionId: row.session_id as TurnRecord["sessionId"],
  conversationId: row.conversation_id as TurnRecord["conversationId"],
  agentId: row.agent_id as TurnRecord["agentId"],
  content: row.content,
  createdAt: fromRequiredSqlInstant(row.created_at)
})

const toSqlInstant = (instant: Instant): string => DateTime.formatIso(instant)

const fromRequiredSqlInstant = (value: string): Instant => DateTime.fromDateUnsafe(new Date(value))
