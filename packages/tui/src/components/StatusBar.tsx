import { useAtomValue } from "@effect/atom-react"
import { channelIdAtom, connectionStatusAtom, isStreamingAtom, messageCountAtom } from "../atoms/session.js"
import { theme } from "../theme.js"

export function StatusBar() {
  const channelId = useAtomValue(channelIdAtom)
  const status = useAtomValue(connectionStatusAtom)
  const isStreaming = useAtomValue(isStreamingAtom)
  const count = useAtomValue(messageCountAtom)

  const shortId = channelId.length > 20 ? `${channelId.slice(0, 20)}...` : channelId
  const streamLabel = isStreaming ? " | streaming" : ""

  return (
    <box backgroundColor={theme.surface}>
      <text
        content={` ${shortId} | ${status}${streamLabel} | ${count} msgs | ^K palette  ^S sessions  ^M memory  ^C exit `}
        fg={theme.textMuted}
      />
    </box>
  )
}
