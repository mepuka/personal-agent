import { useAtomValue } from "@effect/atom-react"
import { estimatedContextAtom, type ContextUsage } from "../atoms/session.js"
import { theme } from "../theme.js"

const SEGMENT_COLORS: Record<string, string> = {
  system: "#7aa2f7",
  persona: "#9ece6a",
  memory: "#e0af68",
  history: "#7dcfff",
  tools: "#bb9af7"
}

const SEGMENTS: ReadonlyArray<{ key: keyof ContextUsage & string; label: string }> = [
  { key: "system", label: "sys" },
  { key: "persona", label: "per" },
  { key: "memory", label: "mem" },
  { key: "history", label: "his" },
  { key: "tools", label: "tls" }
]

const formatTokens = (n: number): string =>
  n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)

const summaryColor = (pct: number): string =>
  pct < 60 ? theme.statusConnected : pct < 85 ? theme.statusPending : theme.statusError

export function ContextBar() {
  const usage = useAtomValue(estimatedContextAtom)
  const totalPct = usage.system + usage.persona + usage.memory + usage.history + usage.tools
  const barWidth = 6
  const summaryFilled = Math.round((totalPct / 100) * barWidth)

  return (
    <box flexDirection="column">
      <text content={` Context (${totalPct}%)`} fg={theme.accent} />
      {SEGMENTS.filter(({ key }) => (usage[key] as number) > 0).map(({ key, label }, i, visible) => {
        const pct = usage[key] as number
        const filled = Math.round((pct / 100) * barWidth)
        const empty = barWidth - filled
        const prefix = i < visible.length - 1 ? " \u251C" : " \u2514"
        const color = SEGMENT_COLORS[key] ?? theme.textMuted
        return (
          <text key={key}>
            <span fg={theme.textMuted}>{`${prefix} ${label} `}</span>
            <span fg={color}>{"\u2588".repeat(filled)}</span>
            <span fg={theme.border}>{"\u2591".repeat(empty)}</span>
            <span fg={theme.textMuted}>{` ${pct}%`}</span>
          </text>
        )
      })}
      <text>
        <span fg={summaryColor(totalPct)}>{`  ${"\u2588".repeat(summaryFilled)}`}</span>
        <span fg={theme.border}>{"\u2591".repeat(barWidth - summaryFilled)}</span>
      </text>
      <text
        content={`  ${formatTokens(usage.totalTokens)} / ${formatTokens(usage.capacityTokens)}`}
        fg={theme.textMuted}
      />
    </box>
  )
}
