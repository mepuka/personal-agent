import { Atom } from "effect/unstable/reactivity"
import type { ChatMessage, ConnectionStatus, ModalId, ToolEvent } from "../types.js"

// --- Writable atoms (source of truth) ---

export const channelIdAtom = Atom.make<string>("")
export const messagesAtom = Atom.make<ReadonlyArray<ChatMessage>>([])
export const toolEventsAtom = Atom.make<ReadonlyArray<ToolEvent>>([])
export const connectionStatusAtom = Atom.make<ConnectionStatus>("disconnected")
export const isStreamingAtom = Atom.make<boolean>(false)
export const inputHistoryAtom = Atom.make<ReadonlyArray<string>>([])
export const modalAtom = Atom.make<ModalId | null>(null)

// --- Derived atoms (computed) ---

export const lastMessageAtom = Atom.make((get: Atom.Context) => {
  const msgs = get(messagesAtom)
  return msgs.length > 0 ? msgs[msgs.length - 1] ?? null : null
})

export const activeToolsAtom = Atom.make((get: Atom.Context) =>
  get(toolEventsAtom).filter((t) => t.status === "called")
)

export const messageCountAtom = Atom.make((get: Atom.Context) => get(messagesAtom).length)

export const pendingCheckpointAtom = Atom.make((get: Atom.Context) => {
  const msgs = get(messagesAtom)
  if (msgs.length === 0) return null
  const last = msgs[msgs.length - 1]!
  if (last.status !== "checkpoint_required" || !last.checkpointId) return null
  return {
    checkpointId: last.checkpointId,
    action: last.checkpointAction ?? "unknown",
    reason: last.checkpointReason ?? ""
  }
})
