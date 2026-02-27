import { useAtomValue } from "@effect/atom-react"
import {
  channelIdAtom,
  connectionStatusAtom,
  isStreamingAtom,
  messageCountAtom,
  pendingCheckpointAtom
} from "../atoms/session.js"
import { theme } from "../theme.js"

export function StatusBar() {
  const channelId = useAtomValue(channelIdAtom)
  const status = useAtomValue(connectionStatusAtom)
  const isStreaming = useAtomValue(isStreamingAtom)
  const count = useAtomValue(messageCountAtom)
  const checkpoint = useAtomValue(pendingCheckpointAtom)

  const shortId = channelId.length > 20 ? `${channelId.slice(0, 20)}...` : channelId
  const streamLabel = isStreaming ? " | streaming" : ""
  const checkpointLabel = checkpoint ? " | CHECKPOINT" : ""

  return (
    <box backgroundColor={theme.surface}>
      <text
        content={` ${shortId} | ${status}${streamLabel}${checkpointLabel} | ${count} msgs | ^K palette  ^S sessions  ^M memory  ^C exit `}
        fg={checkpoint ? theme.statusPending : theme.textMuted}
      />
    </box>
  )
}
