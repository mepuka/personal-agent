import type { TurnStreamEvent } from "@template/domain/RuntimeApi"
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

      const processTurn = (input: ProcessTurnPayload) =>
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
        }) as Effect.Effect<ProcessTurnResult, TurnProcessingError>

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
  let sequence = 2
  const events: Array<TurnStreamEvent> = []

  for (const block of result.assistantContentBlocks) {
    switch (block.contentBlockType) {
      case "TextBlock": {
        events.push({
          type: "assistant.delta",
          sequence,
          turnId: input.turnId,
          sessionId: input.sessionId,
          delta: block.text
        })
        sequence += 1
        break
      }
      case "ToolUseBlock": {
        events.push({
          type: "tool.call",
          sequence,
          turnId: input.turnId,
          sessionId: input.sessionId,
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          inputJson: block.inputJson
        })
        sequence += 1
        break
      }
      case "ToolResultBlock": {
        events.push({
          type: "tool.result",
          sequence,
          turnId: input.turnId,
          sessionId: input.sessionId,
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          outputJson: block.outputJson,
          isError: block.isError
        })
        sequence += 1
        break
      }
      case "ImageBlock": {
        break
      }
    }
  }

  events.push({
    type: "turn.completed",
    sequence,
    turnId: input.turnId,
    sessionId: input.sessionId,
    accepted: result.accepted,
    auditReasonCode: result.auditReasonCode,
    modelFinishReason: result.modelFinishReason,
    modelUsageJson: result.modelUsageJson
  })

  return events
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
      const bytes = new Uint8Array(buffer)
      let digest = ""
      for (let i = 0; i < 16; i++) {
        digest += bytes[i].toString(16).padStart(2, "0")
      }
      return digest
    }
  )
