# TUI CLI Channel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-pane terminal UI for the CLI channel using OpenTUI + React + Effect Atom, replacing the readline loop.

**Architecture:** New `packages/client` extracts the shared `ChatClient` service. New `packages/tui` renders a React component tree into the terminal via `@opentui/react`. Effect Atom manages state — SSE stream events push into writable atoms via `AtomRegistry.set/update`, React components observe via `useAtomValue`. The server is unchanged.

**Tech Stack:** @opentui/core, @opentui/react, effect/unstable/reactivity/Atom, @effect/atom-react, Effect 4.0.0-beta.11, Bun

**Design doc:** `docs/plans/2026-02-26-tui-cli-channel-design.md`

---

### Task 1: Extract `ChatClient` to `packages/client`

Create a new shared package containing the `ChatClient` service. Both `packages/cli` and `packages/tui` will depend on it.

**Files:**
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/tsconfig.src.json`
- Create: `packages/client/tsconfig.test.json`
- Create: `packages/client/tsconfig.build.json`
- Create: `packages/client/src/ChatClient.ts`
- Create: `packages/client/src/index.ts`
- Modify: `packages/cli/src/RuntimeClient.ts` (replace with re-export)
- Modify: `packages/cli/package.json` (add `@template/client` dependency)
- Modify: `packages/cli/tsconfig.src.json` (add client reference)
- Modify: `tsconfig.json` (add client reference)
- Modify: `tsconfig.base.json` (add client paths)

**Step 1: Create `packages/client/package.json`**

```json
{
  "name": "@template/client",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "description": "Shared HTTP/SSE client for the personal agent server",
  "repository": {
    "type": "git",
    "url": "<PLACEHOLDER>",
    "directory": "packages/client"
  },
  "publishConfig": {
    "access": "public",
    "directory": "dist"
  },
  "scripts": {
    "codegen": "build-utils prepare-v2",
    "build": "pnpm build-esm && pnpm build-annotate && pnpm build-cjs && build-utils pack-v2",
    "build-esm": "tsc -b tsconfig.build.json",
    "build-cjs": "babel build/esm --plugins @babel/transform-export-namespace-from --plugins @babel/transform-modules-commonjs --out-dir build/cjs --source-maps",
    "build-annotate": "babel build/esm --plugins annotate-pure-calls --out-dir build/esm --source-maps",
    "check": "tsc -b tsconfig.json",
    "test": "vitest",
    "coverage": "vitest --coverage"
  },
  "dependencies": {
    "@template/domain": "workspace:^",
    "effect": "4.0.0-beta.11"
  },
  "effect": {
    "generateExports": {
      "include": ["**/*.ts"]
    },
    "generateIndex": {
      "include": ["**/*.ts"]
    }
  }
}
```

**Step 2: Create tsconfig files**

`packages/client/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": [],
  "references": [
    { "path": "tsconfig.src.json" },
    { "path": "tsconfig.test.json" }
  ]
}
```

`packages/client/tsconfig.src.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "references": [
    { "path": "../domain" }
  ],
  "compilerOptions": {
    "types": ["node"],
    "outDir": "build/src",
    "tsBuildInfoFile": ".tsbuildinfo/src.tsbuildinfo",
    "rootDir": "src"
  }
}
```

`packages/client/tsconfig.test.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["test"],
  "references": [
    { "path": "tsconfig.src.json" },
    { "path": "../domain" }
  ],
  "compilerOptions": {
    "types": ["node"],
    "tsBuildInfoFile": ".tsbuildinfo/test.tsbuildinfo",
    "rootDir": "test",
    "noEmit": true
  }
}
```

`packages/client/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.src.json",
  "references": [
    { "path": "../domain/tsconfig.build.json" }
  ],
  "compilerOptions": {
    "types": ["node"],
    "tsBuildInfoFile": ".tsbuildinfo/build.tsbuildinfo",
    "outDir": "build/esm",
    "declarationDir": "build/dts",
    "stripInternal": true
  }
}
```

**Step 3: Create `packages/client/src/ChatClient.ts`**

Move the entire content of `packages/cli/src/RuntimeClient.ts` here, unchanged:

```typescript
import { TurnStreamEvent } from "@template/domain/events"
import { Config, Effect, Layer, ServiceMap, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

export class ChatClient extends ServiceMap.Service<ChatClient>()("client/ChatClient", {
  make: Effect.gen(function*() {
    const baseUrl = yield* Config.string("PA_SERVER_URL").pipe(
      Config.withDefault(() => "http://localhost:3000")
    )

    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk
    )

    const initialize = (channelId: string, agentId: string) =>
      HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${baseUrl}/channels/${channelId}/initialize`),
        { channelType: "CLI", agentId }
      ).pipe(
        (request) => httpClient.execute(request),
        Effect.asVoid,
        Effect.scoped
      )

    const sendMessage = (channelId: string, content: string) =>
      HttpClientRequest.bodyJsonUnsafe(
        HttpClientRequest.post(`${baseUrl}/channels/${channelId}/messages`),
        { content }
      ).pipe(
        (request) => httpClient.execute(request),
        Effect.map((response) =>
          response.stream.pipe(
            Stream.decodeText(),
            Stream.pipeThroughChannel(Sse.decodeDataSchema(TurnStreamEvent)),
            Stream.map((event) => event.data)
          )
        )
      )

    const getHistory = (channelId: string) =>
      httpClient.execute(
        HttpClientRequest.get(`${baseUrl}/channels/${channelId}/history`)
      ).pipe(
        Effect.flatMap((response) => response.json),
        Effect.scoped
      )

    const health = httpClient.execute(
      HttpClientRequest.get(`${baseUrl}/health`)
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.tap((body) => Effect.logInfo(JSON.stringify(body))),
      Effect.scoped
    )

    return { initialize, sendMessage, getHistory, health } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
```

Note: The service tag changes from `"cli/ChatClient"` to `"client/ChatClient"` and we add a `getHistory` method (needed by the TUI to load history on startup).

**Step 4: Create `packages/client/src/index.ts`**

```typescript
export { ChatClient } from "./ChatClient.js"
```

**Step 5: Replace `packages/cli/src/RuntimeClient.ts` with re-export**

```typescript
export { ChatClient } from "@template/client/ChatClient"
```

**Step 6: Update `packages/cli/package.json`**

Add to `dependencies`:
```json
"@template/client": "workspace:^"
```

**Step 7: Update `packages/cli/tsconfig.src.json`**

Add client to references:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "references": [
    { "path": "../domain" },
    { "path": "../client" }
  ],
  "compilerOptions": {
    "types": ["node"],
    "outDir": "build/src",
    "tsBuildInfoFile": ".tsbuildinfo/src.tsbuildinfo",
    "rootDir": "src"
  }
}
```

**Step 8: Update root `tsconfig.json`**

Add client reference:
```json
{
  "extends": "./tsconfig.base.json",
  "include": [],
  "references": [
    { "path": "packages/cli" },
    { "path": "packages/client" },
    { "path": "packages/domain" },
    { "path": "packages/server" }
  ]
}
```

**Step 9: Update `tsconfig.base.json`**

Add client paths:
```json
"@template/client": ["./packages/client/src/index.js"],
"@template/client/*": ["./packages/client/src/*.js"],
"@template/client/test/*": ["./packages/client/test/*.js"]
```

**Step 10: Install dependencies and verify**

Run: `bun install`
Run: `bun run check`
Expected: No type errors.

Run: `bun run test`
Expected: All existing tests pass (the CLI tests use `ChatClient` via the re-export — should be transparent).

**Step 11: Commit**

```bash
git add packages/client/ packages/cli/src/RuntimeClient.ts packages/cli/package.json packages/cli/tsconfig.src.json tsconfig.json tsconfig.base.json
git commit -m "refactor: extract ChatClient to shared packages/client"
```

---

### Task 2: Scaffold `packages/tui` with OpenTUI + React

Create the TUI package with dependencies, tsconfig, and a minimal "hello world" that renders to the terminal.

**Files:**
- Create: `packages/tui/package.json`
- Create: `packages/tui/tsconfig.json`
- Create: `packages/tui/tsconfig.src.json`
- Create: `packages/tui/tsconfig.test.json`
- Create: `packages/tui/tsconfig.build.json`
- Create: `packages/tui/src/bin.tsx`
- Create: `packages/tui/src/App.tsx`
- Modify: `tsconfig.json` (add tui reference)
- Modify: `tsconfig.base.json` (add tui paths)
- Modify: `package.json` (add `tui` script)

**Step 1: Create `packages/tui/package.json`**

```json
{
  "name": "@template/tui",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "description": "Terminal UI for the personal agent",
  "repository": {
    "type": "git",
    "url": "<PLACEHOLDER>",
    "directory": "packages/tui"
  },
  "scripts": {
    "dev": "bun --watch src/bin.tsx",
    "check": "tsc -b tsconfig.json",
    "test": "vitest",
    "coverage": "vitest --coverage"
  },
  "dependencies": {
    "@effect/atom-react": "4.0.0-beta.11",
    "@effect/platform-bun": "4.0.0-beta.11",
    "@opentui/core": "^0.1.83",
    "@opentui/react": "^0.1.83",
    "@template/client": "workspace:^",
    "@template/domain": "workspace:^",
    "effect": "4.0.0-beta.11",
    "react": "^19.2.4"
  },
  "devDependencies": {
    "@types/react": "^19.2.2"
  }
}
```

**Step 2: Create tsconfig files**

`packages/tui/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": [],
  "references": [
    { "path": "tsconfig.src.json" },
    { "path": "tsconfig.test.json" }
  ]
}
```

`packages/tui/tsconfig.src.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "references": [
    { "path": "../domain" },
    { "path": "../client" }
  ],
  "compilerOptions": {
    "types": ["node"],
    "outDir": "build/src",
    "tsBuildInfoFile": ".tsbuildinfo/src.tsbuildinfo",
    "rootDir": "src",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react"
  }
}
```

`packages/tui/tsconfig.test.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["test"],
  "references": [
    { "path": "tsconfig.src.json" },
    { "path": "../domain" },
    { "path": "../client" }
  ],
  "compilerOptions": {
    "types": ["node"],
    "tsBuildInfoFile": ".tsbuildinfo/test.tsbuildinfo",
    "rootDir": "test",
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react"
  }
}
```

`packages/tui/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.src.json",
  "references": [
    { "path": "../domain/tsconfig.build.json" },
    { "path": "../client/tsconfig.build.json" }
  ],
  "compilerOptions": {
    "types": ["node"],
    "tsBuildInfoFile": ".tsbuildinfo/build.tsbuildinfo",
    "outDir": "build/esm",
    "declarationDir": "build/dts",
    "stripInternal": true
  }
}
```

**Step 3: Create `packages/tui/src/App.tsx`**

A minimal app that proves rendering works:

```tsx
import * as React from "react"

