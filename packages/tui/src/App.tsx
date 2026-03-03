import { ChatClient } from "@template/client/ChatClient"
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { Effect, ServiceMap } from "effect"
import * as React from "react"
// @ts-expect-error -- @opentui/react .d.ts uses extensionless re-exports incompatible with NodeNext resolution
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import {
  availableChannelsAtom,
  channelIdAtom,
  connectionStatusAtom,
  modalAtom
} from "./atoms/session.js"
import { ChatPane } from "./components/ChatPane.js"
import { InputBar } from "./components/InputBar.js"
import { ModalLayer } from "./components/ModalLayer.js"
import { StatusBar } from "./components/StatusBar.js"
import { ToolPane } from "./components/ToolPane.js"
import { useDecideCheckpoint } from "./hooks/useDecideCheckpoint.js"
import { useSendMessage } from "./hooks/useSendMessage.js"
import { applyRestoredHistory, restoreHistory } from "./state/restoreHistory.js"
import { theme } from "./theme.js"

type ChatClientShape = ServiceMap.Service.Shape<typeof ChatClient>

type FocusTarget = "input" | "tools"

const DEFAULT_AGENT_ID = "agent:bootstrap"


export function App({ client }: { readonly client: ChatClientShape }) {
  const registry = React.useContext(RegistryContext)
  const initializedRef = React.useRef(false)
  const sendMessage = useSendMessage(client)
  const decideCheckpoint = useDecideCheckpoint(client)
  const [focusTarget, setFocusTarget] = React.useState<FocusTarget>("input")
  const [sessionPickerIndex, setSessionPickerIndex] = React.useState(0)
  const activeModal = useAtomValue(modalAtom)
  const activeChannelId = useAtomValue(channelIdAtom)
  const availableChannels = useAtomValue(availableChannelsAtom)
  const { width } = useTerminalDimensions()
  const inputRef = React.useRef(null)

  const showToolPane = width >= 80

  const refreshChannels = React.useCallback(() => {
    const load = Effect.gen(function*() {
      const channels = yield* client.listChannels(DEFAULT_AGENT_ID)
      registry.set(availableChannelsAtom, channels)
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error("Loading channels failed:", error)
        })
      )
    )
    Effect.runFork(load)
  }, [registry, client])

  const restoreChannel = React.useCallback((channelId: string) => {
    const program = Effect.gen(function*() {
      registry.set(connectionStatusAtom, "connecting")
      registry.set(channelIdAtom, channelId)
      yield* client.initialize(channelId, DEFAULT_AGENT_ID)
      const history = yield* client.getHistory(channelId)
      applyRestoredHistory(registry, restoreHistory(history))
      registry.set(connectionStatusAtom, "connected")
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error("Channel restore failed:", error)
          registry.set(connectionStatusAtom, "error")
        })
      )
    )
    Effect.runFork(program)
  }, [registry, client])

  const selectChannel = React.useCallback((channelId: string) => {
    registry.set(modalAtom, null)
    if (channelId === activeChannelId) {
      return
    }
    restoreChannel(channelId)
  }, [registry, restoreChannel, activeChannelId])

  const deleteSelectedChannel = React.useCallback((targetChannelId: string) => {
    const program = Effect.gen(function*() {
      registry.set(connectionStatusAtom, "connecting")
      yield* client.deleteChannel(targetChannelId)

      const channels = yield* client.listChannels(DEFAULT_AGENT_ID)
      registry.set(availableChannelsAtom, channels)
      yield* Effect.sync(() => {
        setSessionPickerIndex((previous) => {
          if (channels.length === 0) {
            return 0
          }
          return Math.min(previous, channels.length - 1)
        })
      })

      if (targetChannelId !== activeChannelId) {
        registry.set(connectionStatusAtom, "connected")
        return
      }

      if (channels.length === 0) {
        const freshChannelId = `channel:${crypto.randomUUID()}`
        registry.set(channelIdAtom, freshChannelId)
        yield* client.initialize(freshChannelId, DEFAULT_AGENT_ID)
        const history = yield* client.getHistory(freshChannelId)
        applyRestoredHistory(registry, restoreHistory(history))
        registry.set(connectionStatusAtom, "connected")
        return
      }

      const nextChannelId = channels[0]!.channelId
      registry.set(channelIdAtom, nextChannelId)
      yield* client.initialize(nextChannelId, DEFAULT_AGENT_ID)
      const history = yield* client.getHistory(nextChannelId)
      applyRestoredHistory(registry, restoreHistory(history))
      registry.set(connectionStatusAtom, "connected")
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error("Delete channel failed:", error)
          registry.set(connectionStatusAtom, "error")
        })
      )
    )

    Effect.runFork(program)
  }, [registry, client, activeChannelId])

  React.useEffect(() => {
    if (activeModal !== "session-picker") {
      return
    }

    const activeIndex = availableChannels.findIndex((channel) => channel.channelId === activeChannelId)
    setSessionPickerIndex((prev) => {
      if (availableChannels.length === 0) {
        return 0
      }
      if (activeIndex >= 0) {
        return activeIndex
      }
      return Math.min(prev, availableChannels.length - 1)
    })
  }, [activeModal, availableChannels, activeChannelId])

  useKeyboard((key: { name: string; ctrl: boolean }) => {
    if (key.ctrl && key.name === "c") {
      process.exit(0)
    }

    if (key.name === "escape" && activeModal !== null) {
      registry.set(modalAtom, null)
      return
    }

    if (activeModal === "session-picker") {
      if (key.name === "up") {
        setSessionPickerIndex((prev) => {
          if (availableChannels.length === 0) {
            return 0
          }
          return (prev - 1 + availableChannels.length) % availableChannels.length
        })
        return
      }
      if (key.name === "down") {
        setSessionPickerIndex((prev) => {
          if (availableChannels.length === 0) {
            return 0
          }
          return (prev + 1) % availableChannels.length
        })
        return
      }
      if (key.name === "enter" || key.name === "return") {
        const selected = availableChannels[sessionPickerIndex]
        if (selected !== undefined) {
          selectChannel(selected.channelId)
        }
        return
      }
      if (key.name === "x") {
        const selected = availableChannels[sessionPickerIndex]
        if (selected !== undefined) {
          deleteSelectedChannel(selected.channelId)
        }
        return
      }
    }

    if (key.ctrl && key.name === "k") {
      registry.set(modalAtom, "command-palette")
      return
    }
    if (key.ctrl && key.name === "s") {
      refreshChannels()
      const activeIndex = availableChannels.findIndex((channel) => channel.channelId === activeChannelId)
      setSessionPickerIndex(activeIndex >= 0 ? activeIndex : 0)
      registry.set(modalAtom, "session-picker")
      return
    }
    if (key.ctrl && key.name === ",") {
      registry.set(modalAtom, "settings")
      return
    }
    if (key.ctrl && key.name === "m") {
      registry.set(modalAtom, "memory-search")
      return
    }

    if (key.name === "tab" && activeModal === null) {
      setFocusTarget((prev) => (prev === "input" ? "tools" : "input"))
    }
  })

  const closeModal = React.useCallback(() => {
    registry.set(modalAtom, null)
  }, [registry])

  React.useEffect(() => {
    if (initializedRef.current) {
      return
    }
    initializedRef.current = true

    const init = Effect.gen(function*() {
      registry.set(connectionStatusAtom, "connecting")
      const channels = yield* client.listChannels(DEFAULT_AGENT_ID)
      registry.set(availableChannelsAtom, channels)
      const chId = channels[0]?.channelId ?? `channel:${crypto.randomUUID()}`
      registry.set(channelIdAtom, chId)

      yield* client.initialize(chId, DEFAULT_AGENT_ID)
      registry.set(connectionStatusAtom, "connected")

      const history = yield* client.getHistory(chId)
      applyRestoredHistory(registry, restoreHistory(history))
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
    <ModalLayer
      activeModal={activeModal}
      onClose={closeModal}
      sessionPicker={{
        channels: availableChannels,
        activeChannelId,
        selectedIndex: sessionPickerIndex
      }}
    >
      <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg}>
        <box flexDirection="row" flexGrow={1}>
          <ChatPane />
          {showToolPane && (
            <ToolPane focused={focusTarget === "tools" && activeModal === null} />
          )}
        </box>
        <InputBar
          onSubmit={sendMessage}
          onDecision={decideCheckpoint}
          focused={focusTarget === "input" && activeModal === null}
          inputRef={inputRef}
        />
        <StatusBar />
      </box>
    </ModalLayer>
  )
}
