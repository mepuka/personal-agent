import { useAtomValue } from "@effect/atom-react"
import { messagesAtom } from "../atoms/session.js"
import { theme } from "../theme.js"
import { MessageBubble } from "./MessageBubble.js"

export function ChatPane() {
  const messages = useAtomValue(messagesAtom)

  return (
    <box
      flexDirection="column"
      flexGrow={2}
      border={true}
      borderStyle="single"
      borderColor={theme.border}
      padding={1}
    >
      <text content=" Chat " fg={theme.accent} />
      <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
        {messages.length === 0 ? (
          <text content="No messages yet. Type below to start." fg={theme.textMuted} />
        ) : (
          messages.map((msg, i) => (
            <MessageBubble key={`${msg.turnId}-${i}`} message={msg} />
          ))
        )}
      </scrollbox>
    </box>
  )
}
