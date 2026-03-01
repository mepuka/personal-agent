import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { Instant } from "@template/domain/ports"
import { DateTime, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { CliSpawnFailed, type CliRuntimeError } from "../src/tools/cli/CliErrors.js"
import { CliRuntime } from "../src/tools/cli/CliRuntime.js"
import type { CliRunRequest, CliRunResult } from "../src/tools/cli/CliTypes.js"
import { CommandRuntime } from "../src/tools/command/CommandRuntime.js"
import { FilePathPolicy, type FilePathPolicyService } from "../src/tools/file/FilePathPolicy.js"
import { FileRuntime } from "../src/tools/file/FileRuntime.js"
import { ToolExecution } from "../src/tools/ToolExecution.js"

interface CliCall {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

const instant = (input: string): Instant => DateTime.fromDateUnsafe(new Date(input))

const makeCliResult = (params: {
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
} = {}): CliRunResult => ({
  pid: 1234,
  exitCode: params.exitCode ?? 0,
  stdout: params.stdout ?? "",
  stderr: params.stderr ?? "",
  truncatedStdout: false,
  truncatedStderr: false,
  startedAt: instant("2026-02-28T00:00:00.000Z"),
  completedAt: instant("2026-02-28T00:00:00.000Z")
})

const makeFilePathPolicyLayer = (): Layer.Layer<FilePathPolicy> => {
  const workspaceRoot = process.cwd()

  const service: FilePathPolicyService = {
    resolveForRead: (inputPath) =>
      Effect.succeed({
        requestedPath: inputPath,
        lexicalPath: resolve(workspaceRoot, inputPath),
        canonicalPath: resolve(workspaceRoot, inputPath),
        workspaceRoot
      }),
    resolveForWrite: (inputPath) =>
      Effect.succeed({
        requestedPath: inputPath,
        lexicalPath: resolve(workspaceRoot, inputPath),
        canonicalPath: resolve(workspaceRoot, inputPath),
        workspaceRoot
      }),
    resolveForEdit: (inputPath) =>
      Effect.succeed({
        requestedPath: inputPath,
        lexicalPath: resolve(workspaceRoot, inputPath),
        canonicalPath: resolve(workspaceRoot, inputPath),
        workspaceRoot
      })
  }

  return Layer.succeed(FilePathPolicy, service)
}

const makeLayer = (
  runCli: (request: CliRunRequest) => Effect.Effect<CliRunResult, CliRuntimeError>
) => {
  const cliLayer = CliRuntime.fromExecution(runCli)

  const commandRuntimeLayer = Layer.succeed(CommandRuntime, {
    execute: () =>
      Effect.die("CommandRuntime.execute should not be called in ToolExecution CLI fallback tests")
  })

  const fileRuntimeLayer = Layer.succeed(FileRuntime, {
    read: () =>
      Effect.die("FileRuntime.read should not be called in ToolExecution CLI fallback tests"),
    write: () =>
      Effect.die("FileRuntime.write should not be called in ToolExecution CLI fallback tests"),
    edit: () =>
      Effect.die("FileRuntime.edit should not be called in ToolExecution CLI fallback tests")
  })

  const sqlLayer = Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient)

  return ToolExecution.layer.pipe(
    Layer.provide(cliLayer),
    Layer.provide(commandRuntimeLayer),
    Layer.provide(fileRuntimeLayer),
    Layer.provide(makeFilePathPolicyLayer()),
    Layer.provide(sqlLayer),
    Layer.provide(NodeServices.layer)
  )
}

describe("ToolExecution", () => {
  it.effect("findFiles falls back to find when fd spawn fails", () => {
    const relativeDir = `tmp/tool-execution-find-${crypto.randomUUID()}`
    const absoluteDir = join(process.cwd(), relativeDir)
    mkdirSync(join(absoluteDir, "nested"), { recursive: true })
    writeFileSync(join(absoluteDir, "nested", "find-me.txt"), "match", "utf8")

    const calls: Array<CliCall> = []
    const layer = makeLayer((request) => {
      calls.push({
        command: request.command,
        args: request.args ?? []
      })

      if (request.command === "fd") {
        return Effect.fail(new CliSpawnFailed({ reason: "fd missing" }))
      }
      if (request.command === "find") {
        return Effect.succeed(
          makeCliResult({
            stdout: `${join(absoluteDir, "nested", "find-me.txt")}\n`
          })
        )
      }

      return Effect.fail(new CliSpawnFailed({ reason: `unexpected command ${request.command}` }))
    })

    return Effect.gen(function*() {
      const toolExecution = yield* ToolExecution
      const result = yield* toolExecution.findFiles({
        path: relativeDir,
        pattern: "find-me"
      })

      expect(result.matches).toEqual(["nested/find-me.txt"])
      expect(calls.map((call) => call.command)).toEqual(["fd", "find"])
      expect(calls[0]?.args).toContain("--glob")
      expect(calls[0]?.args).toContain("*find-me*")
      expect(calls[1]?.args).toContain("-name")
      expect(calls[1]?.args).toContain("*find-me*")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => rmSync(absoluteDir, { recursive: true, force: true }))
      )
    )
  })

  it.effect("grepFiles falls back to grep when rg spawn fails and passes include/literal flags", () => {
    const relativeDir = `tmp/tool-execution-grep-${crypto.randomUUID()}`
    const absoluteDir = join(process.cwd(), relativeDir)
    mkdirSync(absoluteDir, { recursive: true })
    writeFileSync(join(absoluteDir, "match.txt"), "literal a+b(c)\n", "utf8")

    const calls: Array<CliCall> = []
    const layer = makeLayer((request) => {
      calls.push({
        command: request.command,
        args: request.args ?? []
      })

      if (request.command === "rg") {
        return Effect.fail(new CliSpawnFailed({ reason: "rg missing" }))
      }
      if (request.command === "grep") {
        return Effect.succeed(
          makeCliResult({
            stdout: `${join(absoluteDir, "match.txt")}:1:literal a+b(c)\n`
          })
        )
      }

      return Effect.fail(new CliSpawnFailed({ reason: `unexpected command ${request.command}` }))
    })

    return Effect.gen(function*() {
      const toolExecution = yield* ToolExecution
      const result = yield* toolExecution.grepFiles({
        path: relativeDir,
        pattern: "a+b(c)",
        include: "*.txt",
        literalText: true
      })

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]?.path).toBe("match.txt")
      expect(result.matches[0]?.line).toBe(1)
      expect(calls.map((call) => call.command)).toEqual(["rg", "grep"])
      expect(calls[0]?.args).toContain("-F")
      expect(calls[0]?.args).toContain("--glob")
      expect(calls[0]?.args).toContain("*.txt")
      expect(calls[1]?.args).toContain("-F")
      expect(calls[1]?.args).toContain("--include")
      expect(calls[1]?.args).toContain("*.txt")
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => rmSync(absoluteDir, { recursive: true, force: true }))
      )
    )
  })

  it.effect("grepFiles rejects empty include before invoking CLI", () => {
    const calls: Array<CliCall> = []
    const layer = makeLayer((request) => {
      calls.push({
        command: request.command,
        args: request.args ?? []
      })
      return Effect.fail(new CliSpawnFailed({ reason: "should not be called" }))
    })

    return Effect.gen(function*() {
      const toolExecution = yield* ToolExecution
      const failure = yield* toolExecution.grepFiles({
        pattern: "needle",
        include: "  "
      }).pipe(
        Effect.flip
      )

      expect(failure.errorCode).toBe("InvalidFileRequest")
      expect(calls).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })
})
