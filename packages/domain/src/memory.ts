import { Schema } from "effect"

export const MemoryTier = Schema.Literals([
  "SemanticMemory",
  "EpisodicMemory"
])
export type MemoryTier = typeof MemoryTier.Type

export const MemoryScope = Schema.Literals([
  "SessionScope",
  "ProjectScope",
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

export const SearchQuery = Schema.Struct({
  query: Schema.optional(Schema.String),
  tier: Schema.optional(MemoryTier),
  scope: Schema.optional(MemoryScope),
  source: Schema.optional(MemorySource),
  sort: Schema.optional(Schema.Literals(["CreatedDesc", "CreatedAsc"])),
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String)
})
export type SearchQuery = typeof SearchQuery.Type

export const SearchResult = Schema.Struct({
  items: Schema.Array(Schema.Struct({
    memoryItemId: Schema.String,
    agentId: Schema.String,
    tier: MemoryTier,
    scope: MemoryScope,
    source: MemorySource,
    content: Schema.String,
    metadataJson: Schema.Union([Schema.String, Schema.Null]),
    generatedByTurnId: Schema.Union([Schema.String, Schema.Null]),
    sessionId: Schema.Union([Schema.String, Schema.Null]),
    sensitivity: SensitivityLevel,
    createdAt: Schema.DateTimeUtc,
    updatedAt: Schema.DateTimeUtc
  })),
  cursor: Schema.Union([Schema.String, Schema.Null]),
  totalCount: Schema.Number
})
export type SearchResult = typeof SearchResult.Type
