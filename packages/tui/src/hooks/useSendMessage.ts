import { RegistryContext } from "@effect/atom-react"
import type { ChatClient } from "@template/client/ChatClient"
import type { TurnStreamEvent } from "@template/domain/events"
import type { ServiceMap } from "effect"
import { Effect, Stream } from "effect"
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import * as React from "react"
import {
  channelIdAtom,
  connectionStatusAtom,
  inputHistoryAtom,
  isStreamingAtom,
  messagesAtom,
  toolEventsAtom
} from "../atoms/session.js"
import type { ChatMessage, ToolEvent } from "../types.js"

type ChatClientShape = ServiceMap.Service.Shape<typeof ChatClient>

export function useSendMessage(client: ChatClientShape) {
  const registry: AtomRegistry.AtomRegistry = React.useContext(RegistryContext)

  return React.useCallback(
    (content: string) => {
      const chId = registry.get(channelIdAtom)
      if (!chId || !content.trim()) return

      // Append user message immediately
      const turnId = `turn:${crypto.randomUUID()}`
      const userMsg: ChatMessage = {
        role: "user",
        content,
        turnId,
        status: "complete"
      }
      registry.update(messagesAtom, (msgs) => [...msgs, userMsg])
      registry.update(inputHistoryAtom, (history) => [...history, content])
      registry.set(isStreamingAtom, true)

      const program = Effect.gen(function*() {
        const eventStream = yield* client.sendMessage(chId, content)
        yield* eventStream.pipe(
          Stream.tap((event) => Effect.sync(() => dispatchEvent(registry, event))),
          Stream.runDrain
        )
      }).pipe(
        Effect.scoped,
        Effect.catch((error) =>
          Effect.sync(() => {
            registry.update(messagesAtom, (msgs) => {
              const last = msgs[msgs.length - 1]
              if (last && last.status === "streaming") {
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

/** @internal — exported for testing */
export function dispatchEvent(
  registry: AtomRegistry.AtomRegistry,
  event: TurnStreamEvent
): void {
  switch (event.type) {
    case "turn.started": {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        turnId: event.turnId,
        status: "streaming"
      }
      registry.update(messagesAtom, (msgs) => [...msgs, assistantMsg])
      break
    }
    case "assistant.delta": {
      registry.update(messagesAtom, (msgs) => {
        if (msgs.length === 0) return msgs
        const last = msgs[msgs.length - 1]!
        return [
          ...msgs.slice(0, -1),
          { ...last, content: last.content + event.delta }
        ]
      })
      break
    }
    case "tool.call": {
      const toolEvent: ToolEvent = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputJson: event.inputJson,
        outputJson: null,
        isError: false,
        status: "called"
      }
      registry.update(toolEventsAtom, (events) => [...events, toolEvent])
      break
    }
    case "tool.result": {
      registry.update(toolEventsAtom, (events) =>
        events.map((t) =>
          t.toolCallId === event.toolCallId
            ? { ...t, outputJson: event.outputJson, isError: event.isError, status: "completed" as const }
            : t
        ))
      break
    }
    case "iteration.completed": {
      break
    }
    case "turn.completed": {
      registry.update(messagesAtom, (msgs) => {
        if (msgs.length === 0) return msgs
        const last = msgs[msgs.length - 1]!
        return [...msgs.slice(0, -1), { ...last, status: "complete" as const }]
      })
      break
    }
    case "turn.failed": {
      registry.update(messagesAtom, (msgs) => {
        if (msgs.length === 0) return msgs
        const last = msgs[msgs.length - 1]!
        return [
          ...msgs.slice(0, -1),
          { ...last, status: "failed" as const, errorMessage: `${event.errorCode}: ${event.message}` }
        ]
      })
      break
    }
  }
}
