import * as React from "react"
import type { ChatMessage } from "../types.js"
import { theme } from "../theme.js"
import { SyntaxStyleContext } from "./SyntaxStyleContext.js"

const MessageBubbleInner = function MessageBubble({ message }: { readonly message: ChatMessage }) {
  const syntaxStyle = React.useContext(SyntaxStyleContext)

  if (message.role === "user") {
    return (
      <box flexDirection="column">
        <text content={`> ${message.content}`} fg={theme.textMuted} />
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
          fg={
            message.status === "failed" || message.status === "checkpoint_rejected"
              ? theme.error
              : message.status === "checkpoint_deferred"
              ? theme.textMuted
              : theme.text
          }
        />
      )}
      {message.status === "checkpoint_required" ? (
        <text
          content={`  ⚠ Checkpoint: ${message.checkpointAction ?? "approval"} — ${message.checkpointReason ?? ""}`}
          fg={theme.statusPending}
        />
      ) : null}
      {message.status === "checkpoint_rejected" ? (
        <text
          content="  ✗ Checkpoint rejected."
          fg={theme.error}
        />
      ) : null}
      {message.status === "checkpoint_deferred" ? (
        <text
          content="  … Checkpoint deferred."
          fg={theme.textMuted}
        />
      ) : null}
      {message.errorMessage ? (
        <text content={`  [error: ${message.errorMessage}]`} fg={theme.error} />
      ) : null}
    </box>
  )
}

export const MessageBubble = React.memo(MessageBubbleInner)
