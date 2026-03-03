import { useAtomValue } from "@effect/atom-react"
import * as React from "react"
import { toolEventsAtom } from "../atoms/session.js"
import { formatToolInput, formatToolOutput } from "../formatters/toolSummary.js"
import { theme } from "../theme.js"
import type { ToolEvent } from "../types.js"

const statusIcon = (tool: ToolEvent): string =>
  tool.status === "called" ? "\u23F3" : tool.isError ? "\u274C" : "\u2713"

const statusColor = (tool: ToolEvent): string =>
  tool.isError ? theme.error : tool.status === "called" ? theme.streaming : theme.statusConnected

const ToolEventRow = React.memo(function ToolEventRow({ tool }: { readonly tool: ToolEvent }) {
  const inputSummary = formatToolInput(tool.toolName, tool.inputJson)
  const outputSummary = formatToolOutput(tool.toolName, tool.outputJson, tool.isError)
  const label = inputSummary.length > 0
    ? `${statusIcon(tool)} ${tool.toolName} ${inputSummary}`
    : `${statusIcon(tool)} ${tool.toolName}`

  return (
    <box flexDirection="column">
      <text content={label} fg={statusColor(tool)} />
      {outputSummary.length > 0 ? (
        <text
          content={`  \u2192 ${outputSummary}`}
          fg={tool.isError ? theme.error : theme.textMuted}
        />
      ) : null}
    </box>
  )
})

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
            <ToolEventRow key={tool.toolCallId} tool={tool} />
          ))
        )}
      </scrollbox>
    </box>
  )
}
