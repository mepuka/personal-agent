/**
 * Effect Schema definitions for agent.yaml configuration.
 *
 * Ontology alignment:
 *   PersonaSchema          → pao:Persona (hasContent = systemPrompt)
 *   ModelRefSchema         → pao:FoundationModel (hasModelId, hasProvider)
 *   GenerationConfigSchema → pao:GenerationConfiguration (hasTemperature, hasMaxOutputTokens, hasTopP, hasSeed)
 *   ProviderConfigSchema   → pao:ModelProvider (credentials)
 *
 * Future slices will add: operatesInMode, hasAvailableTool, hasIntegration,
 * hasExternalService, hasHook — per PAO AIAgent SHACL constraints.
 */
import { Schema } from "effect"

import { MemoryRoutinesConfig } from "./memory.js"
import {
  DEFAULT_ARTIFACT_COMPRESSION,
  DEFAULT_ARTIFACT_PREVIEW_MAX_BYTES,
  DEFAULT_COMPACTION_ARTIFACT_BYTES,
  DEFAULT_COMPACTION_COOLDOWN_SECONDS,
  DEFAULT_COMPACTION_FILE_TOUCHES,
  DEFAULT_COMPACTION_TOKEN_PRESSURE_RATIO,
  DEFAULT_COMPACTION_TOOL_RESULT_BYTES,
  DEFAULT_INLINE_TOOL_RESULT_MAX_BYTES,
  DEFAULT_TOKEN_CAPACITY,
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_MEMORY_RETRIEVE_LIMIT,
  DEFAULT_STORAGE_ROOT_DIR,
  MAX_MEMORY_RETRIEVE_LIMIT
} from "./system-defaults.js"

export const AiProviderName = Schema.Literals([
  "anthropic",
  "openai",
  "openrouter",
  "google"
])
export type AiProviderName = typeof AiProviderName.Type

export const ProviderConfigSchema = Schema.Struct({
  apiKeyEnv: Schema.String
})
export type ProviderConfig = typeof ProviderConfigSchema.Type

export const PersonaSchema = Schema.Struct({
  name: Schema.String,
  systemPrompt: Schema.String
})
export type Persona = typeof PersonaSchema.Type

export const ModelRefSchema = Schema.Struct({
  provider: AiProviderName,
  modelId: Schema.String
})
export type ModelRef = typeof ModelRefSchema.Type

export const ModelOverrideSchema = Schema.Struct({
  provider: AiProviderName,
  modelId: Schema.String
})
export type ModelOverride = typeof ModelOverrideSchema.Type

export const GenerationConfigSchema = Schema.Struct({
  temperature: Schema.Number,
  maxOutputTokens: Schema.Number,
  topP: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number)
})
export type GenerationConfig = typeof GenerationConfigSchema.Type

export const GenerationConfigOverrideSchema = Schema.Struct({
  temperature: Schema.optionalKey(Schema.Number),
  maxOutputTokens: Schema.optionalKey(Schema.Number),
  topP: Schema.optionalKey(Schema.Number)
})
export type GenerationConfigOverride = typeof GenerationConfigOverrideSchema.Type

export const MemoryLimitsSchema = Schema.Struct({
  defaultRetrieveLimit: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_MEMORY_RETRIEVE_LIMIT)
  ),
  maxRetrieveLimit: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => MAX_MEMORY_RETRIEVE_LIMIT)
  )
})
export type MemoryLimits = typeof MemoryLimitsSchema.Type

const defaultMemoryLimits = Schema.decodeUnknownSync(MemoryLimitsSchema)({})

export const RuntimeConfigSchema = Schema.Struct({
  tokenBudget: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_TOKEN_CAPACITY)
  ),
  maxToolIterations: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_MAX_TOOL_ITERATIONS)
  ),
  memory: MemoryLimitsSchema.pipe(
    Schema.withDecodingDefaultKey(() => defaultMemoryLimits)
  )
})
export type RuntimeConfig = typeof RuntimeConfigSchema.Type

const defaultRuntimeConfig = Schema.decodeUnknownSync(RuntimeConfigSchema)({})

export const AgentProfileSchema = Schema.Struct({
  persona: PersonaSchema,
  model: ModelRefSchema,
  generation: GenerationConfigSchema,
  runtime: RuntimeConfigSchema.pipe(
    Schema.withDecodingDefaultKey(() => defaultRuntimeConfig)
  ),
  memoryRoutines: Schema.optionalKey(MemoryRoutinesConfig)
})
export type AgentProfile = typeof AgentProfileSchema.Type

export const ArtifactCompressionSchema = Schema.Literals([
  "none",
  "gzip"
])
export type ArtifactCompression = typeof ArtifactCompressionSchema.Type

