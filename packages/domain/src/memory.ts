import { Schema } from "effect"
import { MemoryScope, MemorySource, MemoryTier, SensitivityLevel } from "./status.js"

export const StoreItemInput = Schema.Struct({
  tier: MemoryTier,
  scope: MemoryScope,
  source: MemorySource,
  content: Schema.String,
  metadataJson: Schema.optional(Schema.String),
  generatedByTurnId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  sensitivity: Schema.optional(SensitivityLevel)
})
export type StoreItemInput = typeof StoreItemInput.Type

export const MemoryItemRecordSchema = Schema.Struct({
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
  wasGeneratedBy: Schema.Union([Schema.String, Schema.Null]),
  wasAttributedTo: Schema.Union([Schema.String, Schema.Null]),
  governedByRetention: Schema.Union([Schema.String, Schema.Null]),
  lastAccessTime: Schema.Union([Schema.DateTimeUtc, Schema.Null]),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type MemoryItemRecordSchema = typeof MemoryItemRecordSchema.Type

export const RetrieveQuery = Schema.Struct({
  query: Schema.String,
  tier: Schema.optional(MemoryTier),
  scope: Schema.optional(MemoryScope),
  limit: Schema.optional(Schema.Number)
})
export type RetrieveQuery = typeof RetrieveQuery.Type

export const ForgetFilter = Schema.Struct({
  cutoffDate: Schema.optional(Schema.DateTimeUtc),
  scope: Schema.optional(MemoryScope),
  itemIds: Schema.optional(Schema.Array(Schema.String))
})
export type ForgetFilter = typeof ForgetFilter.Type
