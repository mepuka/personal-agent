import { Schema } from "effect"

export const PermissionMode = Schema.Literals([
  "Permissive",
  "Standard",
  "Restrictive"
])
export type PermissionMode = typeof PermissionMode.Type

export const AgentRole = Schema.Literals([
  "SystemRole",
  "UserRole",
  "AssistantRole",
  "ToolRole"
])
export type AgentRole = typeof AgentRole.Type

export const AuthorizationDecision = Schema.Literals([
  "Allow",
  "Deny",
  "RequireApproval"
])
export type AuthorizationDecision = typeof AuthorizationDecision.Type

export const ComplianceStatus = Schema.Literals([
  "Compliant",
  "NonCompliant"
])
export type ComplianceStatus = typeof ComplianceStatus.Type

export const PolicySelector = Schema.Literals([
  "AllTools",
  "SafeStandardTools",
  "ExplicitToolList",
  "UnknownTool",
  "MissingAgent",
  "InvalidRequest",
  "GovernanceError"
])
export type PolicySelector = typeof PolicySelector.Type

export const ToolSourceKind = Schema.Literals([
  "BuiltIn",
  "Integration"
])
export type ToolSourceKind = typeof ToolSourceKind.Type

export const ContentBlockType = Schema.Literals([
  "TextBlock",
  "ToolUseBlock",
  "ToolResultBlock",
  "ImageBlock"
])
export type ContentBlockType = typeof ContentBlockType.Type

export const ScheduleStatus = Schema.Literals([
  "ScheduleActive",
  "SchedulePaused",
  "ScheduleExpired",
  "ScheduleDisabled"
])
export type ScheduleStatus = typeof ScheduleStatus.Type

export const ConcurrencyPolicy = Schema.Literals([
  "ConcurrencyAllow",
  "ConcurrencyForbid",
  "ConcurrencyReplace"
])
export type ConcurrencyPolicy = typeof ConcurrencyPolicy.Type

export const ExecutionOutcome = Schema.Literals([
  "ExecutionSucceeded",
  "ExecutionFailed",
  "ExecutionSkipped"
])
export type ExecutionOutcome = typeof ExecutionOutcome.Type

export const QuotaPeriod = Schema.Literals([
  "Daily",
  "Monthly",
  "Yearly",
  "Lifetime"
])
export type QuotaPeriod = typeof QuotaPeriod.Type

export const ModelFinishReason = Schema.Literals([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "pause",
  "other",
  "unknown"
])
export type ModelFinishReason = typeof ModelFinishReason.Type

export const ChannelType = Schema.Literals([
  "CLI",
  "Messaging",
  "WebChat",
  "APIChannel",
  "VoiceChannel",
  "EmailChannel"
])
export type ChannelType = typeof ChannelType.Type

export const ChannelCapability = Schema.Literals([
  "SendText",
  "SendFile",
  "Reactions",
  "Threads",
  "ReadReceipts",
  "Typing",
  "StreamingDelivery"
])
export type ChannelCapability = typeof ChannelCapability.Type

export const MemorySortOrder = Schema.Literals([
  "CreatedDesc",
  "CreatedAsc"
])
export type MemorySortOrder = typeof MemorySortOrder.Type

export const IntegrationStatus = Schema.Literals([
  "Connected",
  "Disconnected",
  "Error",
  "Initializing"
])
export type IntegrationStatus = typeof IntegrationStatus.Type

export const ConnectionStatus = Schema.Literals([
  "Open",
  "Closed",
  "Reconnecting",
  "Failed"
])
export type ConnectionStatus = typeof ConnectionStatus.Type

export const ServiceTransport = Schema.Literals([
  "stdio",
  "sse",
  "http"
])
export type ServiceTransport = typeof ServiceTransport.Type

// --- Memory enums (aligned with PAO ontology) ---

export const MemoryTier = Schema.Literals([
  "WorkingMemory",
  "EpisodicMemory",
  "SemanticMemory",
  "ProceduralMemory"
])
export type MemoryTier = typeof MemoryTier.Type

export const MemoryScope = Schema.Literals([
  "SessionScope",
  "GlobalScope"
])
export type MemoryScope = typeof MemoryScope.Type

export const MemorySource = Schema.Literals([
  "UserSource",
  "SystemSource",
  "AgentSource"
])
export type MemorySource = typeof MemorySource.Type

export const SensitivityLevel = Schema.Literals([
  "Public",
  "Internal",
  "Confidential",
  "Restricted"
])
export type SensitivityLevel = typeof SensitivityLevel.Type
