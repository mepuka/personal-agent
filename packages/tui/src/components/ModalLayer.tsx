import * as React from "react"
import type { ModalId } from "../types.js"
import { ModalBox } from "./ModalBox.js"

export function ModalLayer({
  activeModal,
  onClose,
  children
}: {
  readonly activeModal: ModalId | null
  readonly onClose: () => void
  readonly children: React.ReactNode
}) {
  // onClose is accepted for forward compatibility — will be wired in Task 4
  void onClose

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
        >
          {renderModal(activeModal)}
        </box>
      )}
    </box>
  )
}

function renderModal(modalId: ModalId): React.ReactNode {
  // Placeholder modals — each will be replaced with a real component in later slices
  switch (modalId) {
    case "command-palette":
      return (
        <ModalBox title="Command Palette" width="70%" height="40%">
          <text content="Command palette coming soon..." fg="gray" />
        </ModalBox>
      )
    case "session-picker":
      return (
        <ModalBox title="Sessions" width="60%" height="60%">
          <text content="Session picker coming soon..." fg="gray" />
        </ModalBox>
      )
    case "settings":
      return (
        <ModalBox title="Settings" width="50%" height="50%">
          <text content="Settings coming soon..." fg="gray" />
        </ModalBox>
      )
    case "memory-search":
      return (
        <ModalBox title="Memory Search" width="60%" height="60%">
          <text content="Memory search coming soon..." fg="gray" />
        </ModalBox>
      )
    case "tool-inspector":
      return (
        <ModalBox title="Tool Inspector" width="80%" height="80%">
          <text content="Tool inspector coming soon..." fg="gray" />
        </ModalBox>
      )
  }
}