export function App() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <box border="solid" padding={1}>
        <text content="Personal Agent TUI" fg="cyan" />
      </box>
      <box flexGrow={1} padding={1}>
        <text content="Loading..." />
      </box>
    </box>
  )
}
```

**Step 4: Create `packages/tui/src/bin.tsx`**

```tsx
#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App.tsx"

const renderer = await createCliRenderer()
const root = createRoot(renderer)
root.render(<App />)
```

**Step 5: Update root `tsconfig.json`**

Add tui reference:
```json
{
  "extends": "./tsconfig.base.json",
  "include": [],
  "references": [
    { "path": "packages/cli" },
    { "path": "packages/client" },
    { "path": "packages/domain" },
    { "path": "packages/server" },
    { "path": "packages/tui" }
  ]
}
```

**Step 6: Update `tsconfig.base.json`**

Add tui paths:
```json
"@template/tui": ["./packages/tui/src/index.js"],
"@template/tui/*": ["./packages/tui/src/*.js"],
"@template/tui/test/*": ["./packages/tui/test/*.js"]
```

**Step 7: Add `tui` script to root `package.json`**

Add to scripts:
```json
"tui": "bun packages/tui/src/bin.tsx"
```

**Step 8: Install and verify**

Run: `bun install` (installs @opentui/core, @opentui/react, @effect/atom-react, react)
Run: `bun run check`
Expected: No type errors.

Run: `bun run tui`
Expected: Terminal clears and shows a bordered box with "Personal Agent TUI" in cyan and "Loading..." below. Ctrl+C exits.

**Step 9: Commit**

```bash
git add packages/tui/ tsconfig.json tsconfig.base.json package.json
git commit -m "feat: scaffold packages/tui with OpenTUI + React"
```

---

### Task 3: Atom State Layer — session atoms and types

Create the Effect Atom state layer: writable atoms for messages, tool events, connection status, and derived atoms.

**Files:**
- Create: `packages/tui/src/types.ts`
- Create: `packages/tui/src/atoms/session.ts`

**Step 1: Create `packages/tui/src/types.ts`**

```typescript
export interface ChatMessage {
  readonly role: "user" | "assistant"
  readonly content: string
  readonly turnId: string
  readonly status: "streaming" | "complete" | "failed"
  readonly errorMessage?: string | undefined
}

