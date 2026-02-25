import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SearchQuery } from "../src/memory.js"

describe("memory schemas", () => {
  it.effect("decodes a SearchQuery with all fields", () =>
    Effect.gen(function*() {
      const input = {
        query: "pizza",
        tier: "SemanticMemory",
        scope: "GlobalScope",
        source: "AgentSource",
        sort: "CreatedDesc",
        limit: 10,
        cursor: "abc123"
      }
      const result = yield* Schema.decodeUnknownEffect(SearchQuery)(input)
      expect(result.query).toBe("pizza")
      expect(result.tier).toBe("SemanticMemory")
      expect(result.scope).toBe("GlobalScope")
      expect(result.source).toBe("AgentSource")
      expect(result.sort).toBe("CreatedDesc")
      expect(result.limit).toBe(10)
      expect(result.cursor).toBe("abc123")
    })
  )

  it.effect("decodes a SearchQuery with no fields (browse all)", () =>
    Effect.gen(function*() {
      const result = yield* Schema.decodeUnknownEffect(SearchQuery)({})
      expect(result.query).toBeUndefined()
      expect(result.tier).toBeUndefined()
      expect(result.cursor).toBeUndefined()
    })
  )

  it.effect("rejects invalid tier value", () =>
    Effect.gen(function*() {
      const result = yield* Schema.decodeUnknownEffect(SearchQuery)({
        tier: "InvalidTier"
      }).pipe(Effect.flip)
      expect(result).toBeDefined()
    })
  )
})
