import { useAtomValue } from "@effect/atom-react"
import { toolEventsAtom } from "../atoms/session.js"

export function ToolPane() {
  const toolEvents = useAtomValue(toolEventsAtom)

  return (
    <box flexDirection="column" flexGrow={1} border={true} borderStyle="single" padding={1}>
      <text content=" Tools " fg="yellow" />
      <scrollbox flexGrow={1}>
        {toolEvents.length === 0 ? (
          <text content="No tool calls." fg="gray" />
        ) : (
          toolEvents.map((tool) => (
            <box key={tool.toolCallId} flexDirection="column">
              <text
                content={`${tool.status === "called" ? "\u23F3" : tool.isError ? "\u274C" : "\u2713"} ${tool.toolName}`}
                fg={tool.isError ? "red" : tool.status === "called" ? "yellow" : "green"}
              />
              {tool.outputJson ? (
                <text content={`  \u2192 ${tool.outputJson.slice(0, 80)}`} fg="gray" />
              ) : null}
            </box>
          ))
        )}
      </scrollbox>
    </box>
  )
}
