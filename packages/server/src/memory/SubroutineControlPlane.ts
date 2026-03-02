import {
  DEFAULT_SUBROUTINE_DEDUPE_WINDOW_SECONDS,
  DEFAULT_SUBROUTINE_QUEUE_CAPACITY
} from "@template/domain/system-defaults"
import type { AgentId, AuditEntryId, ConversationId, SessionId, TurnId } from "@template/domain/ids"
import type { SubroutineTriggerType } from "@template/domain/status"
import type { AuditEntryRecord, Instant } from "@template/domain/ports"
import type { AuthorizationDecision } from "@template/domain/status"
import { DateTime, Effect, Layer, Queue, Ref, ServiceMap } from "effect"
import { GovernancePortTag } from "../PortTags.js"
import { SubroutineCatalog } from "./SubroutineCatalog.js"
import { SubroutineRunner, type SubroutineContext } from "./SubroutineRunner.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchRequest {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly subroutineId: string
  readonly turnId: TurnId | null
  readonly triggerType: SubroutineTriggerType
  readonly triggerReason: string
  readonly enqueuedAt: Instant
}

export interface EnqueueResult {
  readonly accepted: boolean
  readonly reason: "dispatched" | "deduped" | "queue_full" | "unknown_subroutine"
  readonly runId: string | null
}

interface DedupeEntry {
  readonly acceptedAt: Instant
}

/** Internal queue item — DispatchRequest + generated runId */
interface QueuedDispatch extends DispatchRequest {
  readonly runId: string
}

// ---------------------------------------------------------------------------
// Pure Functions (exported for testing)
// ---------------------------------------------------------------------------

export const makeDedupeKey = (request: DispatchRequest): string => {
  if (request.triggerType === "PostTurn" && request.turnId !== null) {
    return `${request.sessionId}::${request.subroutineId}::${request.turnId}`
  }
  return `${request.sessionId}::${request.subroutineId}`
}

export const isDuplicate = (
  dedupeMap: ReadonlyMap<string, DedupeEntry>,
  key: string,
  now: Instant,
  windowSeconds: number
): boolean => {
  const entry = dedupeMap.get(key)
  if (!entry) return false
  const elapsedMs = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(entry.acceptedAt)
  return elapsedMs < windowSeconds * 1000
}

export const makeSerializationKey = (sessionId: string, subroutineId: string): string =>
  `${sessionId}::${subroutineId}`

// ---------------------------------------------------------------------------
// Audit Helper
// ---------------------------------------------------------------------------

type ControlPlaneAuditReason =
  | "memory_subroutine_dispatched"
  | "memory_subroutine_skipped"

const writeControlPlaneAudit = (
  governancePort: {
    readonly writeAudit: (entry: AuditEntryRecord) => Effect.Effect<void>
  },
  request: DispatchRequest,
  reason: ControlPlaneAuditReason,
  decision: AuthorizationDecision = "Allow"
) =>
  governancePort.writeAudit({
    auditEntryId: `audit:controlplane:${request.subroutineId}:${reason}:${crypto.randomUUID()}` as AuditEntryId,
    agentId: request.agentId,
    sessionId: request.sessionId,
    decision,
    reason: `${reason}:${request.subroutineId}`,
    createdAt: request.enqueuedAt
  })

// ---------------------------------------------------------------------------
// Types: TriggerContext
// ---------------------------------------------------------------------------

