import type {
  CheckpointAction as DomainCheckpointAction,
  CheckpointDecision as DomainCheckpointDecision,
  ModelFinishReason as DomainModelFinishReason
} from "@template/domain/status"

export type ChatMessageStatus =
  | "streaming"
  | "complete"
  | "failed"
  | "checkpoint_required"
  | "checkpoint_rejected"
  | "checkpoint_deferred"

export type ToolEventStatus = "called" | "completed"

export type CheckpointAction = DomainCheckpointAction
export type CheckpointDecision = DomainCheckpointDecision
export type IterationFinishReason = DomainModelFinishReason

export interface PendingCheckpoint {
  readonly checkpointId: string
  readonly action: CheckpointAction
  readonly reason: string
}

export interface ChatMessage {
  readonly role: "user" | "assistant"
  readonly content: string
  readonly turnId: string
  readonly status: ChatMessageStatus
  readonly errorMessage?: string | undefined
  readonly checkpointId?: string | undefined
  readonly checkpointAction?: CheckpointAction | undefined
  readonly checkpointReason?: string | undefined
  readonly iteration?: number | undefined
  readonly iterationFinishReason?: IterationFinishReason | undefined
  readonly toolCallsThisIteration?: number | undefined
  readonly toolCallsTotal?: number | undefined
}

export interface ToolEvent {
  readonly turnId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly inputJson: string
  readonly outputJson: string | null
  readonly isError: boolean
  readonly status: ToolEventStatus
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

export type ModalId =
  | "command-palette"
  | "session-picker"
  | "settings"
  | "memory-search"
  | "tool-inspector"

export interface ChannelSummary {
  readonly channelId: string
  readonly channelType: string
  readonly agentId: string
  readonly activeSessionId: string
  readonly activeConversationId: string
  readonly createdAt: string
  readonly lastTurnAt: string | null
  readonly messageCount: number
}
