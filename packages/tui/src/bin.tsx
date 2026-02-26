#!/usr/bin/env bun

// @ts-expect-error -- @opentui/core .d.ts uses extensionless re-exports incompatible with NodeNext resolution
import { createCliRenderer } from "@opentui/core"
// @ts-expect-error -- @opentui/react .d.ts uses extensionless re-exports incompatible with NodeNext resolution
import { createRoot } from "@opentui/react"
import { App } from "./App.js"

const renderer = await createCliRenderer()
const root = createRoot(renderer)
root.render(<App />)
