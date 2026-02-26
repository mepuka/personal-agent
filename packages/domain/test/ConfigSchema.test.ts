import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  AgentProfileSchema,
  AgentConfigFileSchema,
  ChannelConfigSchema,
  ChannelsConfigSchema,
  ProviderConfigSchema
} from "../src/config.js"

describe("Config Schemas", () => {
  it("decodes a valid provider config", () => {
    const input = { apiKeyEnv: "PA_ANTHROPIC_API_KEY" }
    const result = Schema.decodeUnknownSync(ProviderConfigSchema)(input)
    expect(result.apiKeyEnv).toBe("PA_ANTHROPIC_API_KEY")
  })

  it("decodes a valid agent profile", () => {
    const input = {
      persona: { name: "Test", systemPrompt: "You are helpful." },
      model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      generation: { temperature: 0.7, maxOutputTokens: 4096 }
    }
    const result = Schema.decodeUnknownSync(AgentProfileSchema)(input)
    expect(result.persona.name).toBe("Test")
    expect(result.model.provider).toBe("anthropic")
    expect(result.generation.temperature).toBe(0.7)
  })

  it("decodes a full config file", () => {
    const input = {
      providers: {
        anthropic: { apiKeyEnv: "PA_ANTHROPIC_API_KEY" }
      },
      agents: {
        default: {
          persona: { name: "Assistant", systemPrompt: "You are helpful." },
          model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
          generation: { temperature: 0.7, maxOutputTokens: 4096 }
        }
      },
      server: { port: 3000 }
    }
    const result = Schema.decodeUnknownSync(AgentConfigFileSchema)(input)
    expect(Object.keys(result.agents)).toEqual(["default"])
    expect(result.server.port).toBe(3000)
  })

  it("rejects invalid provider literal", () => {
    const input = {
      persona: { name: "Test", systemPrompt: "x" },
      model: { provider: "invalid-provider", modelId: "x" },
      generation: { temperature: 0.7, maxOutputTokens: 4096 }
    }
    expect(() => Schema.decodeUnknownSync(AgentProfileSchema)(input)).toThrow()
  })

  it("allows optional generation fields to be omitted", () => {
    const input = {
      persona: { name: "Test", systemPrompt: "x" },
      model: { provider: "openai", modelId: "gpt-4o" },
      generation: { temperature: 0.5, maxOutputTokens: 2048 }
    }
    const result = Schema.decodeUnknownSync(AgentProfileSchema)(input)
    expect(result.generation.topP).toBeUndefined()
    expect(result.generation.seed).toBeUndefined()
  })

  it("decodes a valid channel config", () => {
    const result = Schema.decodeUnknownSync(ChannelConfigSchema)({ enabled: true })
    expect(result.enabled).toBe(true)
  })

  it("decodes channels config with explicit values", () => {
    const result = Schema.decodeUnknownSync(ChannelsConfigSchema)({
      cli: { enabled: false },
      webchat: { enabled: true }
    })
    expect(result.cli.enabled).toBe(false)
    expect(result.webchat.enabled).toBe(true)
  })

  it("defaults omitted channel entries to enabled", () => {
    const result = Schema.decodeUnknownSync(ChannelsConfigSchema)({})
    expect(result.cli.enabled).toBe(true)
    expect(result.webchat.enabled).toBe(true)
  })

  it("defaults partial channel config (only cli specified)", () => {
    const result = Schema.decodeUnknownSync(ChannelsConfigSchema)({
      cli: { enabled: false }
    })
    expect(result.cli.enabled).toBe(false)
    expect(result.webchat.enabled).toBe(true)
  })

  it("defaults channels when omitted from full config", () => {
    const input = {
      providers: {
        anthropic: { apiKeyEnv: "PA_ANTHROPIC_API_KEY" }
      },
      agents: {
        default: {
          persona: { name: "Assistant", systemPrompt: "You are helpful." },
          model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
          generation: { temperature: 0.7, maxOutputTokens: 4096 }
        }
      },
      server: { port: 3000 }
    }
    const result = Schema.decodeUnknownSync(AgentConfigFileSchema)(input)
    expect(result.channels.cli.enabled).toBe(true)
    expect(result.channels.webchat.enabled).toBe(true)
  })

  it("decodes full config with explicit channels", () => {
    const input = {
      providers: {
        anthropic: { apiKeyEnv: "PA_ANTHROPIC_API_KEY" }
      },
      agents: {
        default: {
          persona: { name: "Assistant", systemPrompt: "You are helpful." },
          model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
          generation: { temperature: 0.7, maxOutputTokens: 4096 }
        }
      },
      server: { port: 3000 },
      channels: {
        cli: { enabled: true },
        webchat: { enabled: false }
      }
    }
    const result = Schema.decodeUnknownSync(AgentConfigFileSchema)(input)
    expect(result.channels.cli.enabled).toBe(true)
    expect(result.channels.webchat.enabled).toBe(false)
  })
})
