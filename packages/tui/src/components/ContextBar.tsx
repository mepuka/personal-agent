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
  { key: "system", label: "system" },
  { key: "persona", label: "persona" },
  { key: "memory", label: "memory" },
  { key: "history", label: "history" },
  { key: "tools", label: "tools" }
]

const formatTokens = (n: number): string =>
  n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)

const summaryColor = (pct: number): string =>
  pct < 60 ? theme.statusConnected : pct < 85 ? theme.statusPending : theme.statusError

export function ContextBar() {
  const usage = useAtomValue(estimatedContextAtom)
  const totalPct = usage.system + usage.persona + usage.memory + usage.history + usage.tools
  const barWidth = 12
  const summaryFilled = Math.round((totalPct / 100) * barWidth)

  return (
    <box flexDirection="column">
      <text content={` Context (${totalPct}%)`} fg={theme.accent} />
      {SEGMENTS.filter(({ key }) => (usage[key] as number) > 0).map(({ key, label }, i, visible) => {
        const pct = usage[key] as number
        const filled = Math.round((pct / 100) * (barWidth - 2))
        const empty = (barWidth - 2) - filled
        const prefix = i < visible.length - 1 ? " \u251C" : " \u2514"
        return (
          <text
            key={key}
            content={`${prefix} ${label.padEnd(9)}${"\u2588".repeat(filled)}${"\u2591".repeat(empty)} ${String(pct).padStart(2)}%`}
            fg={SEGMENT_COLORS[key] ?? theme.textMuted}
          />
        )
      })}
      <text content={` ${"\u2500".repeat(barWidth + 6)}`} fg={theme.border} />
      <text
        content={`  ${"\u2588".repeat(summaryFilled)}${"\u2591".repeat(barWidth - summaryFilled)}`}
        fg={summaryColor(totalPct)}
      />
      <text
        content={`  ${formatTokens(usage.totalTokens)} / ${formatTokens(usage.capacityTokens)} tokens`}
        fg={theme.textMuted}
      />
    </box>
  )
}
