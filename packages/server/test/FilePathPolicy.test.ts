import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { basename, join } from "node:path"
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { FilePathPolicy } from "../src/tools/file/FilePathPolicy.js"

const makeLayer = () =>
  FilePathPolicy.layer.pipe(
    Layer.provide(NodeServices.layer)
  )

const makeFixture = (name: string): string => {
  const fixtureRoot = join(process.cwd(), "tmp", `${name}-${crypto.randomUUID()}`)
  mkdirSync(fixtureRoot, { recursive: true })
  return fixtureRoot
}

describe("FilePathPolicy", () => {
  it.effect("rejects lexical traversal outside workspace", () =>
    Effect.gen(function*() {
      const policy = yield* FilePathPolicy
      const error = yield* policy.resolveForRead("../outside.txt").pipe(Effect.flip)
      expect(error._tag).toBe("FileWorkspaceViolation")
    }).pipe(
      Effect.provide(makeLayer())
    )
  )

  it.effect("rejects canonical alias escape through symlink", () => {
    const fixtureRoot = makeFixture("file-path-policy-canonical")
    const relativePath = join("tmp", basename(fixtureRoot), "escape", "target.txt")

    return Effect.gen(function*() {
      symlinkSync("/tmp", join(fixtureRoot, "escape"), "dir")

      const policy = yield* FilePathPolicy
      const error = yield* policy.resolveForRead(relativePath).pipe(Effect.flip)
      expect(error._tag).toBe("FileWorkspaceViolation")
    }).pipe(
      Effect.provide(makeLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })

  it.effect("rejects broken final symlink that points outside workspace", () => {
    const fixtureRoot = makeFixture("file-path-policy-broken-link")
    const relativePath = join("tmp", basename(fixtureRoot), "broken.txt")
    const outsideTarget = `/tmp/nonexistent-${crypto.randomUUID()}`

    return Effect.gen(function*() {
      symlinkSync(outsideTarget, join(fixtureRoot, "broken.txt"), "file")

      const policy = yield* FilePathPolicy
      const error = yield* policy.resolveForWrite(relativePath).pipe(Effect.flip)
      expect(error._tag).toBe("FileWorkspaceViolation")
    }).pipe(
      Effect.provide(makeLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })

  it.effect("rejects symlink hop escaping outside workspace", () => {
    const fixtureRoot = makeFixture("file-path-policy-hop")
    const relativePath = join("tmp", basename(fixtureRoot), "hop", "file.txt")

    return Effect.gen(function*() {
      symlinkSync("/tmp", join(fixtureRoot, "hop"), "dir")

      const policy = yield* FilePathPolicy
      const error = yield* policy.resolveForEdit(relativePath).pipe(Effect.flip)
      expect(error._tag).toBe("FileWorkspaceViolation")
    }).pipe(
      Effect.provide(makeLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })

  it.effect("rejects hardlinked targets for mutation paths", () => {
    const fixtureRoot = makeFixture("file-path-policy-hardlink")
    const originalPath = join(fixtureRoot, "original.txt")
    const hardlinkPath = join(fixtureRoot, "hardlink.txt")
    const relativePath = join("tmp", basename(fixtureRoot), "hardlink.txt")

    return Effect.gen(function*() {
      writeFileSync(originalPath, "linked")
      linkSync(originalPath, hardlinkPath)

      const policy = yield* FilePathPolicy
      const error = yield* policy.resolveForWrite(relativePath).pipe(Effect.flip)
      expect(error._tag).toBe("FileWorkspaceViolation")
    }).pipe(
      Effect.provide(makeLayer()),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(fixtureRoot, { recursive: true, force: true })
        })
      )
    )
  })
})
