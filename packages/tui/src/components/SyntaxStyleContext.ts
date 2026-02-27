// @ts-expect-error -- @opentui/core .d.ts uses extensionless re-exports incompatible with NodeNext resolution
import type { SyntaxStyle } from "@opentui/core"
import * as React from "react"

export const SyntaxStyleContext = React.createContext<SyntaxStyle | null>(null)
