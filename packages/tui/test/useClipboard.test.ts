import { describe, expect, it, vi } from "vitest"
import { useClipboard } from "../src/hooks/useClipboard.js"

vi.mock("@opentui/react", () => ({
  useRenderer: () => ({
    copyToClipboardOSC52: () => true
  })
}))

describe("useClipboard", () => {
  it("exports a hook function", () => {
    expect(typeof useClipboard).toBe("function")
  })
})
