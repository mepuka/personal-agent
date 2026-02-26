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
