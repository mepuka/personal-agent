import type { TurnStreamEvent } from "@template/domain/events"
import { Effect, Layer, ServiceMap, Stream } from "effect"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import {
  type ProcessTurnPayload,
  type ProcessTurnResult,
  type TurnProcessingError,
  TurnProcessingWorkflow
} from "./TurnProcessingWorkflow.js"

export class TurnProcessingRuntime extends ServiceMap.Service<TurnProcessingRuntime>()(
  "server/TurnProcessingRuntime",
  {
    make: Effect.gen(function*() {
      const workflowEngine = yield* WorkflowEngine.WorkflowEngine

      const processTurn = (input: ProcessTurnPayload): Effect.Effect<ProcessTurnResult, TurnProcessingError> =>
        Effect.gen(function*() {
          const withEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
            )

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
          Stream.flatMap(Stream.fromIterable)
        )

        return Stream.concat(Stream.make(startedEvent), tail)
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
          return [{
            type: "tool.result" as const, ...base, sequence: 0,
            toolCallId: block.toolCallId, toolName: block.toolName,
            outputJson: block.outputJson, isError: block.isError
          }]
        case "ImageBlock":
          return []
      }
    }
  )

  const checkpointEvent: TurnStreamEvent | null = result.checkpointId !== undefined
    ? {
      type: "turn.checkpoint_required" as const,
      ...base,
      sequence: 0,
      checkpointId: result.checkpointId,
      action: result.checkpointAction ?? "unknown",
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

const makeExecutionId = (idempotencyKey: string) =>
  Effect.map(
    Effect.promise(() =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`TurnProcessingWorkflow-${idempotencyKey}`)
      )
    ),
    (buffer) => {
      const hex = Array.from(new Uint8Array(buffer).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
      return hex
    }
  )
