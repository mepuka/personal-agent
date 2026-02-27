import * as React from "react"
import type { ChatMessage } from "../types.js"
import { theme } from "../theme.js"
import { SyntaxStyleContext } from "./SyntaxStyleContext.js"

export function MessageBubble({ message }: { readonly message: ChatMessage }) {
  const syntaxStyle = React.useContext(SyntaxStyleContext)

  if (message.role === "user") {
    return (
      <box flexDirection="column">
        <text content={`> ${message.content}`} fg={theme.userText} />
      </box>
    )
  }

  const useMarkdown = syntaxStyle !== null && message.status === "complete"
  const useStreamingMarkdown = syntaxStyle !== null && message.status === "streaming"

  return (
    <box flexDirection="column">
      {useMarkdown ? (
        <markdown content={message.content} syntaxStyle={syntaxStyle} />
      ) : useStreamingMarkdown ? (
        <markdown content={message.content} syntaxStyle={syntaxStyle} streaming={true} />
      ) : (
        <text
          content={`${message.content}${message.status === "streaming" ? " ..." : ""}`}
          fg={message.status === "failed" ? theme.error : theme.text}
        />
      )}
      {message.status === "checkpoint_required" ? (
        <text
          content={`  ⚠ Checkpoint: ${message.checkpointAction ?? "unknown"} — ${message.checkpointReason ?? ""}`}
          fg={theme.statusPending}
        />
      ) : null}
      {message.errorMessage ? (
        <text content={`  [error: ${message.errorMessage}]`} fg={theme.error} />
      ) : null}
    </box>
  )
}