export interface ToolEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly inputJson: string
  readonly outputJson: string | null
  readonly isError: boolean
  readonly status: "called" | "completed"
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"
```

**Step 2: Create `packages/tui/src/atoms/session.ts`**

```typescript
import * as Atom from "effect/unstable/reactivity/Atom"
import type { ChatMessage, ConnectionStatus, ToolEvent } from "../types.js"

// --- Writable atoms (source of truth) ---

export const channelIdAtom = Atom.make<string>("")
export const messagesAtom = Atom.make<ReadonlyArray<ChatMessage>>([])
export const toolEventsAtom = Atom.make<ReadonlyArray<ToolEvent>>([])
export const connectionStatusAtom = Atom.make<ConnectionStatus>("disconnected")
export const isStreamingAtom = Atom.make<boolean>(false)
export const inputHistoryAtom = Atom.make<ReadonlyArray<string>>([])

// --- Derived atoms (computed) ---

export const lastMessageAtom = Atom.make((get) => {
  const msgs = get(messagesAtom)
  return msgs.length > 0 ? msgs[msgs.length - 1] ?? null : null
})

export const activeToolsAtom = Atom.make((get) =>
  get(toolEventsAtom).filter((t) => t.status === "called")
)

export const messageCountAtom = Atom.make((get) => get(messagesAtom).length)
```

**Step 3: Verify**

Run: `bun run check`
Expected: No type errors.

**Step 4: Commit**

```bash
git add packages/tui/src/types.ts packages/tui/src/atoms/
git commit -m "feat: add Effect Atom state layer for TUI session"
```

---

### Task 4: `useSendMessage` Hook — SSE Stream → Atom Bridge

Create the hook that calls `ChatClient.sendMessage` and dispatches `TurnStreamEvent`s into atoms via `AtomRegistry`.

**Files:**
- Create: `packages/tui/src/hooks/useSendMessage.ts`

**Step 1: Create `packages/tui/src/hooks/useSendMessage.ts`**

```typescript
import { ChatClient } from "@template/client/ChatClient"
import type { TurnStreamEvent } from "@template/domain/events"
import { Effect, Stream } from "effect"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import * as React from "react"
import { RegistryContext } from "@effect/atom-react"
import {
  channelIdAtom,
  connectionStatusAtom,
  inputHistoryAtom,
  isStreamingAtom,
  messagesAtom,
  toolEventsAtom
} from "../atoms/session.js"
import type { ChatMessage, ToolEvent } from "../types.js"

