import { useAtomValue } from "@effect/atom-react"
import * as React from "react"
import { isStreamingAtom } from "../atoms/session.js"

export function InputBar({
  onSubmit
}: {
  readonly onSubmit: (content: string) => void
}) {
  const isStreaming = useAtomValue(isStreamingAtom)

  const handleSubmit = React.useCallback(
    (value: string) => {
      if (isStreaming || !value.trim()) return
      onSubmit(value.trim())
    },
    [onSubmit, isStreaming]
  )

  return (
    <box border={true} borderStyle="single" padding={0}>
      <text content={isStreaming ? " streaming... " : " > "} fg={isStreaming ? "yellow" : "green"} />
      <input
        placeholder="Type a message..."
        focused={!isStreaming}
        onSubmit={handleSubmit}
        flexGrow={1}
      />
    </box>
  )
}
