import type { TurnFailedEvent, TurnStreamEvent } from "@template/domain/events"
import { Effect, Layer, ServiceMap, Stream } from "effect"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import {
  type ProcessTurnPayload,
  type ProcessTurnResult,
  type TurnProcessingError,
  TurnProcessingWorkflow
} from "./TurnProcessingWorkflow.js"
import { toTurnFailureCode, toTurnFailureIdentity, toTurnFailureMessage } from "./TurnFailureMapping.js"

export class TurnProcessingRuntime extends ServiceMap.Service<TurnProcessingRuntime>()(
  "server/TurnProcessingRuntime",
  {
    make: Effect.gen(function*() {
      const workflowEngine = yield* WorkflowEngine.WorkflowEngine

      const withEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
        )

      const processTurn = Effect.fn("TurnProcessingRuntime.processTurn")(function*(input: ProcessTurnPayload) {
        const executionId = yield* makeExecutionId(input.turnId)
        const existing = yield* withEngine(TurnProcessingWorkflow.poll(executionId))

        if (existing !== undefined) {
          if (existing._tag === "Complete") {
            return yield* existing.exit
          }
          return yield* withEngine(TurnProcessingWorkflow.execute(input))
        }

        return yield* withEngine(TurnProcessingWorkflow.execute(input))
      })

      const processTurnStream = (input: ProcessTurnPayload): Stream.Stream<TurnStreamEvent, TurnProcessingError> => {
        const startedEvent: TurnStreamEvent = {
          type: "turn.started",
          sequence: 1,
          turnId: input.turnId,
          sessionId: input.sessionId,
          createdAt: input.createdAt
        }

        const tail = Stream.fromEffect(processTurn(input)).pipe(
          Stream.map((result) => toSuccessEvents(input, result)),
          Stream.flatMap(Stream.fromIterable),
          Stream.catch((error) => Stream.make(toFailedEvent(input, error)))
        )

        return Stream.concat(Stream.make(startedEvent), tail).pipe(
          Stream.withSpan("TurnProcessingRuntime.processTurnStream")
        )
      }

      return {
        processTurn,
        processTurnStream
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

const toSuccessEvents = (
  input: ProcessTurnPayload,
  result: ProcessTurnResult
): ReadonlyArray<TurnStreamEvent> => {
  const base = { turnId: input.turnId, sessionId: input.sessionId }

  const iterationEvents: ReadonlyArray<TurnStreamEvent> = result.iterationStats.map(
    (stat) => ({
      type: "iteration.completed" as const,
      ...base,
      sequence: 0,
      iteration: stat.iteration,
      finishReason: stat.finishReason,
      toolCallsThisIteration: stat.toolCallsThisIteration,
      toolCallsTotal: stat.toolCallsTotal
    })
  )

  const contentEvents: ReadonlyArray<TurnStreamEvent> = result.assistantContentBlocks.flatMap(
    (block): ReadonlyArray<TurnStreamEvent> => {
      switch (block.contentBlockType) {
        case "TextBlock":
          return [{ type: "assistant.delta" as const, ...base, sequence: 0, delta: block.text }]
        case "ToolUseBlock":
          return [{
            type: "tool.call" as const, ...base, sequence: 0,
            toolCallId: block.toolCallId, toolName: block.toolName, inputJson: block.inputJson
          }]
        case "ToolResultBlock":
          if (block.isError || isRecoveredToolErrorOutput(block.outputJson)) {
            return [{
              type: "tool.error" as const, ...base, sequence: 0,
              toolCallId: block.toolCallId, toolName: block.toolName, outputJson: block.outputJson
            }]
          }
          return [{
            type: "tool.result" as const, ...base, sequence: 0,
            toolCallId: block.toolCallId, toolName: block.toolName,
            outputJson: block.outputJson, isError: false
          }]
        case "ImageBlock":
          return []
      }
    }
  )

  const checkpointEvent: TurnStreamEvent | null = (
    result.checkpointId !== undefined
    && result.checkpointAction !== undefined
  )
    ? {
      type: "turn.checkpoint_required" as const,
      ...base,
      sequence: 0,
      checkpointId: result.checkpointId,
      action: result.checkpointAction,
      reason: result.checkpointReason ?? "checkpoint required"
    }
    : null

  const completedEvent: TurnStreamEvent = {
    type: "turn.completed",
    ...base,
    sequence: 0,
    accepted: result.accepted,
    auditReasonCode: result.auditReasonCode,
    iterationsUsed: result.iterationsUsed,
    toolCallsTotal: result.toolCallsTotal,
    modelFinishReason: result.modelFinishReason,
    modelUsageJson: result.modelUsageJson
  }

  const allEvents = [
    ...iterationEvents,
    ...contentEvents,
    ...(checkpointEvent !== null ? [checkpointEvent] : []),
    completedEvent
  ]

  return allEvents.map((event, i) => ({ ...event, sequence: i + 2 }))
}

const toFailedEvent = (
  input: ProcessTurnPayload,
  error: TurnProcessingError
): TurnFailedEvent => {
  const identity = toTurnFailureIdentity(error)
  const message = toTurnFailureMessage(error, "Turn processing failed unexpectedly")
  const errorCode = toTurnFailureCode(error, message)

  return {
    type: "turn.failed",
    sequence: 2,
    turnId: identity.turnId.length > 0 ? identity.turnId : input.turnId,
    sessionId: identity.sessionId.length > 0 ? identity.sessionId : input.sessionId,
    errorCode,
    message
  }
}

/** @internal — exported for testing */
export const _test = {
  toSuccessEvents,
  toFailedEvent
}

const isRecoveredToolErrorOutput = (outputJson: string): boolean => {
  try {
    const parsed = JSON.parse(outputJson)
    return isToolErrorPayload(parsed)
  } catch {
    return false
  }
}

const isToolErrorPayload = (value: unknown): value is {
  readonly ok: false
  readonly errorCode: string
  readonly message: string
} =>
  typeof value === "object"
  && value !== null
  && "ok" in value
  && (value as { readonly ok?: unknown }).ok === false
  && "errorCode" in value
  && typeof (value as { readonly errorCode?: unknown }).errorCode === "string"
  && "message" in value
  && typeof (value as { readonly message?: unknown }).message === "string"

const makeExecutionId = Effect.fn("TurnProcessingRuntime.makeExecutionId")(function*(idempotencyKey: string) {
  const buffer = yield* Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`TurnProcessingWorkflow-${idempotencyKey}`)
    )
  )

  const hex = Array.from(new Uint8Array(buffer).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
  return hex
})