export function useSendMessage(client: typeof ChatClient.Type) {
  const registry = React.useContext(RegistryContext)

  return React.useCallback(
    (content: string) => {
      const chId = registry.get(channelIdAtom)
      if (!chId || !content.trim()) return

      // Append user message immediately
      const turnId = `turn:${crypto.randomUUID()}`
      const userMsg: ChatMessage = {
        role: "user",
        content,
        turnId,
        status: "complete"
      }
      registry.update(messagesAtom, (msgs) => [...msgs, userMsg])
      registry.update(inputHistoryAtom, (history) => [...history, content])
      registry.set(isStreamingAtom, true)

      const program = Effect.gen(function*() {
        const eventStream = yield* client.sendMessage(chId, content)
        yield* eventStream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => dispatchEvent(registry, event))
          ),
          Stream.runDrain
        )
      }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            registry.update(messagesAtom, (msgs) => {
              const last = msgs[msgs.length - 1]
              if (last && last.status === "streaming") {
                return [
                  ...msgs.slice(0, -1),
                  { ...last, status: "failed" as const, errorMessage: String(error) }
                ]
              }
              return msgs
            })
            registry.set(connectionStatusAtom, "error")
          })
        ),
        Effect.ensuring(Effect.sync(() => registry.set(isStreamingAtom, false)))
      )

      Effect.runFork(program)
    },
    [registry, client]
  )
}