export interface TriggerContext {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly conversationId: ConversationId
  readonly turnId: TurnId | null
  readonly now: Instant
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SubroutineControlPlaneService {
  readonly enqueue: (request: DispatchRequest) => Effect.Effect<EnqueueResult>
  readonly dispatchByTrigger: (
    triggerType: SubroutineTriggerType,
    context: TriggerContext
  ) => Effect.Effect<ReadonlyArray<EnqueueResult>>
}

export class SubroutineControlPlane extends ServiceMap.Service<SubroutineControlPlane>()(
  "server/memory/SubroutineControlPlane",
  {
    make: Effect.gen(function*() {
      const runner = yield* SubroutineRunner
      const catalog = yield* SubroutineCatalog
      const governancePort = yield* GovernancePortTag

      const queue = yield* Queue.dropping<QueuedDispatch>(DEFAULT_SUBROUTINE_QUEUE_CAPACITY)
      const dedupeState = yield* Ref.make(new Map<string, DedupeEntry>())
      const inFlight = yield* Ref.make(new Set<string>())

      // 4a. enqueue — never fails
      const enqueue: SubroutineControlPlaneService["enqueue"] = (request) =>
        Effect.gen(function*() {
          // 1. Validate subroutine exists
          const lookupResult = yield* catalog.getById(request.subroutineId).pipe(
            Effect.map((loaded) => ({ found: true as const, loaded })),
            Effect.catchTag("SubroutineNotFound", () =>
              Effect.succeed({ found: false as const, loaded: null as never })
            )
          )
          if (!lookupResult.found) {
            return { accepted: false, reason: "unknown_subroutine", runId: null } satisfies EnqueueResult
          }

          const loaded = lookupResult.loaded
          const windowSeconds = loaded.config.dedupeWindowSeconds ?? DEFAULT_SUBROUTINE_DEDUPE_WINDOW_SECONDS

          // 2. Compute dedupe key
          const dedupeKey = makeDedupeKey(request)

          // 3. Check for duplicate
          const currentDedupeMap = yield* Ref.get(dedupeState)
          if (isDuplicate(currentDedupeMap, dedupeKey, request.enqueuedAt, windowSeconds)) {
            yield* writeControlPlaneAudit(governancePort, request, "memory_subroutine_skipped").pipe(
              Effect.ignore
            )
            return { accepted: false, reason: "deduped", runId: null } satisfies EnqueueResult
          }

          // 4. Generate runId
          const runId = crypto.randomUUID()

          // 5. Record in dedupe map
          yield* Ref.update(dedupeState, (map) => {
            const next = new Map(map)
            next.set(dedupeKey, { acceptedAt: request.enqueuedAt })
            return next
          })

          // 6. Prune expired dedupe entries (older than 2× max window = 120s)
          const pruneThresholdMs = 2 * DEFAULT_SUBROUTINE_DEDUPE_WINDOW_SECONDS * 1000
          const nowMs = DateTime.toEpochMillis(request.enqueuedAt)
          yield* Ref.update(dedupeState, (map) => {
            const next = new Map<string, DedupeEntry>()
            for (const [k, v] of map) {
              if (nowMs - DateTime.toEpochMillis(v.acceptedAt) < pruneThresholdMs) {
                next.set(k, v)
              }
            }
            return next
          })

          // 7. Offer to queue
          const offered = yield* Queue.offer(queue, { ...request, runId })
          if (!offered) {
            // Undo dedupe entry
            yield* Ref.update(dedupeState, (map) => {
              const next = new Map(map)
              next.delete(dedupeKey)
              return next
            })
            return { accepted: false, reason: "queue_full", runId: null } satisfies EnqueueResult
          }

          // 8. Audit dispatch
          yield* writeControlPlaneAudit(governancePort, request, "memory_subroutine_dispatched").pipe(
            Effect.ignore
          )

          // 9. Return success
          return { accepted: true, reason: "dispatched", runId } satisfies EnqueueResult
        })

      // 4b. processOne — handles a single queued dispatch
      const processOne = (item: QueuedDispatch) =>
        Effect.gen(function*() {
          const serKey = makeSerializationKey(item.sessionId, item.subroutineId)

          // Check in-flight — if already running for this (session, subroutine), skip
          const alreadyInFlight = yield* Ref.get(inFlight).pipe(
            Effect.map((set) => set.has(serKey))
          )
          if (alreadyInFlight) {
            yield* Effect.log("SubroutineControlPlane: skipping in-flight duplicate", {
              sessionId: item.sessionId,
              subroutineId: item.subroutineId
            })
            return
          }

          // Add to in-flight
          yield* Ref.update(inFlight, (set) => {
            const next = new Set(set)
            next.add(serKey)
            return next
          })

          // Execute with guaranteed cleanup
          yield* Effect.gen(function*() {
            // Look up subroutine from catalog
            const loaded = yield* catalog.getById(item.subroutineId).pipe(
              Effect.catchTag("SubroutineNotFound", () => {
                return Effect.log("SubroutineControlPlane: subroutine not found at execution time", {
                  subroutineId: item.subroutineId
                }).pipe(Effect.as(null))
              })
            )
            if (!loaded) return

            // Build SubroutineContext from DispatchRequest
            const context: SubroutineContext = {
              agentId: item.agentId,
              sessionId: item.sessionId,
              conversationId: item.conversationId,
              turnId: item.turnId,
              triggerType: item.triggerType,
              triggerReason: item.triggerReason,
              now: item.enqueuedAt,
              runId: item.runId
            }

            // Execute — runner.execute never fails (errors captured in result)
            const result = yield* runner.execute(loaded, context)
            yield* Effect.log("SubroutineControlPlane processOne completed", {
              subroutineId: result.subroutineId,
              runId: result.runId,
              success: result.success,
              checkpointWritten: result.checkpointWritten,
              errorTag: result.error?.tag ?? null
            })
          }).pipe(
            Effect.ensuring(
              Ref.update(inFlight, (set) => {
                const next = new Set(set)
                next.delete(serKey)
                return next
              })
            )
          )
        })

      // 4c. Worker loop
      const workerLoop = Effect.forever(
        Effect.gen(function*() {
          const item = yield* Queue.take(queue)
          yield* processOne(item)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("SubroutineControlPlane worker error", { cause })
          )
        )
      )

      // 4d. dispatchByTrigger — catalog lookup + batch enqueue
      const dispatchByTrigger: SubroutineControlPlaneService["dispatchByTrigger"] = (
        triggerType,
        context
      ) =>
        Effect.gen(function*() {
          const subroutines = yield* catalog.getByTrigger(context.agentId, triggerType)
          if (subroutines.length === 0) return [] as ReadonlyArray<EnqueueResult>

          const results: Array<EnqueueResult> = []
          for (const sub of subroutines) {
            const result = yield* enqueue({
              agentId: context.agentId,
              sessionId: context.sessionId,
              conversationId: context.conversationId,
              subroutineId: sub.config.id,
              turnId: context.turnId,
              triggerType,
              triggerReason: `${triggerType} trigger`,
              enqueuedAt: context.now
            })
            results.push(result)
          }
          return results
        })

      // Fork worker as scoped fiber — clean shutdown when scope closes
      yield* Effect.forkScoped(workerLoop)

      return { enqueue, dispatchByTrigger } satisfies SubroutineControlPlaneService
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
