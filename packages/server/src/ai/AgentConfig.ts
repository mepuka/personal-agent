import type { AgentProfile, ProviderConfig } from "@template/domain/config"
import { AgentConfigFileSchema } from "@template/domain/config"
import { Effect, Layer, Schema, ServiceMap } from "effect"
import { readFileSync } from "node:fs"

export class AgentProfileNotFound extends Schema.ErrorClass<AgentProfileNotFound>(
  "AgentProfileNotFound"
)({
  _tag: Schema.tag("AgentProfileNotFound"),
  agentId: Schema.String
}) {}

export interface AgentConfigService {
  readonly providers: Map<string, ProviderConfig>
  readonly agents: Map<string, AgentProfile>
  readonly server: { readonly port: number }
  readonly defaultAgent: AgentProfile
  readonly getAgent: (agentId: string) => Effect.Effect<AgentProfile, AgentProfileNotFound>
}

const makeFromParsed = (raw: unknown): Effect.Effect<AgentConfigService> =>
  Effect.gen(function*() {
    const config = yield* Schema.decodeUnknownEffect(AgentConfigFileSchema)(raw).pipe(
      Effect.mapError((e) => new Error(`Invalid agent config: ${e.message}`)),
      Effect.orDie
    )

    const providers = new Map(Object.entries(config.providers))
    const agents = new Map(Object.entries(config.agents))

    const defaultAgent = agents.get("default")
    if (!defaultAgent) {
      return yield* Effect.die(new Error("agent.yaml must define a 'default' agent profile"))
    }

    const getAgent = (agentId: string): Effect.Effect<AgentProfile, AgentProfileNotFound> => {
      // Exact match first, then map well-known bootstrap ID to default
      const profile = agents.get(agentId)
        ?? (agentId === "agent:bootstrap" ? agents.get("default") : undefined)
      if (!profile) {
        return Effect.fail(new AgentProfileNotFound({ agentId }))
      }
      return Effect.succeed(profile)
    }

    return {
      providers,
      agents,
      server: config.server,
      defaultAgent,
      getAgent
    } satisfies AgentConfigService
  })

export class AgentConfig extends ServiceMap.Service<AgentConfig>()(
  "server/ai/AgentConfig",
  {
    make: Effect.gen(function*() {
      const configPath = process.env.PA_CONFIG_PATH ?? "agent.yaml"
      const yamlContent = yield* Effect.try(() =>
        readFileSync(configPath, "utf-8")
      ).pipe(
        Effect.mapError(() =>
          new Error(
            `Could not read ${configPath}. Run 'agent init' to create one.`
          )
        ),
        Effect.orDie
      )

      const raw = yield* Effect.try(() => Bun.YAML.parse(yamlContent)).pipe(
        Effect.mapError((e) =>
          new Error(`Failed to parse ${configPath}: ${e instanceof Error ? e.message : String(e)}`)
        ),
        Effect.orDie
      )

      return yield* makeFromParsed(raw)
    })
  }
) {
  static layer = Layer.effect(this, this.make)

  static layerFromParsed(raw: unknown) {
    return Layer.effect(this, makeFromParsed(raw))
  }
}
