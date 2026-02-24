import type { AgentId } from "@template/domain/ids"
import type { MemoryItemRecord, MemoryPort } from "@template/domain/ports"
import { Effect, HashMap, Layer, Option, Ref, ServiceMap } from "effect"

export class MemoryPortMemory extends ServiceMap.Service<MemoryPortMemory>()("server/MemoryPortMemory", {
  make: Effect.gen(function*() {
    const itemsByAgent = yield* Ref.make(HashMap.empty<AgentId, Array<MemoryItemRecord>>())

    const retrieve: MemoryPort["retrieve"] = (query) =>
      Ref.get(itemsByAgent).pipe(
        Effect.map((map) => {
          const items = Option.getOrElse(HashMap.get(map, query.agentId), () => [])
          const needle = query.text.toLowerCase()
          return items
            .filter((item) => item.content.toLowerCase().includes(needle))
            .slice(0, query.limit)
        })
      )

    const encode: MemoryPort["encode"] = (items, _now) =>
      Ref.update(itemsByAgent, (map) => {
        let nextMap = map
        for (const item of items) {
          const current = Option.getOrElse(HashMap.get(nextMap, item.agentId), () => [])
          nextMap = HashMap.set(nextMap, item.agentId, [...current, item])
        }
        return nextMap
      }).pipe(
        Effect.as(items.map((item) => item.memoryItemId))
      )

    const forget: MemoryPort["forget"] = (agentId, cutoff) =>
      Ref.modify(itemsByAgent, (map) => {
        const current = Option.getOrElse(HashMap.get(map, agentId), () => [])
        const retained = current.filter((item) => item.createdAt >= cutoff)
        const deletedCount = current.length - retained.length
        return [deletedCount, HashMap.set(map, agentId, retained)] as const
      })

    return {
      retrieve,
      encode,
      forget
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
