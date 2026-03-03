import { useAtomValue } from "@effect/atom-react"
import {
  channelIdAtom,
  connectionStatusAtom,
  messageCountAtom,
  pendingCheckpointAtom
} from "../atoms/session.js"
import { connectionDot } from "../formatters/connectionDot.js"
import { theme } from "../theme.js"

export function StatusBar() {
  const channelId = useAtomValue(channelIdAtom)
  const status = useAtomValue(connectionStatusAtom)
  const count = useAtomValue(messageCountAtom)
  const checkpoint = useAtomValue(pendingCheckpointAtom)
  const { dot, color: dotColor } = connectionDot(status)

  const shortId = channelId.startsWith("channel:") ? channelId.slice(8, 16) : channelId.slice(0, 8)
  const shortcuts = checkpoint
    ? "^Y approve  ^N reject  ^D defer"
    : "^S sessions  ^M memory  ^K cmd"

  return (
    <box backgroundColor={theme.surface} flexDirection="row">
      <text content={` ${shortId} `} fg={theme.textMuted} />
      <text content="│" fg={theme.border} />
      <text content={` ${dot} ${status} `} fg={dotColor} />
      <text content="│" fg={theme.border} />
      <text content={` ${count} msgs `} fg={theme.textMuted} />
      <text content="│" fg={theme.border} />
      <box flexGrow={1} justifyContent="flex-end">
        <text content={`${shortcuts} `} fg={checkpoint ? theme.statusPending : theme.textMuted} />
      </box>
    </box>
  )
}
