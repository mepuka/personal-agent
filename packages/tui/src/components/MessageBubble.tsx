import type { ChatMessage } from "../types.js"

export function MessageBubble({ message }: { readonly message: ChatMessage }) {
  const label = message.role === "user" ? "> " : ""
  const statusIndicator = message.status === "streaming" ? " ..." : ""
  const fg = message.role === "user" ? "green" : message.status === "failed" ? "red" : "white"

  return (
    <box flexDirection="column">
      <text
        content={`${label}${message.content}${statusIndicator}`}
        fg={fg}
      />
      {message.errorMessage ? (
        <text content={`  [error: ${message.errorMessage}]`} fg="red" />
      ) : null}
    </box>
  )
}
