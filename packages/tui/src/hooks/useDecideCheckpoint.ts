import { RegistryContext } from "@effect/atom-react"
import type { ChatClient } from "@template/client/ChatClient"
import type { ServiceMap } from "effect"
import { Effect, Stream } from "effect"
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import * as React from "react"
import { connectionStatusAtom, isStreamingAtom, messagesAtom } from "../atoms/session.js"
import { dispatchEvent } from "./useSendMessage.js"

type ChatClientShape = ServiceMap.Service.Shape<typeof ChatClient>

export function useDecideCheckpoint(client: ChatClientShape) {
  const registry: AtomRegistry.AtomRegistry = React.useContext(RegistryContext)

  return React.useCallback(
    (checkpointId: string, decision: "Approved" | "Rejected" | "Deferred") => {
      registry.set(isStreamingAtom, true)

      const program = Effect.gen(function*() {
        const result = yield* client.decideCheckpoint(checkpointId, decision)

        if (result.kind === "stream") {
          yield* result.stream.pipe(
            Stream.tap((event) => Effect.sync(() => dispatchEvent(registry, event))),
            Stream.runDrain
          )
        } else {
          registry.update(messagesAtom, (msgs) => {
            if (msgs.length === 0) return msgs
            const last = msgs[msgs.length - 1]!
            if (last.status !== "checkpoint_required") return msgs
            return [...msgs.slice(0, -1), { ...last, status: "complete" as const }]
          })
        }
      }).pipe(
        Effect.scoped,
        Effect.catch((error) =>
          Effect.sync(() => {
            registry.update(messagesAtom, (msgs) => {
              const last = msgs[msgs.length - 1]
              if (last && last.status === "checkpoint_required") {
                return [
                  ...msgs.slice(0, -1),
                  { ...last, status: "failed" as const, errorMessage: String(error) }
                ]
              }
              return msgs
            })
            registry.set(connectionStatusAtom, "error")
          })
        ),
        Effect.ensuring(Effect.sync(() => registry.set(isStreamingAtom, false)))
      )

      Effect.runFork(program)
    },
    [registry, client]
  )
}
