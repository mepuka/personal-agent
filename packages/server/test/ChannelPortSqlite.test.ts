import { describe, expect, it } from "@effect/vitest"
import type { AgentId, ChannelId, ConversationId, SessionId } from "@template/domain/ids"
import type { ChannelRecord, Instant } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChannelPortSqlite } from "../src/ChannelPortSqlite.js"
import * as DomainMigrator from "../src/persistence/DomainMigrator.js"
import * as SqliteRuntime from "../src/persistence/SqliteRuntime.js"

describe("ChannelPortSqlite", () => {
  it.effect("get returns null for unknown channel", () => {
    const dbPath = testDatabasePath("channel-null")
    return Effect.gen(function*() {
      const port = yield* ChannelPortSqlite
      const result = yield* port.get("channel:missing" as ChannelId)
      expect(result).toBeNull()
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("create + get roundtrip", () => {
    const dbPath = testDatabasePath("channel-roundtrip")
    return Effect.gen(function*() {
      const port = yield* ChannelPortSqlite
      const now = instant("2026-02-24T12:00:00.000Z")

      const channel: ChannelRecord = {
        channelId: "channel:cli-1" as ChannelId,
        channelType: "CLI",
        agentId: "agent:test" as AgentId,
        activeSessionId: "session:s1" as SessionId,
        activeConversationId: "conv:c1" as ConversationId,
        createdAt: now
      }

      yield* port.create(channel)
      const result = yield* port.get(channel.channelId)

      expect(result).not.toBeNull()
      expect(result!.channelId).toBe("channel:cli-1")
      expect(result!.channelType).toBe("CLI")
      expect(result!.agentId).toBe("agent:test")
      expect(result!.activeSessionId).toBe("session:s1")
      expect(result!.activeConversationId).toBe("conv:c1")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("create is idempotent (upsert)", () => {
    const dbPath = testDatabasePath("channel-upsert")
    return Effect.gen(function*() {
      const port = yield* ChannelPortSqlite
      const now = instant("2026-02-24T12:00:00.000Z")

      const channel: ChannelRecord = {
        channelId: "channel:cli-2" as ChannelId,
        channelType: "CLI",
        agentId: "agent:test" as AgentId,
        activeSessionId: "session:s1" as SessionId,
        activeConversationId: "conv:c1" as ConversationId,
        createdAt: now
      }

      yield* port.create(channel)

      // Upsert with updated session
      const updated: ChannelRecord = {
        ...channel,
        activeSessionId: "session:s2" as SessionId,
        activeConversationId: "conv:c2" as ConversationId
      }
      yield* port.create(updated)

      const result = yield* port.get(channel.channelId)
      expect(result).not.toBeNull()
      expect(result!.activeSessionId).toBe("session:s2")
      expect(result!.activeConversationId).toBe("conv:c2")
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })
})

const makeTestLayer = (dbPath: string) => {
  const sqliteLayer = SqliteRuntime.layer({ filename: dbPath })
  const migrationLayer = DomainMigrator.layer.pipe(Layer.provide(sqliteLayer), Layer.orDie)
  const sqlInfrastructureLayer = Layer.mergeAll(sqliteLayer, migrationLayer)

  return ChannelPortSqlite.layer.pipe(
    Layer.provide(sqlInfrastructureLayer)
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const testDatabasePath = (name: string): string =>
  join(tmpdir(), `personal-agent-${name}-${crypto.randomUUID()}.sqlite`)

const cleanupDatabase = (path: string) =>
  Effect.sync(() => {
    rmSync(path, { force: true })
  })
