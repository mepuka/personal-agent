import { useAtomValue } from "@effect/atom-react"
import { channelIdAtom, connectionStatusAtom, isStreamingAtom, messageCountAtom } from "../atoms/session.js"

export function StatusBar() {
  const channelId = useAtomValue(channelIdAtom)
  const status = useAtomValue(connectionStatusAtom)
  const isStreaming = useAtomValue(isStreamingAtom)
  const count = useAtomValue(messageCountAtom)

  const shortId = channelId.length > 20 ? `${channelId.slice(0, 20)}...` : channelId
  const statusColor = status === "connected" ? "green" : status === "error" ? "red" : "yellow"
  const streamLabel = isStreaming ? " | streaming" : ""

  return (
    <box>
      <text
        content={` ${shortId} | ${status}${streamLabel} | ${count} msgs | Ctrl+C to exit `}
        fg={statusColor}
      />
    </box>
  )
}
