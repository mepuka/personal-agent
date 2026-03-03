import * as React from "react"
import type { ChannelSummary, ModalId } from "../types.js"
import { theme } from "../theme.js"
import { ModalBox } from "./ModalBox.js"
import { SessionPickerModal } from "./SessionPickerModal.js"

export function ModalLayer({
  activeModal,
  onClose,
  children,
  sessionPicker
}: {
  readonly activeModal: ModalId | null
  readonly onClose: () => void
  readonly children: React.ReactNode
  readonly sessionPicker?: {
    readonly channels: ReadonlyArray<ChannelSummary>
    readonly activeChannelId: string
    readonly selectedIndex: number
    readonly onSelect: (channelId: string) => void
    readonly onDelete: (channelId: string) => void
  }
}) {
  return (
    <box flexDirection="column" flexGrow={1}>
      {children}
      {activeModal !== null && (
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          backgroundColor={theme.bg}
        >
          {renderModal(
            activeModal,
            sessionPicker !== undefined
              ? { onClose, sessionPicker }
              : { onClose }
          )}
        </box>
      )}
    </box>
  )
}

function renderModal(modalId: ModalId, handlers: {
  readonly onClose: () => void
  readonly sessionPicker?: {
    readonly channels: ReadonlyArray<ChannelSummary>
    readonly activeChannelId: string
    readonly selectedIndex: number
    readonly onSelect: (channelId: string) => void
    readonly onDelete: (channelId: string) => void
  }
}): React.ReactNode {
  // Placeholder modals — each will be replaced with a real component in later slices
  switch (modalId) {
    case "command-palette":
      return (
        <ModalBox title="Command Palette" width="70%" height="40%">
          <text content="Command palette coming soon..." fg={theme.textMuted} />
        </ModalBox>
      )
    case "session-picker":
      return handlers.sessionPicker
        ? (
          <SessionPickerModal
            channels={handlers.sessionPicker.channels}
            activeChannelId={handlers.sessionPicker.activeChannelId}
            selectedIndex={handlers.sessionPicker.selectedIndex}
            onSelect={handlers.sessionPicker.onSelect}
            onDelete={handlers.sessionPicker.onDelete}
          />
        )
        : (
          <ModalBox title="Sessions" width="60%" height="60%">
            <text content="Session picker unavailable." fg={theme.textMuted} />
          </ModalBox>
        )
    case "settings":
      return (
        <ModalBox title="Settings" width="50%" height="50%">
          <text content="Settings coming soon..." fg={theme.textMuted} />
        </ModalBox>
      )
    case "memory-search":
      return (
        <ModalBox title="Memory Search" width="60%" height="60%">
          <text content="Memory search coming soon..." fg={theme.textMuted} />
        </ModalBox>
      )
    case "tool-inspector":
      return (
        <ModalBox title="Tool Inspector" width="80%" height="80%">
          <text content="Tool inspector coming soon..." fg={theme.textMuted} />
        </ModalBox>
      )
  }
}
