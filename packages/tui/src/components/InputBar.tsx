import { useAtomValue } from "@effect/atom-react"
// @ts-expect-error -- @opentui/react .d.ts uses extensionless re-exports incompatible with NodeNext resolution
import { useKeyboard } from "@opentui/react"
import * as React from "react"
import { inputHistoryAtom, isStreamingAtom } from "../atoms/session.js"

export function InputBar({
  onSubmit,
  focused
}: {
  readonly onSubmit: (content: string) => void
  readonly focused: boolean
}) {
  const isStreaming = useAtomValue(isStreamingAtom)
  const inputHistory = useAtomValue(inputHistoryAtom)
  const [inputValue, setInputValue] = React.useState("")
  // -1 means "not browsing history" (fresh input), 0..N indexes from newest to oldest
  const [historyIndex, setHistoryIndex] = React.useState(-1)
  // Stash the in-progress input when entering history mode
  const [stashedInput, setStashedInput] = React.useState("")

  // Refs to avoid stale closures in useKeyboard callback
  const inputValueRef = React.useRef(inputValue)
  inputValueRef.current = inputValue
  const historyIndexRef = React.useRef(historyIndex)
  historyIndexRef.current = historyIndex
  const stashedInputRef = React.useRef(stashedInput)
  stashedInputRef.current = stashedInput
  const focusedRef = React.useRef(focused)
  focusedRef.current = focused
  const isStreamingRef = React.useRef(isStreaming)
  isStreamingRef.current = isStreaming
  const inputHistoryRef = React.useRef(inputHistory)
  inputHistoryRef.current = inputHistory

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

  // Handle Up/Down arrow keys for history navigation
  useKeyboard((key: { name: string }) => {
    if (!focusedRef.current || isStreamingRef.current) return
    const history = inputHistoryRef.current
    if (history.length === 0) return
    const idx = historyIndexRef.current

    const historyAt = (i: number) => history[history.length - 1 - i] ?? ""

    if (key.name === "up") {
      if (idx === -1) {
        // Entering history mode — stash current input
        setStashedInput(inputValueRef.current)
        setHistoryIndex(0)
        setInputValue(historyAt(0))
      } else if (idx < history.length - 1) {
        // Go further back in history
        const newIndex = idx + 1
        setHistoryIndex(newIndex)
        setInputValue(historyAt(newIndex))
      }
    }

    if (key.name === "down") {
      if (idx > 0) {
        // Go forward in history
        const newIndex = idx - 1
        setHistoryIndex(newIndex)
        setInputValue(historyAt(newIndex))
      } else if (idx === 0) {
        // Return to fresh input
        setHistoryIndex(-1)
        setInputValue(stashedInputRef.current)
      }
    }
  })

  const isFocused = focused && !isStreaming

  return (
    <box border={true} borderStyle="single" padding={0}>
      <text content={isStreaming ? " streaming... " : " > "} fg={isStreaming ? "yellow" : "green"} />
      <input
        placeholder="Type a message..."
        focused={isFocused}
        value={inputValue}
        onInput={setInputValue}
        onSubmit={handleSubmit}
        flexGrow={1}
      />
    </box>
  )
}
