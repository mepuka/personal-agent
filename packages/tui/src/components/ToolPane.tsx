import { useAtomValue } from "@effect/atom-react"
import { toolEventsAtom } from "../atoms/session.js"
import { theme } from "../theme.js"

export function ToolPane({ focused }: { readonly focused: boolean }) {
  const toolEvents = useAtomValue(toolEventsAtom)

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border={true}
      borderStyle="single"
      borderColor={theme.border}
      focusedBorderColor={theme.borderFocus}
      padding={1}
    >
      <text content=" Tools " fg={theme.streaming} />
      <scrollbox flexGrow={1} focused={focused} stickyScroll={true} stickyStart="bottom">
        {toolEvents.length === 0 ? (
          <text content="No tool calls." fg={theme.textMuted} />
        ) : (
          toolEvents.map((tool) => (
            <box key={tool.toolCallId} flexDirection="column">
              <text
                content={`${tool.status === "called" ? "\u23F3" : tool.isError ? "\u274C" : "\u2713"} ${tool.toolName}`}
                fg={tool.isError ? theme.error : tool.status === "called" ? theme.streaming : theme.statusConnected}
              />
              {tool.outputJson ? (
                <text content={`  \u2192 ${tool.outputJson.slice(0, 80)}`} fg={theme.textMuted} />
              ) : null}
            </box>
          ))
        )}
      </scrollbox>
    </box>
  )
}
