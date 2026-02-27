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

import {
  DEFAULT_TOKEN_CAPACITY,
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_MEMORY_RETRIEVE_LIMIT,
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
  )
})
export type AgentProfile = typeof AgentProfileSchema.Type

export const ServerConfigSchema = Schema.Struct({
  port: Schema.Number
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
