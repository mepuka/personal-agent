import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { SessionId } from "@template/domain/ids"
import { Effect, Layer } from "effect"
import { basename, join } from "node:path"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { CommandInvocationContext } from "../src/tools/command/CommandTypes.js"
import { FileHookError } from "../src/tools/file/FileErrors.js"
import { FileHooks, type FileHook } from "../src/tools/file/FileHooks.js"
import { FilePathPolicy } from "../src/tools/file/FilePathPolicy.js"
import { FileReadTracker } from "../src/tools/file/FileReadTracker.js"
import { FileRuntime } from "../src/tools/file/FileRuntime.js"

const defaultContext: CommandInvocationContext = {
  source: "tool",
  sessionId: "session:file-runtime" as SessionId
}

const makeRuntimeLayer = (hooks?: ReadonlyArray<FileHook>) => {
  const fileHooksLayer = hooks === undefined
    ? FileHooks.layer
    : FileHooks.fromHooks(hooks)
  const filePathPolicyLayer = FilePathPolicy.layer.pipe(
    Layer.provide(NodeServices.layer)
  )
  const fileReadTrackerLayer = FileReadTracker.layer

  return FileRuntime.layer.pipe(
    Layer.provide(fileHooksLayer),
    Layer.provide(fileReadTrackerLayer),
    Layer.provide(filePathPolicyLayer),
    Layer.provide(NodeServices.layer)
  )
}

const makeFixture = (name: string): string => {
  const fixtureRoot = join(process.cwd(), "tmp", `${name}-${crypto.randomUUID()}`)
  mkdirSync(fixtureRoot, { recursive: true })
  return fixtureRoot
}

