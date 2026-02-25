import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const loader = SqliteMigrator.fromRecord({
  "0001_domain_tables": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS schedules (
        schedule_id TEXT PRIMARY KEY,
        owner_agent_id TEXT NOT NULL,
        recurrence_label TEXT NOT NULL,
        cron_expression TEXT,
        interval_seconds INTEGER,
        trigger_tag TEXT NOT NULL,
        action_ref TEXT NOT NULL,
        schedule_status TEXT NOT NULL,
        concurrency_policy TEXT NOT NULL,
        allows_catch_up INTEGER NOT NULL,
        auto_disable_after_run INTEGER NOT NULL,
        catch_up_window_seconds INTEGER NOT NULL,
        max_catch_up_runs_per_tick INTEGER NOT NULL,
        last_execution_at TEXT,
        next_execution_at TEXT
      )
    `.unprepared

    yield* sql`
      CREATE INDEX IF NOT EXISTS schedules_next_execution_idx
      ON schedules (schedule_status, next_execution_at)
    `.unprepared

    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_executions (
        execution_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        due_at TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        outcome TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        skip_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `.unprepared

    yield* sql`
      CREATE INDEX IF NOT EXISTS scheduled_executions_schedule_id_idx
      ON scheduled_executions (schedule_id, created_at)
    `.unprepared

    yield* sql`
      CREATE TABLE IF NOT EXISTS audit_entries (
        audit_entry_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `.unprepared
  }),
  "0002_core_phase1_tables": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        permission_mode TEXT NOT NULL,
        token_budget INTEGER NOT NULL,
        quota_period TEXT NOT NULL,
        tokens_consumed INTEGER NOT NULL DEFAULT 0,
        budget_reset_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `.unprepared

    yield* sql`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        token_capacity INTEGER NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `.unprepared

    yield* sql`
      CREATE INDEX IF NOT EXISTS sessions_conversation_id_idx
      ON sessions (conversation_id)
    `.unprepared

    yield* sql`
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        participant_role TEXT NOT NULL,
        participant_agent_id TEXT,
        message_id TEXT NOT NULL,
        message_content TEXT NOT NULL,
        content_blocks_json TEXT NOT NULL,
        model_finish_reason TEXT,
        model_usage_json TEXT,
        created_at TEXT NOT NULL
      )
    `.unprepared

    yield* sql`
      CREATE INDEX IF NOT EXISTS turns_session_created_at_idx
      ON turns (session_id, created_at)
    `.unprepared

    yield* sql`
      CREATE UNIQUE INDEX IF NOT EXISTS turns_session_turn_index_idx
      ON turns (session_id, turn_index)
    `.unprepared
  }),
  "0003_channel_tables": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        active_session_id TEXT NOT NULL,
        active_conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `.unprepared
  }),
  "0004_memory_tables": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS memory_items (
        memory_item_id    TEXT PRIMARY KEY,
        agent_id          TEXT NOT NULL,
        tier              TEXT NOT NULL CHECK (tier IN ('SemanticMemory', 'EpisodicMemory')),
        scope             TEXT NOT NULL CHECK (scope IN ('SessionScope', 'ProjectScope', 'GlobalScope')),
        source            TEXT NOT NULL CHECK (source IN ('UserSource', 'SystemSource', 'AgentSource')),
        content           TEXT NOT NULL,
        metadata_json     TEXT,
        generated_by_turn_id TEXT,
        session_id        TEXT,
        sensitivity       TEXT NOT NULL DEFAULT 'Internal'
                          CHECK (sensitivity IN ('Public', 'Internal', 'Confidential', 'Restricted')),
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      )
    `.unprepared

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_memory_items_agent_tier
      ON memory_items(agent_id, tier)
    `.unprepared

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_memory_items_agent_scope
      ON memory_items(agent_id, scope)
    `.unprepared
  })
})

export const run = SqliteMigrator.run({ loader })

export const layer = SqliteMigrator.layer({ loader })
