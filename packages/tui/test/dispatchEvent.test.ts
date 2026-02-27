import { AtomRegistry } from "effect/unstable/reactivity"
import { describe, expect, it } from "vitest"
import { messagesAtom, toolEventsAtom } from "../src/atoms/session.js"
import { dispatchEvent } from "../src/hooks/useSendMessage.js"

describe("dispatchEvent", () => {
  function makeRegistry() {
    return AtomRegistry.make()
  }

  it("turn.started appends empty streaming assistant message", () => {
    const registry = makeRegistry()
    dispatchEvent(registry, {
      type: "turn.started",
      sequence: 0,
      turnId: "t1",
      sessionId: "s1",
      createdAt: new Date().toISOString()
    } as any)

    const msgs = registry.get(messagesAtom)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      role: "assistant",
      content: "",
      turnId: "t1",
      status: "streaming"
    })
  })

  it("assistant.delta appends text to last message", () => {
    const registry = makeRegistry()
    dispatchEvent(registry, {
      type: "turn.started",
      sequence: 0,
      turnId: "t1",
      sessionId: "s1",
      createdAt: new Date().toISOString()
    } as any)
    dispatchEvent(registry, {
      type: "assistant.delta",
      sequence: 1,
      turnId: "t1",
      sessionId: "s1",
      delta: "Hello"
    } as any)
    dispatchEvent(registry, {
      type: "assistant.delta",
      sequence: 2,
      turnId: "t1",
      sessionId: "s1",
      delta: " world"
    } as any)

    const msgs = registry.get(messagesAtom)
    expect(msgs[0]!.content).toBe("Hello world")
  })

  it("turn.completed marks last message complete", () => {
    const registry = makeRegistry()
    dispatchEvent(registry, {
      type: "turn.started",
      sequence: 0,
      turnId: "t1",
      sessionId: "s1",
      createdAt: new Date().toISOString()
    } as any)
    dispatchEvent(registry, {
      type: "turn.completed",
      sequence: 1,
      turnId: "t1",
      sessionId: "s1",
      accepted: true,
      auditReasonCode: "",
      modelFinishReason: null,
      modelUsageJson: null
    } as any)

    expect(registry.get(messagesAtom)[0]!.status).toBe("complete")
  })

  it("turn.failed marks last message with error", () => {
    const registry = makeRegistry()
    dispatchEvent(registry, {
      type: "turn.started",
      sequence: 0,
      turnId: "t1",
      sessionId: "s1",
      createdAt: new Date().toISOString()
    } as any)
    dispatchEvent(registry, {
      type: "turn.failed",
      sequence: 1,
      turnId: "t1",
      sessionId: "s1",
      errorCode: "PROVIDER_ERROR",
      message: "Rate limited"
    } as any)

    const last = registry.get(messagesAtom)[0]!
    expect(last.status).toBe("failed")
    expect(last.errorMessage).toBe("PROVIDER_ERROR: Rate limited")
  })

  it("tool.call appends tool event", () => {
    const registry = makeRegistry()
    dispatchEvent(registry, {
      type: "tool.call",
      sequence: 0,
      turnId: "t1",
      sessionId: "s1",
      toolCallId: "tc1",
      toolName: "search",
      inputJson: "{}"
    } as any)

    const tools = registry.get(toolEventsAtom)
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      toolCallId: "tc1",
      toolName: "search",
      status: "called"
    })
  })

  it("tool.result updates matching tool event", () => {
    const registry = makeRegistry()
    dispatchEvent(registry, {
      type: "tool.call",
      sequence: 0,
      turnId: "t1",
      sessionId: "s1",
      toolCallId: "tc1",
      toolName: "search",
      inputJson: "{}"
    } as any)
    dispatchEvent(registry, {
      type: "tool.result",
      sequence: 1,
      turnId: "t1",
      sessionId: "s1",
      toolCallId: "tc1",
      toolName: "search",
      outputJson: "{\"result\": \"found\"}",
      isError: false
    } as any)

    const tools = registry.get(toolEventsAtom)
    expect(tools[0]).toMatchObject({
      status: "completed",
      outputJson: "{\"result\": \"found\"}",
      isError: false
    })
  })
})
