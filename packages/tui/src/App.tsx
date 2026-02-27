import { ChatClient } from "@template/client/ChatClient"
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { Effect, ServiceMap } from "effect"
import * as React from "react"
// @ts-expect-error -- @opentui/react .d.ts uses extensionless re-exports incompatible with NodeNext resolution
import { useKeyboard } from "@opentui/react"
import { channelIdAtom, connectionStatusAtom, messagesAtom, modalAtom } from "./atoms/session.js"
import { ChatPane } from "./components/ChatPane.js"
import { InputBar } from "./components/InputBar.js"
import { ModalLayer } from "./components/ModalLayer.js"
import { StatusBar } from "./components/StatusBar.js"
import { ToolPane } from "./components/ToolPane.js"
import { useSendMessage } from "./hooks/useSendMessage.js"
import type { ChatMessage } from "./types.js"

type ChatClientShape = ServiceMap.Service.Shape<typeof ChatClient>

/** Focus targets for Tab cycling */
type FocusTarget = "input" | "tools"

export function App({ client }: { readonly client: ChatClientShape }) {
  const registry = React.useContext(RegistryContext)
  const sendMessage = useSendMessage(client)
  const [focusTarget, setFocusTarget] = React.useState<FocusTarget>("input")
  const activeModal = useAtomValue(modalAtom)

  // Global keyboard handler
  useKeyboard((key: { name: string; ctrl: boolean }) => {
    if (key.ctrl && key.name === "c") {
      process.exit(0)
    }

    // Modal keybindings
    if (key.name === "escape" && activeModal !== null) {
      registry.set(modalAtom, null)
      return
    }
    if (key.ctrl && key.name === "k") {
      registry.set(modalAtom, "command-palette")
      return
    }
    if (key.ctrl && key.name === "s") {
      registry.set(modalAtom, "session-picker")
      return
    }
    // Ctrl+, may not be detectable in terminals — use Ctrl+P as fallback for settings
    if (key.ctrl && key.name === ",") {
      registry.set(modalAtom, "settings")
      return
    }
    if (key.ctrl && key.name === "m") {
      registry.set(modalAtom, "memory-search")
      return
    }

    // Tab focus cycling — only when no modal is open
    if (key.name === "tab" && activeModal === null) {
      setFocusTarget((prev) => (prev === "input" ? "tools" : "input"))
    }
  })

  const closeModal = React.useCallback(() => {
    registry.set(modalAtom, null)
  }, [registry])

  // Initialize channel on mount
  React.useEffect(() => {
    const chId = `channel:${crypto.randomUUID()}`
    registry.set(channelIdAtom, chId)
    registry.set(connectionStatusAtom, "connecting")

    const init = Effect.gen(function*() {
      yield* client.initialize(chId, "agent:bootstrap")
      registry.set(connectionStatusAtom, "connected")

      const history = yield* client.getHistory(chId)
      if (Array.isArray(history) && history.length > 0) {
        const restored: Array<ChatMessage> = history.map((msg: any) => ({
          role: msg.role as "user" | "assistant",
          content: String(msg.content ?? ""),
          turnId: String(msg.turnId ?? ""),
          status: "complete" as const
        }))
        registry.set(messagesAtom, restored)
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error("Channel initialization failed:", error)
          registry.set(connectionStatusAtom, "error")
        })
      )
    )
    Effect.runFork(init)
  }, [registry, client])

  return (
    <ModalLayer activeModal={activeModal} onClose={closeModal}>
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="row" flexGrow={1}>
          <ChatPane />
          <ToolPane focused={focusTarget === "tools" && activeModal === null} />
        </box>
        <InputBar onSubmit={sendMessage} focused={focusTarget === "input" && activeModal === null} />
        <StatusBar />
      </box>
    </ModalLayer>
  )
}