function dispatchEvent(
  registry: AtomRegistry.AtomRegistry,
  event: TurnStreamEvent
): void {
  switch (event.type) {
    case "turn.started": {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        turnId: event.turnId,
        status: "streaming"
      }
      registry.update(messagesAtom, (msgs) => [...msgs, assistantMsg])
      break
    }
    case "assistant.delta": {
      registry.update(messagesAtom, (msgs) => {
        if (msgs.length === 0) return msgs
        const last = msgs[msgs.length - 1]!
        return [
          ...msgs.slice(0, -1),
          { ...last, content: last.content + event.delta }
        ]
      })
      break
    }
    case "tool.call": {
      const toolEvent: ToolEvent = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputJson: event.inputJson,
        outputJson: null,
        isError: false,
        status: "called"
      }
      registry.update(toolEventsAtom, (events) => [...events, toolEvent])
      break
    }
    case "tool.result": {
      registry.update(toolEventsAtom, (events) =>
        events.map((t) =>
          t.toolCallId === event.toolCallId
            ? { ...t, outputJson: event.outputJson, isError: event.isError, status: "completed" as const }
            : t
        )
      )
      break
    }
    case "turn.completed": {
      registry.update(messagesAtom, (msgs) => {
        if (msgs.length === 0) return msgs
        const last = msgs[msgs.length - 1]!
        return [...msgs.slice(0, -1), { ...last, status: "complete" as const }]
      })
      break
    }
    case "turn.failed": {
      registry.update(messagesAtom, (msgs) => {
        if (msgs.length === 0) return msgs
        const last = msgs[msgs.length - 1]!
        return [
          ...msgs.slice(0, -1),
          { ...last, status: "failed" as const, errorMessage: `${event.errorCode}: ${event.message}` }
        ]
      })
      break
    }
  }
}
```

**Step 2: Verify**

Run: `bun run check`
Expected: No type errors.

**Step 3: Commit**

```bash
git add packages/tui/src/hooks/
git commit -m "feat: add useSendMessage hook — SSE stream to Atom bridge"
```

---

### Task 5: UI Components — ChatPane, ToolPane, InputBar, StatusBar

Build all the terminal UI components.

**Files:**
- Create: `packages/tui/src/components/MessageBubble.tsx`
- Create: `packages/tui/src/components/ChatPane.tsx`
- Create: `packages/tui/src/components/ToolPane.tsx`
- Create: `packages/tui/src/components/InputBar.tsx`
- Create: `packages/tui/src/components/StatusBar.tsx`

**Step 1: Create `packages/tui/src/components/MessageBubble.tsx`**

```tsx
import * as React from "react"
import type { ChatMessage } from "../types.js"

