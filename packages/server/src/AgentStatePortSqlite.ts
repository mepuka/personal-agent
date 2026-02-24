import { DateTime, Effect, Layer, ServiceMap } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { TokenBudgetExceeded } from "../../domain/src/errors.js"
import type { AgentId } from "../../domain/src/ids.js"
import type { AgentState, AgentStatePort, Instant } from "../../domain/src/ports.js"

interface AgentStateRow {
  readonly agent_id: string
  readonly permission_mode: AgentState["permissionMode"]
  readonly token_budget: number
  readonly quota_period: AgentState["quotaPeriod"]
  readonly tokens_consumed: number
  readonly budget_reset_at: string | null
}

export class AgentStatePortSqlite extends ServiceMap.Service<AgentStatePortSqlite>()(
  "server/AgentStatePortSqlite",
  {
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const get: AgentStatePort["get"] = (agentId) =>
        readAgentState(sql, agentId).pipe(
          Effect.map((state) => state === null ? null : state),
          Effect.orDie
        )

      const upsert: AgentStatePort["upsert"] = (agentState) =>
        sql`
          INSERT INTO agents (
            agent_id,
            permission_mode,
            token_budget,
            quota_period,
            tokens_consumed,
            budget_reset_at,
            updated_at
          ) VALUES (
            ${agentState.agentId},
            ${agentState.permissionMode},
            ${agentState.tokenBudget},
            ${agentState.quotaPeriod},
            ${agentState.tokensConsumed},
            ${toSqlInstant(agentState.budgetResetAt)},
            CURRENT_TIMESTAMP
          )
          ON CONFLICT(agent_id) DO UPDATE SET
            permission_mode = excluded.permission_mode,
            token_budget = excluded.token_budget,
            quota_period = excluded.quota_period,
            tokens_consumed = excluded.tokens_consumed,
            budget_reset_at = excluded.budget_reset_at,
            updated_at = CURRENT_TIMESTAMP
        `.unprepared.pipe(
          Effect.asVoid,
          Effect.orDie
        )

      const consumeTokenBudget: AgentStatePort["consumeTokenBudget"] = (agentId, requestedTokens, now) =>
        sql.withTransaction(
          Effect.gen(function*() {
            const existing = yield* readAgentState(sql, agentId)
            if (existing === null) {
              return yield* new TokenBudgetExceeded({
                agentId,
                requestedTokens,
                remainingTokens: 0
              })
            }

            const normalized = normalizeBudgetWindow(existing, now)
            const remainingTokens = Math.max(
              normalized.tokenBudget - normalized.tokensConsumed,
              0
            )
            if (requestedTokens > remainingTokens) {
              return yield* new TokenBudgetExceeded({
                agentId,
                requestedTokens,
                remainingTokens
              })
            }

            const updated: AgentState = {
              ...normalized,
              tokensConsumed: normalized.tokensConsumed + requestedTokens
            }

            yield* sql`
              UPDATE agents
              SET
                permission_mode = ${updated.permissionMode},
                token_budget = ${updated.tokenBudget},
                quota_period = ${updated.quotaPeriod},
                tokens_consumed = ${updated.tokensConsumed},
                budget_reset_at = ${toSqlInstant(updated.budgetResetAt)},
                updated_at = CURRENT_TIMESTAMP
              WHERE agent_id = ${updated.agentId}
            `.unprepared
          })
        ).pipe(
          Effect.asVoid,
          Effect.catch((error: unknown) =>
            error instanceof TokenBudgetExceeded
              ? Effect.fail(error)
              : Effect.die(error)
          )
        )

      const listAgentStates = () =>
        sql<AgentStateRow>`
          SELECT
            agent_id,
            permission_mode,
            token_budget,
            quota_period,
            tokens_consumed,
            budget_reset_at
          FROM agents
          ORDER BY agent_id ASC
        `.withoutTransform.pipe(
          Effect.map((rows) => rows.map(decodeAgentStateRow)),
          Effect.orDie
        )

      return {
        get,
        upsert,
        consumeTokenBudget,
        listAgentStates
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const readAgentState = (
  sql: SqlClient.SqlClient,
  agentId: AgentId
) =>
  sql<AgentStateRow>`
    SELECT
      agent_id,
      permission_mode,
      token_budget,
      quota_period,
      tokens_consumed,
      budget_reset_at
    FROM agents
    WHERE agent_id = ${agentId}
    LIMIT 1
  `.withoutTransform.pipe(
    Effect.map((rows) => rows[0] === undefined ? null : decodeAgentStateRow(rows[0]))
  )

const decodeAgentStateRow = (row: AgentStateRow): AgentState => ({
  agentId: row.agent_id as AgentId,
  permissionMode: row.permission_mode,
  tokenBudget: row.token_budget,
  quotaPeriod: row.quota_period,
  tokensConsumed: row.tokens_consumed,
  budgetResetAt: fromSqlInstant(row.budget_reset_at)
})

const normalizeBudgetWindow = (state: AgentState, now: Instant): AgentState => {
  if (state.quotaPeriod === "Lifetime") {
    return state
  }

  if (state.budgetResetAt === null) {
    return {
      ...state,
      budgetResetAt: nextBudgetReset(now, state.quotaPeriod)
    }
  }

  if (DateTime.toEpochMillis(now) < DateTime.toEpochMillis(state.budgetResetAt)) {
    return state
  }

  return {
    ...state,
    tokensConsumed: 0,
    budgetResetAt: nextBudgetReset(now, state.quotaPeriod)
  }
}

const nextBudgetReset = (from: Instant, period: AgentState["quotaPeriod"]): Instant | null => {
  switch (period) {
    case "Daily": {
      return DateTime.add(from, { days: 1 })
    }
    case "Monthly": {
      return DateTime.add(from, { months: 1 })
    }
    case "Yearly": {
      return DateTime.add(from, { years: 1 })
    }
    case "Lifetime": {
      return null
    }
  }
}

const fromSqlInstant = (value: string | null): Instant | null =>
  value === null ? null : DateTime.fromDateUnsafe(new Date(value))

const toSqlInstant = (instant: Instant | null): string | null => instant === null ? null : DateTime.formatIso(instant)
