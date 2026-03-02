import type { ChannelSummary } from "../types.js"
import { theme } from "../theme.js"
import { ModalBox } from "./ModalBox.js"

export function SessionPickerModal({
  channels,
  activeChannelId,
  selectedIndex
}: {
  readonly channels: ReadonlyArray<ChannelSummary>
  readonly activeChannelId: string
  readonly selectedIndex: number
}) {
  return (
    <ModalBox title="Sessions" width="70%" height="70%">
      {channels.length === 0 ? (
        <box flexDirection="column">
          <text content="No channels found." fg={theme.textMuted} />
          <text content="Press Esc to close." fg={theme.textMuted} />
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1}>
          <text content="Use ↑/↓ to select, Enter to switch, x to delete." fg={theme.textMuted} />
          <scrollbox flexGrow={1} stickyScroll={true} stickyStart="top">
            {channels.map((channel, index) => {
              const isSelected = index === selectedIndex
              const isActive = channel.channelId === activeChannelId
              const marker = isSelected ? ">" : " "
              const activeMarker = isActive ? " *" : ""
              const lastTurnAt = channel.lastTurnAt ? channel.lastTurnAt : "no turns yet"
              return (
                <box key={channel.channelId} flexDirection="column">
                  <text
                    content={`${marker} ${channel.channelId}${activeMarker}`}
                    fg={isSelected ? theme.accent : theme.text}
                    bold={isSelected}
                  />
                  <text
                    content={`   ${channel.messageCount} msgs | ${channel.channelType} | last: ${lastTurnAt}`}
                    fg={theme.textMuted}
                  />
                </box>
              )
            })}
          </scrollbox>
        </box>
      )}
    </ModalBox>
  )
}