export function MessageBubble({ message }: { readonly message: ChatMessage }) {
  const label = message.role === "user" ? "> " : ""
  const statusIndicator = message.status === "streaming" ? " ..." : ""
  const fg = message.role === "user" ? "green" : message.status === "failed" ? "red" : "white"

  return (
    <box flexDirection="column">
      <text
        content={`${label}${message.content}${statusIndicator}`}
        fg={fg}
      />
      {message.errorMessage ? (
        <text content={`  [error: ${message.errorMessage}]`} fg="red" />
      ) : null}
    </box>
  )
}
```

**Step 2: Create `packages/tui/src/components/ChatPane.tsx`**

```tsx
import { useAtomValue } from "@effect/atom-react"
import * as React from "react"
import { messagesAtom } from "../atoms/session.js"
import { MessageBubble } from "./MessageBubble.js"

export function ChatPane() {
  const messages = useAtomValue(messagesAtom)

  return (
    <box flexDirection="column" flexGrow={2} border="solid" padding={1}>
      <text content=" Chat " fg="cyan" />
      <scrollbox flexGrow={1}>
        {messages.length === 0 ? (
          <text content="No messages yet. Type below to start." fg="gray" />
        ) : (
          messages.map((msg, i) => (
            <MessageBubble key={`${msg.turnId}-${i}`} message={msg} />
          ))
        )}
      </scrollbox>
    </box>
  )
}
```

**Step 3: Create `packages/tui/src/components/ToolPane.tsx`**

```tsx
import { useAtomValue } from "@effect/atom-react"
import * as React from "react"
import { toolEventsAtom } from "../atoms/session.js"

export function ToolPane() {
  const toolEvents = useAtomValue(toolEventsAtom)

  return (
    <box flexDirection="column" flexGrow={1} border="solid" padding={1}>
      <text content=" Tools " fg="yellow" />
      <scrollbox flexGrow={1}>
        {toolEvents.length === 0 ? (
          <text content="No tool calls." fg="gray" />
        ) : (
          toolEvents.map((tool) => (
            <box key={tool.toolCallId} flexDirection="column">
              <text
                content={`${tool.status === "called" ? "⏳" : tool.isError ? "❌" : "✓"} ${tool.toolName}`}
                fg={tool.isError ? "red" : tool.status === "called" ? "yellow" : "green"}
              />
              {tool.outputJson ? (
                <text content={`  → ${tool.outputJson.slice(0, 80)}`} fg="gray" />
              ) : null}
            </box>
          ))
        )}
      </scrollbox>
    </box>
  )
}
```

**Step 4: Create `packages/tui/src/components/InputBar.tsx`**

```tsx
import { useAtomValue } from "@effect/atom-react"
import * as React from "react"
import { isStreamingAtom } from "../atoms/session.js"

export function InputBar({
  onSubmit
}: {
  readonly onSubmit: (content: string) => void
}) {
  const isStreaming = useAtomValue(isStreamingAtom)

  const handleSubmit = React.useCallback(
    (value: string) => {
      if (isStreaming || !value.trim()) return
      onSubmit(value.trim())
    },
    [onSubmit, isStreaming]
  )

  return (
    <box border="solid" padding={0}>
      <text content={isStreaming ? " streaming... " : " > "} fg={isStreaming ? "yellow" : "green"} />
      <input
        placeholder="Type a message..."
        focused={!isStreaming}
        onSubmit={handleSubmit}
        flexGrow={1}
      />
    </box>
  )
}
```

**Step 5: Create `packages/tui/src/components/StatusBar.tsx`**

```tsx
import { useAtomValue } from "@effect/atom-react"
import * as React from "react"
import { channelIdAtom, connectionStatusAtom, isStreamingAtom, messageCountAtom } from "../atoms/session.js"

