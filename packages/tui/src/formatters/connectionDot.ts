import { theme } from "../theme.js"

export const connectionDot = (status: string): { dot: string; color: string } => {
  switch (status) {
    case "connected": return { dot: "●", color: theme.statusConnected }
    case "connecting": return { dot: "●", color: theme.statusPending }
    case "error": return { dot: "●", color: theme.statusError }
    default: return { dot: "○", color: theme.textMuted }
  }
}
