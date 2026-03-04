import type { Instant } from "@template/domain/ports"
import {
  DateTime,
  Effect,
  FiberMap,
  Layer,
  Ref,
  ServiceMap,
  Semaphore
} from "effect"

export interface RuntimeWorkerSnapshot {
  readonly key: string
  readonly status: "running" | "suspended" | "done"
  readonly startedAt: Instant
}

export interface RuntimeSupervisorSnapshot {
  readonly activeWorkerCount: number
  readonly supervisedFiberCount: number
  readonly workers: ReadonlyArray<RuntimeWorkerSnapshot>
}

interface WorkerMetadata {
  readonly startedAt: Instant
}

export interface RuntimeSupervisorService {
  readonly start: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<boolean, never, R>
  readonly stop: (key: string) => Effect.Effect<boolean>
  readonly snapshot: () => Effect.Effect<RuntimeSupervisorSnapshot>
}

export class RuntimeSupervisor extends ServiceMap.Service<RuntimeSupervisor>()(
  "server/runtime/RuntimeSupervisor",
  {
    make: Effect.gen(function*() {
      const fiberMap = yield* FiberMap.make<string, unknown, unknown>()
      const metadataRef = yield* Ref.make(new Map<string, WorkerMetadata>())
      const mutationLock = yield* Semaphore.make(1)

      const start: RuntimeSupervisorService["start"] = (key, effect) =>
        mutationLock.withPermits(1)(
          Effect.gen(function*() {
            const exists = yield* FiberMap.has(fiberMap, key)
            if (exists) {
              return false
            }

            const startedAt = yield* DateTime.now
            yield* Ref.update(metadataRef, (map) => {
              const next = new Map(map)
              next.set(key, { startedAt })
              return next
            })

            const managedEffect = effect.pipe(
              Effect.ensuring(
                Ref.update(metadataRef, (map) => {
                  const next = new Map(map)
                  next.delete(key)
                  return next
                })
              )
            )

            yield* FiberMap.run(fiberMap, key, managedEffect)
            return true
          })
        )

      const stop: RuntimeSupervisorService["stop"] = (key) =>
        mutationLock.withPermits(1)(
          Effect.gen(function*() {
            const exists = yield* FiberMap.has(fiberMap, key)
            yield* FiberMap.remove(fiberMap, key)
            yield* Ref.update(metadataRef, (map) => {
              const next = new Map(map)
              next.delete(key)
              return next
            })
            return exists
          })
        )

      const snapshot: RuntimeSupervisorService["snapshot"] = () =>
        Effect.gen(function*() {
          const metadata = yield* Ref.get(metadataRef)
          const keys = [...metadata.keys()].sort((left, right) => left.localeCompare(right))
          const activeWorkerCount = yield* FiberMap.size(fiberMap)

          const workers = keys.flatMap((key) => {
            const startedAt = metadata.get(key)?.startedAt
            if (startedAt === undefined) {
              return [] as ReadonlyArray<RuntimeWorkerSnapshot>
            }

            const fiber = FiberMap.getUnsafe(fiberMap, key)
            if (fiber === undefined) {
              return [] as ReadonlyArray<RuntimeWorkerSnapshot>
            }

            const status: RuntimeWorkerSnapshot["status"] =
              fiber.pollUnsafe() === undefined ? "running" : "done"

            return [{
              key,
              status,
              startedAt
            } satisfies RuntimeWorkerSnapshot]
          })

          return {
            activeWorkerCount,
            supervisedFiberCount: activeWorkerCount,
            workers
          } satisfies RuntimeSupervisorSnapshot
        })

      return {
        start,
        stop,
        snapshot
      } satisfies RuntimeSupervisorService
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