export const ServerStorageArtifactsConfigSchema = Schema.Struct({
  inlineToolResultMaxBytes: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_INLINE_TOOL_RESULT_MAX_BYTES)
  ),
  previewMaxBytes: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_ARTIFACT_PREVIEW_MAX_BYTES)
  ),
  compression: ArtifactCompressionSchema.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_ARTIFACT_COMPRESSION)
  )
})
export type ServerStorageArtifactsConfig = typeof ServerStorageArtifactsConfigSchema.Type

export const ServerStorageCompactionThresholdsSchema = Schema.Struct({
  tokenPressureRatio: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_COMPACTION_TOKEN_PRESSURE_RATIO)
  ),
  toolResultBytes: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_COMPACTION_TOOL_RESULT_BYTES)
  ),
  artifactBytes: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_COMPACTION_ARTIFACT_BYTES)
  ),
  fileTouches: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_COMPACTION_FILE_TOUCHES)
  )
})
export type ServerStorageCompactionThresholds =
  typeof ServerStorageCompactionThresholdsSchema.Type

const defaultServerStorageCompactionThresholds = Schema.decodeUnknownSync(
  ServerStorageCompactionThresholdsSchema
)({})

export const ServerStorageCompactionConfigSchema = Schema.Struct({
  cooldownSeconds: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_COMPACTION_COOLDOWN_SECONDS)
  ),
  thresholds: ServerStorageCompactionThresholdsSchema.pipe(
    Schema.withDecodingDefaultKey(() => defaultServerStorageCompactionThresholds)
  )
})
export type ServerStorageCompactionConfig = typeof ServerStorageCompactionConfigSchema.Type

const defaultServerStorageArtifactsConfig = Schema.decodeUnknownSync(
  ServerStorageArtifactsConfigSchema
)({})

const defaultServerStorageCompactionConfig = Schema.decodeUnknownSync(
  ServerStorageCompactionConfigSchema
)({})

export const ServerStorageConfigSchema = Schema.Struct({
  rootDir: Schema.String.pipe(
    Schema.withDecodingDefaultKey(() => DEFAULT_STORAGE_ROOT_DIR)
  ),
  artifacts: ServerStorageArtifactsConfigSchema.pipe(
    Schema.withDecodingDefaultKey(() => defaultServerStorageArtifactsConfig)
  ),
  compaction: ServerStorageCompactionConfigSchema.pipe(
    Schema.withDecodingDefaultKey(() => defaultServerStorageCompactionConfig)
  )
})
export type ServerStorageConfig = typeof ServerStorageConfigSchema.Type

const defaultServerStorageConfig = Schema.decodeUnknownSync(ServerStorageConfigSchema)({})

export const ServerConfigSchema = Schema.Struct({
  port: Schema.Number,
  storage: ServerStorageConfigSchema.pipe(
    Schema.withDecodingDefaultKey(() => defaultServerStorageConfig)
  )
})
export type ServerConfig = typeof ServerConfigSchema.Type

export const ChannelConfigSchema = Schema.Struct({
  enabled: Schema.Boolean
})
export type ChannelConfig = typeof ChannelConfigSchema.Type

export const ChannelsConfigSchema = Schema.Struct({
  cli: ChannelConfigSchema.pipe(
    Schema.withDecodingDefaultKey(() => ({ enabled: true }))
  ),
  webchat: ChannelConfigSchema.pipe(
    Schema.withDecodingDefaultKey(() => ({ enabled: true }))
  )
})
export type ChannelsConfig = typeof ChannelsConfigSchema.Type

const defaultChannelsConfig = Schema.decodeUnknownSync(ChannelsConfigSchema)({})

export const IntegrationConfigSchema = Schema.Struct({
  serviceId: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  transport: Schema.Literals(["stdio", "sse", "http"]),
  identifier: Schema.optional(Schema.String)
})
export type IntegrationConfig = typeof IntegrationConfigSchema.Type

export const IntegrationsConfigSchema = Schema.Array(IntegrationConfigSchema)
export type IntegrationsConfig = typeof IntegrationsConfigSchema.Type

export const AgentConfigFileSchema = Schema.Struct({
  providers: Schema.Record(Schema.String, ProviderConfigSchema),
  agents: Schema.Record(Schema.String, AgentProfileSchema),
  server: ServerConfigSchema,
  channels: ChannelsConfigSchema.pipe(
    Schema.withDecodingDefaultKey(() => defaultChannelsConfig)
  ),
  integrations: IntegrationsConfigSchema.pipe(
    Schema.withDecodingDefaultKey(() => [] as IntegrationsConfig)
  )
})
export type AgentConfigFile = typeof AgentConfigFileSchema.Type