export function StatusBar() {
  const channelId = useAtomValue(channelIdAtom)
  const status = useAtomValue(connectionStatusAtom)
  const isStreaming = useAtomValue(isStreamingAtom)
  const count = useAtomValue(messageCountAtom)

  const shortId = channelId.length > 20 ? `${channelId.slice(0, 20)}...` : channelId
  const statusColor = status === "connected" ? "green" : status === "error" ? "red" : "yellow"
  const streamLabel = isStreaming ? " | streaming" : ""

  return (
    <box>
      <text
        content={` ${shortId} | ${status}${streamLabel} | ${count} msgs | Ctrl+C to exit `}
        fg={statusColor}
      />
    </box>
  )
}
```

**Step 6: Verify**

Run: `bun run check`
Expected: No type errors.

**Step 7: Commit**

```bash
git add packages/tui/src/components/
git commit -m "feat: add TUI components — ChatPane, ToolPane, InputBar, StatusBar"
```

---

### Task 6: Wire Up `App.tsx` — Full Layout with Atom Registry and ChatClient

Connect all components into the `App`, create the `AtomRegistry`, initialize the channel, and wire the `useSendMessage` hook.

**Files:**
- Modify: `packages/tui/src/App.tsx`
- Modify: `packages/tui/src/bin.tsx`

**Step 1: Rewrite `packages/tui/src/App.tsx`**

```tsx
import { ChatClient } from "@template/client/ChatClient"
import { RegistryContext } from "@effect/atom-react"
import { BunHttpClient } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import * as React from "react"
import { channelIdAtom, connectionStatusAtom } from "./atoms/session.js"
import { ChatPane } from "./components/ChatPane.js"
import { InputBar } from "./components/InputBar.js"
import { StatusBar } from "./components/StatusBar.js"
import { ToolPane } from "./components/ToolPane.js"
import { useSendMessage } from "./hooks/useSendMessage.js"

// Build the ChatClient once at module scope
const ClientLive = ChatClient.layer.pipe(Layer.provide(BunHttpClient.layer))
const client = Effect.runSync(
  Layer.buildWithMemoMap(ClientLive, Effect.unsafeMakeMemoMap()).pipe(
    Effect.map(() => Effect.runSync(ChatClient.make.pipe(Effect.provide(BunHttpClient.layer))))
  )
)

const registry = AtomRegistry.make()

export function App() {
  const sendMessage = useSendMessage(client)

  // Initialize channel on mount
  React.useEffect(() => {
    const chId = `channel:${crypto.randomUUID()}`
    registry.set(channelIdAtom, chId)
    registry.set(connectionStatusAtom, "connecting")

    const init = client.initialize(chId, "agent:bootstrap").pipe(
      Effect.tap(() => Effect.sync(() => registry.set(connectionStatusAtom, "connected"))),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          registry.set(connectionStatusAtom, "error")
          // eslint-disable-next-line no-console
          console.error("Failed to initialize channel:", error)
        })
      )
    )
    Effect.runFork(init)
  }, [])

  return (
    <RegistryContext.Provider value={registry}>
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="row" flexGrow={1}>
          <ChatPane />
          <ToolPane />
        </box>
        <InputBar onSubmit={sendMessage} />
        <StatusBar />
      </box>
    </RegistryContext.Provider>
  )
}
```

**Note:** The `ChatClient` instantiation here is a first pass. The `Effect.runSync` approach works for a synchronous config read. If this causes issues (e.g., async config), we'll refactor to `Effect.runPromise` in the entry point and pass client as a prop. The important thing is getting the wiring right — we can clean this up.

**Step 2: Update `packages/tui/src/bin.tsx`**

```tsx
#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App.js"

