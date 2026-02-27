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

const makeChannel = (overrides: Partial<ChannelRecord> = {}): ChannelRecord => ({
  channelId: "channel:test" as ChannelId,
  channelType: "CLI",
  agentId: "agent:test" as AgentId,
  activeSessionId: "session:s1" as SessionId,
  activeConversationId: "conv:c1" as ConversationId,
  capabilities: ["SendText"],
  modelOverride: null,
  generationConfigOverride: null,
  createdAt: instant("2026-02-24T12:00:00.000Z"),
  ...overrides
})

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

      const channel = makeChannel({ channelId: "channel:cli-1" as ChannelId })

      yield* port.create(channel)
      const result = yield* port.get(channel.channelId)

      expect(result).not.toBeNull()
      expect(result!.channelId).toBe("channel:cli-1")
      expect(result!.channelType).toBe("CLI")
      expect(result!.agentId).toBe("agent:test")
      expect(result!.activeSessionId).toBe("session:s1")
      expect(result!.activeConversationId).toBe("conv:c1")
      expect(result!.capabilities).toEqual(["SendText"])
      expect(result!.modelOverride).toBeNull()
      expect(result!.generationConfigOverride).toBeNull()
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("roundtrips multiple capabilities", () => {
    const dbPath = testDatabasePath("channel-multi-cap")
    return Effect.gen(function*() {
      const port = yield* ChannelPortSqlite

      const channel = makeChannel({
        channelId: "channel:webchat-1" as ChannelId,
        channelType: "WebChat",
        capabilities: ["SendText", "Typing", "StreamingDelivery"]
      })

      yield* port.create(channel)
      const result = yield* port.get(channel.channelId)

      expect(result).not.toBeNull()
      expect(result!.capabilities).toEqual(["SendText", "Typing", "StreamingDelivery"])
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("create is idempotent (upsert)", () => {
    const dbPath = testDatabasePath("channel-upsert")
    return Effect.gen(function*() {
      const port = yield* ChannelPortSqlite

      const channel = makeChannel({ channelId: "channel:cli-2" as ChannelId })

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

  it.effect("updateModelPreference round-trips JSON correctly", () => {
    const dbPath = testDatabasePath("channel-model-pref")
    return Effect.gen(function*() {
      const port = yield* ChannelPortSqlite

      const channel = makeChannel({ channelId: "channel:model-pref" as ChannelId })
      yield* port.create(channel)

      yield* port.updateModelPreference("channel:model-pref" as ChannelId, {
        modelOverride: { provider: "openai", modelId: "gpt-4o" },
        generationConfigOverride: { temperature: 0.5, maxOutputTokens: 2048 }
      })

      const result = yield* port.get("channel:model-pref" as ChannelId)
      expect(result).not.toBeNull()
      expect(result!.modelOverride).toEqual({ provider: "openai", modelId: "gpt-4o" })
      expect(result!.generationConfigOverride).toEqual({ temperature: 0.5, maxOutputTokens: 2048 })
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("updateModelPreference PATCH: update only model, generationConfig unchanged", () => {
    const dbPath = testDatabasePath("channel-patch")
    return Effect.gen(function*() {
      const port = yield* ChannelPortSqlite

      const channel = makeChannel({ channelId: "channel:patch" as ChannelId })
      yield* port.create(channel)

      // Set both
      yield* port.updateModelPreference("channel:patch" as ChannelId, {
        modelOverride: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
        generationConfigOverride: { temperature: 0.8 }
      })

      // PATCH: only update model
      yield* port.updateModelPreference("channel:patch" as ChannelId, {
        modelOverride: { provider: "openai", modelId: "gpt-4o" }
      })

      const result = yield* port.get("channel:patch" as ChannelId)
      expect(result!.modelOverride).toEqual({ provider: "openai", modelId: "gpt-4o" })
      // generationConfigOverride should be unchanged
      expect(result!.generationConfigOverride).toEqual({ temperature: 0.8 })
    }).pipe(
      Effect.provide(makeTestLayer(dbPath)),
      Effect.ensuring(cleanupDatabase(dbPath))
    )
  })

  it.effect("updateModelPreference clears override with null", () => {
    const dbPath = testDatabasePath("channel-clear")
    return Effect.gen(function*() {
      const port = yield* ChannelPortSqlite

      const channel = makeChannel({ channelId: "channel:clear" as ChannelId })
      yield* port.create(channel)

      // Set model
      yield* port.updateModelPreference("channel:clear" as ChannelId, {
        modelOverride: { provider: "openai", modelId: "gpt-4o" }
      })

      // Clear it
      yield* port.updateModelPreference("channel:clear" as ChannelId, {
        modelOverride: null
      })

      const result = yield* port.get("channel:clear" as ChannelId)
      expect(result!.modelOverride).toBeNull()
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
