import { useAtomValue } from "@effect/atom-react"
// @ts-expect-error -- @opentui/react .d.ts uses extensionless re-exports incompatible with NodeNext resolution
import { useKeyboard } from "@opentui/react"
import * as React from "react"
import { inputHistoryAtom, isStreamingAtom } from "../atoms/session.js"
import { theme } from "../theme.js"

export function InputBar({
  onSubmit,
  focused,
  inputRef
}: {
  readonly onSubmit: (content: string) => void
  readonly focused: boolean
  readonly inputRef?: React.RefObject<unknown>
}) {
  const isStreaming = useAtomValue(isStreamingAtom)
  const inputHistory = useAtomValue(inputHistoryAtom)
  const [inputValue, setInputValue] = React.useState("")
  const [historyIndex, setHistoryIndex] = React.useState(-1)
  const [stashedInput, setStashedInput] = React.useState("")

  const handleSubmit = React.useCallback(
    (value: string) => {
      if (isStreaming || !value.trim()) return
      onSubmit(value.trim())
      setInputValue("")
      setHistoryIndex(-1)
      setStashedInput("")
    },
    [onSubmit, isStreaming]
  )

  // useKeyboard already stabilizes via useEffectEvent — no refs needed
  useKeyboard((key: { name: string }) => {
    if (!focused || isStreaming) return
    if (inputHistory.length === 0) return

    const historyAt = (i: number) => inputHistory[inputHistory.length - 1 - i] ?? ""

    if (key.name === "up") {
      if (historyIndex === -1) {
        setStashedInput(inputValue)
        setHistoryIndex(0)
        setInputValue(historyAt(0))
      } else if (historyIndex < inputHistory.length - 1) {
        const newIndex = historyIndex + 1
        setHistoryIndex(newIndex)
        setInputValue(historyAt(newIndex))
      }
    }

    if (key.name === "down") {
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1
        setHistoryIndex(newIndex)
        setInputValue(historyAt(newIndex))
      } else if (historyIndex === 0) {
        setHistoryIndex(-1)
        setInputValue(stashedInput)
      }
    }
  })

  const isFocused = focused && !isStreaming

  return (
    <box
      border={true}
      borderStyle="single"
      borderColor={theme.border}
      focusedBorderColor={theme.borderFocus}
      padding={0}
    >
      <text
        content={isStreaming ? " streaming... " : " > "}
        fg={isStreaming ? theme.streaming : theme.userText}
      />
      <input
        ref={inputRef}
        placeholder="Type a message..."
        focused={isFocused}
        value={inputValue}
        onInput={setInputValue}
        onSubmit={handleSubmit}
        flexGrow={1}
        cursorColor={theme.accent}
        textColor={theme.text}
        placeholderColor={theme.textMuted}
      />
    </box>
  )
}
