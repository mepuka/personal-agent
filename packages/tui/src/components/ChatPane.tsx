import { useAtomValue } from "@effect/atom-react"
import { messagesAtom } from "../atoms/session.js"
import { MessageBubble } from "./MessageBubble.js"

export function ChatPane() {
  const messages = useAtomValue(messagesAtom)

  return (
    <box flexDirection="column" flexGrow={2} border={true} borderStyle="single" padding={1}>
      <text content=" Chat " fg="cyan" />
      <scrollbox flexGrow={1}>
        {messages.length === 0 ? (
          <text content="No messages yet. Type below to start." fg="gray" />
        ) : (
          messages.map((msg, i) => (
            <MessageBubble key={`${msg.turnId}-${i}`} message={msg} />
          ))
        )}
      </scrollbox>
    </box>
  )
}
