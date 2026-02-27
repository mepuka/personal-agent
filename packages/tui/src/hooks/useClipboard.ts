import * as React from "react"
// @ts-expect-error -- @opentui/react .d.ts uses extensionless re-exports incompatible with NodeNext resolution
import { useRenderer } from "@opentui/react"

export function useClipboard() {
  const renderer = useRenderer()

  const copy = React.useCallback(
    (text: string): boolean => {
      return renderer.copyToClipboardOSC52(text)
    },
    [renderer]
  )

  return { copy }
}
