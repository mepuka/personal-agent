import type { AgentId, SessionId } from "@template/domain/ids"
import type { AgentProfile } from "@template/domain/config"
import type { TurnRecord } from "@template/domain/ports"
import { DateTime, Effect, FileSystem, Layer, Path, ServiceMap } from "effect"
import { AgentConfig } from "../ai/AgentConfig.js"
import { SessionTurnPortTag } from "../PortTags.js"

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface TranscriptProjectorService {
  readonly appendTurn: (
    agentId: AgentId,
    sessionId: SessionId,
    turn: TurnRecord
  ) => Effect.Effect<void>

  readonly projectSession: (
    agentId: AgentId,
    sessionId: SessionId,
    turns: ReadonlyArray<TurnRecord>
  ) => Effect.Effect<void>

  readonly projectFromStore: (
    agentId: AgentId,
    sessionId: SessionId
  ) => Effect.Effect<void>
}

export class TranscriptProjector extends ServiceMap.Service<TranscriptProjector>()(
  "server/memory/TranscriptProjector",
  {
    make: Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const agentConfig = yield* AgentConfig
      const sessionTurnPort = yield* SessionTurnPortTag
      const configPath = process.env.PA_CONFIG_PATH ?? "agent.yaml"
      const configDir = pathService.dirname(pathService.resolve(configPath))

      const resolveTranscriptPath = (
        _agentId: AgentId,
        sessionId: SessionId,
        profile: AgentProfile
      ): string | null => {
        const transcriptConfig = profile.memoryRoutines?.transcripts
        if (!transcriptConfig?.enabled) return null
        const transcriptDir = pathService.resolve(configDir, transcriptConfig.directory)
        return pathService.join(transcriptDir, sessionId, "transcript.md")
      }

      const appendTurn: TranscriptProjectorService["appendTurn"] = (agentId, sessionId, turn) =>
        Effect.gen(function*() {
          const profile = yield* agentConfig.getAgent(agentId)
          const filePath = resolveTranscriptPath(agentId, sessionId, profile)
          if (!filePath) return

          const rendered = renderTurn(turn)
          yield* appendFileWithDirs(fs, pathService, filePath, rendered)
        })

      const projectSession: TranscriptProjectorService["projectSession"] = (agentId, sessionId, turns) =>
        Effect.gen(function*() {
          const profile = yield* agentConfig.getAgent(agentId)
          const filePath = resolveTranscriptPath(agentId, sessionId, profile)
          if (!filePath) return

          const content = renderTranscript(turns)
          yield* writeFileWithDirs(fs, pathService, filePath, content)
        })

      const projectFromStore: TranscriptProjectorService["projectFromStore"] = (agentId, sessionId) =>
        Effect.gen(function*() {
          const turns = yield* sessionTurnPort.listTurns(sessionId)
          yield* projectSession(agentId, sessionId, turns)
        })

      return { appendTurn, projectSession, projectFromStore } satisfies TranscriptProjectorService
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const writeFileWithDirs = (
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  filePath: string,
  content: string
) =>
  Effect.gen(function*() {
    yield* fs.makeDirectory(pathService.dirname(filePath), { recursive: true })
    yield* fs.writeFileString(filePath, content)
  })

const appendFileWithDirs = (
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  filePath: string,
  content: string
) =>
  Effect.gen(function*() {
    yield* fs.makeDirectory(pathService.dirname(filePath), { recursive: true })
    const existing = yield* fs.readFileString(filePath).pipe(
      Effect.catchTag("PlatformError", (e) =>
        e.reason._tag === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(e)
      )
    )
    yield* fs.writeFileString(filePath, existing + content)
  })

// ---------------------------------------------------------------------------
// Renderers (pure)
// ---------------------------------------------------------------------------

const renderTranscript = (turns: ReadonlyArray<TurnRecord>): string => {
  const lines: string[] = []
  lines.push("# Session Transcript")
  lines.push("")

  for (const turn of turns) {
    lines.push(renderTurn(turn))
  }

  return lines.join("\n")
}

const renderTurn = (turn: TurnRecord): string => {
  const lines: string[] = []
  const role = turn.participantRole === "UserRole" ? "user" : "assistant"
  const createdAt = DateTime.formatIso(turn.createdAt)

  lines.push(`## Turn ${turn.turnIndex} (${role}) — ${createdAt}`)
  lines.push("")

  for (const block of turn.message.contentBlocks) {
    switch (block.contentBlockType) {
      case "TextBlock":
        lines.push(block.text)
        lines.push("")
        break
      case "ToolUseBlock":
        lines.push(`[Tool: ${block.toolName}]`)
        lines.push(`Input: ${block.inputJson}`)
        lines.push("")
        break
      case "ToolResultBlock":
        lines.push(`Result (${block.toolName}): ${block.outputJson}`)
        lines.push("")
        break
      case "ImageBlock":
        lines.push(`[Image: ${block.altText ?? "no alt text"}]`)
        lines.push("")
        break
    }
  }

  return lines.join("\n")
}

export { renderTurn as _renderTurn, renderTranscript as _renderTranscript }
