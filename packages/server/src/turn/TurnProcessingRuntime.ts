import { Effect, Layer, ServiceMap } from "effect"
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

      return {
        processTurn
      } as const
    })
  }
) {
  static layer = Layer.effect(this, this.make)
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
