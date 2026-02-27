import { describe, expect, it, vi } from "vitest"

vi.mock("@opentui/react", () => ({
  useRenderer: () => ({
    copyToClipboardOSC52: () => true
  })
}))

import { useClipboard } from "../src/hooks/useClipboard.js"

describe("useClipboard", () => {
  it("exports a hook function", () => {
    expect(typeof useClipboard).toBe("function")
  })
})
