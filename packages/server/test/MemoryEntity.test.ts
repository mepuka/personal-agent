import { describe, expect, it } from "@effect/vitest"
import type { AgentId } from "@template/domain/ids"
import type { Instant, MemoryPort } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import { ShardingConfig } from "effect/unstable/cluster"
import { Entity } from "effect/unstable/cluster"
import { MemoryPortMemory } from "../src/MemoryPortMemory.js"
import { MemoryEntity, layer as MemoryEntityLayer } from "../src/entities/MemoryEntity.js"
import { MemoryPortTag } from "../src/PortTags.js"

describe("MemoryEntity", () => {
  it.effect("retrieve returns empty for unknown agent", () =>
    Effect.gen(function*() {
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient("agent:unknown")

      const results = yield* client.retrieve({
        agentId: "agent:unknown",
        sessionId: "session:unknown",
        text: "anything",
        limit: 10
      })

      expect(results).toEqual([])
    }).pipe(Effect.provide(makeTestLayer()))
  )

  it.effect("encode + retrieve round-trip", () =>
    Effect.gen(function*() {
      const now = instant("2026-02-24T12:00:00.000Z")
      const agentId = "agent:memory-rt" as AgentId
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(agentId)

      const ids = yield* client.encode({
        items: [
          {
            memoryItemId: "mem:1",
            agentId,
            tier: "WorkingMemory",
            content: "remember this fact",
            generatedByTurnId: null,
            createdAt: now
          }
        ],
        now
      })

      expect(ids.length).toBe(1)

      const results = yield* client.retrieve({
        agentId,
        sessionId: "session:memory-rt",
        text: "fact",
        limit: 10
      })

      expect(results.length).toBe(1)
      expect(results[0]?.content).toBe("remember this fact")
    }).pipe(Effect.provide(makeTestLayer()))
  )

  it.effect("forget removes items before cutoff", () =>
    Effect.gen(function*() {
      const now = instant("2026-02-24T12:00:00.000Z")
      const agentId = "agent:memory-forget" as AgentId
      const makeClient = yield* Entity.makeTestClient(MemoryEntity, MemoryEntityLayer)
      const client = yield* makeClient(agentId)

      yield* client.encode({
        items: [
          {
            memoryItemId: "mem:old",
            agentId,
            tier: "EpisodicMemory",
            content: "old memory",
            generatedByTurnId: null,
            createdAt: instant("2026-02-20T12:00:00.000Z")
          },
          {
            memoryItemId: "mem:new",
            agentId,
            tier: "EpisodicMemory",
            content: "new memory",
            generatedByTurnId: null,
            createdAt: now
          }
        ],
        now
      })

      const cutoff = instant("2026-02-23T00:00:00.000Z")
      const deletedCount = yield* client.forget({ agentId, cutoff })

      expect(deletedCount).toBe(1)

      const remaining = yield* client.retrieve({
        agentId,
        sessionId: "session:forget",
        text: "memory",
        limit: 10
      })

      expect(remaining.length).toBe(1)
      expect(remaining[0]?.content).toBe("new memory")
    }).pipe(Effect.provide(makeTestLayer()))
  )
})

const makeTestLayer = () => {
  const memoryTagLayer = Layer.effect(
    MemoryPortTag,
    Effect.gen(function*() {
      return (yield* MemoryPortMemory) as MemoryPort
    })
  ).pipe(Layer.provide(MemoryPortMemory.layer))

  return Layer.mergeAll(
    MemoryPortMemory.layer,
    memoryTagLayer,
    ShardingConfig.layer()
  )
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))