const renderer = await createCliRenderer()
const root = createRoot(renderer)
root.render(<App />)
```

**Step 3: Verify**

Run: `bun run check`
Expected: No type errors.

Run: `bun run start` (in another terminal — starts the server)
Run: `bun run tui`
Expected: Multi-pane TUI renders. Status bar shows channel ID and "connected". Typing a message and pressing Enter sends it to the server. Assistant response streams in the ChatPane. Tool calls appear in the ToolPane.

**Step 4: Commit**

```bash
git add packages/tui/src/App.tsx packages/tui/src/bin.tsx
git commit -m "feat: wire TUI layout with Atom registry and ChatClient"
```

---

### Task 7: Keyboard Navigation and Polish

Add focus cycling (Tab), exit handling (Ctrl+C), and input history (Up/Down).

**Files:**
- Modify: `packages/tui/src/App.tsx` (add keyboard handler)
- Modify: `packages/tui/src/components/InputBar.tsx` (input history)

This task is intentionally left high-level — the exact OpenTUI keyboard API (`useKeyboard`) may need experimentation. The key behaviors:

1. **Ctrl+C** — exit cleanly (OpenTUI may handle this by default)
2. **Tab** — cycle focus between InputBar and ToolPane scroll
3. **Up/Down in input** — cycle through `inputHistoryAtom`

Implement the simplest version that works. If OpenTUI's focus model doesn't support Tab cycling easily, skip it for this slice.

**Step 1: Add keyboard handling to InputBar**

Add `Up` arrow support to cycle input history. Read `inputHistoryAtom` from the registry and cycle through previous entries.

**Step 2: Verify**

Run: `bun run tui`
Expected: Ctrl+C exits. Up arrow in input shows previous messages.

**Step 3: Commit**

```bash
git add packages/tui/src/
git commit -m "feat: add keyboard navigation to TUI"
```

---

### Task 8: End-to-End Verification

Verify the full flow: start server, launch TUI, send a message, see streaming response, see tool calls.

**Step 1: Start the server**

Run: `bun run start`
Expected: Server starts on configured port (default 3000), JSON logs appear.

**Step 2: Launch the TUI**

Run: `bun run tui`
Expected: Multi-pane layout renders. Status bar shows "connected".

**Step 3: Send a message**

Type "Hello, what can you do?" and press Enter.
Expected:
- User message appears in ChatPane with `>` prefix
- Status changes to "streaming"
- Assistant response streams in character by character
- If tools are called, they appear in ToolPane
- On completion, status returns to "connected"

**Step 4: Verify error handling**

Stop the server (Ctrl+C in server terminal).
Send another message in the TUI.
Expected: Error state shown (status bar turns red, message shows failed).

**Step 5: Commit any fixes**

If adjustments were needed, commit them:
```bash
git add -A
git commit -m "fix: TUI end-to-end adjustments"
```

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `packages/client/package.json` | Create | 1 |
| `packages/client/tsconfig*.json` | Create (4 files) | 1 |
| `packages/client/src/ChatClient.ts` | Create (moved from CLI) | 1 |
| `packages/client/src/index.ts` | Create | 1 |
| `packages/cli/src/RuntimeClient.ts` | Modify (re-export) | 1 |
| `packages/cli/package.json` | Modify | 1 |
| `packages/cli/tsconfig.src.json` | Modify | 1 |
| `tsconfig.json` | Modify | 1, 2 |
| `tsconfig.base.json` | Modify | 1, 2 |
| `packages/tui/package.json` | Create | 2 |
| `packages/tui/tsconfig*.json` | Create (4 files) | 2 |
| `packages/tui/src/bin.tsx` | Create | 2, 6 |
| `packages/tui/src/App.tsx` | Create | 2, 6 |
| `packages/tui/src/types.ts` | Create | 3 |
| `packages/tui/src/atoms/session.ts` | Create | 3 |
| `packages/tui/src/hooks/useSendMessage.ts` | Create | 4 |
| `packages/tui/src/components/MessageBubble.tsx` | Create | 5 |
| `packages/tui/src/components/ChatPane.tsx` | Create | 5 |
| `packages/tui/src/components/ToolPane.tsx` | Create | 5 |
| `packages/tui/src/components/InputBar.tsx` | Create | 5, 7 |
| `packages/tui/src/components/StatusBar.tsx` | Create | 5 |
| `package.json` | Modify (add `tui` script) | 2 |

## Verification

```bash
bun run check           # typecheck — no errors
bun run test            # full suite — no regressions
bun run start           # server starts (separate terminal)
bun run tui             # TUI launches, connects, chat works
```