describe("FileRuntime", () => {
  it.effect("reads files and runs before/after hooks in order", () => {
    const fixtureRoot = makeFixture("file-runtime-read")
    const relativePath = join("tmp", basename(fixtureRoot), "sample.txt")
    const absolutePath = join(process.cwd(), relativePath)
    const order: Array<string> = []

    writeFileSync(absolutePath, "hello runtime", "utf8")

    return Effect.gen(function*() {
      const runtime = yield* FileRuntime
      const result = yield* runtime.read({
        context: defaultContext,
        path: relativePath
      })

      expect(result.content).toBe("hello runtime")
      expect(order).toEqual(["before", "after"])
    }).pipe(
      Effect.provide(makeRuntimeLayer([
        {
          id: "before-read",
          beforeRead: () =>
            Effect.sync(() => {
              order.push("before")
            })
        },
        {
          id: "after-read",
          afterRead: () =>
            Effect.sync(() => {
              order.push("after")
            })
        }
      ])),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })

  it.effect("returns FileNotFound for missing reads", () =>
    Effect.gen(function*() {
      const runtime = yield* FileRuntime
      const error = yield* runtime.read({
        context: defaultContext,
        path: `tmp/file-runtime-missing-${crypto.randomUUID()}.txt`
      }).pipe(Effect.flip)
      expect(error._tag).toBe("FileNotFound")
    }).pipe(
      Effect.provide(makeRuntimeLayer())
    )
  )

  it.effect("rejects read paths outside workspace", () =>
    Effect.gen(function*() {
      const runtime = yield* FileRuntime
      const error = yield* runtime.read({
        context: defaultContext,
        path: "../outside.txt"
      }).pipe(Effect.flip)
      expect(error._tag).toBe("FileWorkspaceViolation")
    }).pipe(
      Effect.provide(makeRuntimeLayer())
    )
  )

  it.effect("rejects stale writes after tracked reads", () => {
    const fixtureRoot = makeFixture("file-runtime-stale")
    const relativePath = join("tmp", basename(fixtureRoot), "stale.txt")
    const absolutePath = join(process.cwd(), relativePath)

    writeFileSync(absolutePath, "initial", "utf8")

    return Effect.gen(function*() {
      const runtime = yield* FileRuntime

      yield* runtime.read({
        context: defaultContext,
        path: relativePath
      })

      writeFileSync(absolutePath, "changed externally", "utf8")

      const error = yield* runtime.write({
        context: defaultContext,
        request: {
          path: relativePath,
          content: "new-runtime-content"
        }
      }).pipe(Effect.flip)

      expect(error._tag).toBe("FileStaleRead")
    }).pipe(
      Effect.provide(makeRuntimeLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })

  it.effect("allows untracked writes and records bytes written", () => {
    const fixtureRoot = makeFixture("file-runtime-write")
    const relativePath = join("tmp", basename(fixtureRoot), "write.txt")
    const absolutePath = join(process.cwd(), relativePath)

    return Effect.gen(function*() {
      const runtime = yield* FileRuntime
      const result = yield* runtime.write({
        context: defaultContext,
        request: {
          path: relativePath,
          content: "write from runtime"
        }
      })

      expect(result.bytesWritten).toBeGreaterThan(0)
      expect(readFileSync(absolutePath, "utf8")).toBe("write from runtime")
    }).pipe(
      Effect.provide(makeRuntimeLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })

  it.effect("maps beforeWrite hook failures to FileHookRejected", () => {
    const fixtureRoot = makeFixture("file-runtime-hook-reject")
    const relativePath = join("tmp", basename(fixtureRoot), "hook.txt")

    return Effect.gen(function*() {
      const runtime = yield* FileRuntime
      const error = yield* runtime.write({
        context: defaultContext,
        request: {
          path: relativePath,
          content: "blocked"
        }
      }).pipe(Effect.flip)

      expect(error._tag).toBe("FileHookRejected")
      if (error._tag === "FileHookRejected") {
        expect(error.hookId).toBe("reject-all")
      }
    }).pipe(
      Effect.provide(makeRuntimeLayer([
        {
          id: "reject-all",
          beforeWrite: () =>
            Effect.fail(
              new FileHookError({
                reason: "blocked by test hook"
              })
            )
        }
      ])),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })

  it.effect("edits files with a unique match and returns unified diff", () => {
    const fixtureRoot = makeFixture("file-runtime-edit")
    const relativePath = join("tmp", basename(fixtureRoot), "edit.txt")
    const absolutePath = join(process.cwd(), relativePath)

    writeFileSync(absolutePath, "hello world\n", "utf8")

    return Effect.gen(function*() {
      const runtime = yield* FileRuntime
      const result = yield* runtime.edit({
        context: defaultContext,
        request: {
          path: relativePath,
          oldString: "hello world",
          newString: "hello effect"
        }
      })

      expect(result.diff).toContain("--- a/")
      expect(readFileSync(absolutePath, "utf8")).toContain("hello effect")
    }).pipe(
      Effect.provide(makeRuntimeLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })

  it.effect("rejects ambiguous and missing edit targets", () => {
    const fixtureRoot = makeFixture("file-runtime-edit-failures")
    const ambiguousRelativePath = join("tmp", basename(fixtureRoot), "ambiguous.txt")
    const ambiguousAbsolutePath = join(process.cwd(), ambiguousRelativePath)
    const missingRelativePath = join("tmp", basename(fixtureRoot), "missing.txt")
    const missingAbsolutePath = join(process.cwd(), missingRelativePath)

    writeFileSync(ambiguousAbsolutePath, "token\nmiddle\ntoken\n", "utf8")
    writeFileSync(missingAbsolutePath, "another file", "utf8")

    return Effect.gen(function*() {
      const runtime = yield* FileRuntime

      const ambiguous = yield* runtime.edit({
        context: defaultContext,
        request: {
          path: ambiguousRelativePath,
          oldString: "token",
          newString: "patched"
        }
      }).pipe(Effect.flip)
      expect(ambiguous._tag).toBe("FileEditAmbiguous")

      const missing = yield* runtime.edit({
        context: defaultContext,
        request: {
          path: missingRelativePath,
          oldString: "not-here",
          newString: "patched"
        }
      }).pipe(Effect.flip)
      expect(missing._tag).toBe("FileEditNotFound")
    }).pipe(
      Effect.provide(makeRuntimeLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })
})
