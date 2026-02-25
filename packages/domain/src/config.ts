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

export const GenerationConfigSchema = Schema.Struct({
  temperature: Schema.Number,
  maxOutputTokens: Schema.Number,
  topP: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number)
})
export type GenerationConfig = typeof GenerationConfigSchema.Type

export const AgentProfileSchema = Schema.Struct({
  persona: PersonaSchema,
  model: ModelRefSchema,
  generation: GenerationConfigSchema
})
export type AgentProfile = typeof AgentProfileSchema.Type

export const ServerConfigSchema = Schema.Struct({
  port: Schema.Number
})
export type ServerConfig = typeof ServerConfigSchema.Type

export const AgentConfigFileSchema = Schema.Struct({
  providers: Schema.Record(Schema.String, ProviderConfigSchema),
  agents: Schema.Record(Schema.String, AgentProfileSchema),
  server: ServerConfigSchema
})
export type AgentConfigFile = typeof AgentConfigFileSchema.Type
