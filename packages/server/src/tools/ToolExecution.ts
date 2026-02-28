import { Deferred, Duration, Effect, FileSystem, Layer, Option, Path, Ref, ServiceMap, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export interface ToolExecutionFailure {
  readonly errorCode: string
  readonly message: string
}

export interface ToolExecutionService {
  readonly executeShell: (params: {
    readonly command: string
    readonly cwd?: string
    readonly timeoutMs?: number
    readonly outputLimitBytes?: number
  }) => Effect.Effect<{
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  }, ToolExecutionFailure>
  readonly writeFile: (params: {
    readonly path: string
    readonly content: string
    readonly maxBytes?: number
  }) => Effect.Effect<{
    readonly path: string
    readonly bytesWritten: number
  }, ToolExecutionFailure>
  readonly sendNotification: (params: {
    readonly recipient: string
    readonly message: string
  }) => Effect.Effect<{
    readonly notificationId: string
    readonly delivered: boolean
  }, ToolExecutionFailure>
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024
const DEFAULT_FILE_MAX_BYTES = 256 * 1024
const TRUNCATED_MARKER = "\n...[truncated]"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

interface BoundedOutputState {
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
}

const emptyBoundedOutputState: BoundedOutputState = {
  text: "",
  bytes: 0,
  truncated: false
}

const fail = (errorCode: string, message: string): ToolExecutionFailure => ({
  errorCode,
  message
})

const toErrorMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message?: unknown }).message)
    : String(error)

const appendBoundedText = (
  state: BoundedOutputState,
  chunk: string,
  limitBytes: number
): BoundedOutputState => {
  if (state.bytes >= limitBytes) {
    return state.truncated ? state : { ...state, truncated: true }
  }

  const encodedChunk = textEncoder.encode(chunk)
  const nextBytes = state.bytes + encodedChunk.length

  if (nextBytes <= limitBytes) {
    return {
      text: state.text + chunk,
      bytes: nextBytes,
      truncated: state.truncated
    }
  }

  const available = Math.max(limitBytes - state.bytes, 0)
  const partial = textDecoder.decode(encodedChunk.subarray(0, available))

  return {
    text: state.text + partial,
    bytes: limitBytes,
    truncated: true
  }
}

const finalizeBoundedOutput = (state: BoundedOutputState): string =>
  state.truncated ? `${state.text}${TRUNCATED_MARKER}` : state.text

export class ToolExecution extends ServiceMap.Service<ToolExecution>()(
  "server/tools/ToolExecution",
  {
    make: Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sql = yield* SqlClient.SqlClient
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const workspaceRoot = path.resolve(process.cwd())

      const isInsideWorkspace = (targetPath: string): boolean => {
        const rel = path.relative(workspaceRoot, targetPath)
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
      }

      const resolveWorkspacePath = (inputPath?: string): Effect.Effect<string, ToolExecutionFailure> => {
        const resolved = inputPath === undefined
          ? workspaceRoot
          : path.resolve(workspaceRoot, path.normalize(inputPath))

        if (!isInsideWorkspace(resolved)) {
          return Effect.fail(
            fail("PathOutsideWorkspace", `Path is outside workspace: ${inputPath ?? resolved}`)
          )
        }
        return Effect.succeed(resolved)
      }

      const collectBoundedOutput = (
        stream: Stream.Stream<Uint8Array, unknown, never>,
        limitBytes: number
      ): Effect.Effect<string, never> =>
        Effect.gen(function*() {
          const stateRef = yield* Ref.make(emptyBoundedOutputState)

          yield* stream.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Ref.update(stateRef, (state) => appendBoundedText(state, chunk, limitBytes))
            ),
            Effect.catch(() => Effect.void)
          )

          const state = yield* Ref.get(stateRef)
          return finalizeBoundedOutput(state)
        })

      const executeShell: ToolExecutionService["executeShell"] = ({
        command,
        cwd,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES
      }) =>
        Effect.gen(function*() {
          if (command.trim().length === 0) {
            return yield* Effect.fail(
              fail("InvalidCommand", "command must be a non-empty string")
            )
          }

          if (timeoutMs <= 0) {
            return yield* Effect.fail(
              fail("InvalidTimeout", "timeoutMs must be greater than 0")
            )
          }

          if (outputLimitBytes <= 0) {
            return yield* Effect.fail(
              fail("InvalidOutputLimit", "outputLimitBytes must be greater than 0")
            )
          }

          const resolvedCwd = yield* resolveWorkspacePath(cwd)
          const shellCommand = ChildProcess.make(command, {
            cwd: resolvedCwd,
            shell: true,
            env: process.env as Record<string, string | undefined>,
            extendEnv: true,
            stdout: "pipe",
            stderr: "pipe"
          })

          return yield* Effect.scoped(
            Effect.gen(function*() {
              const handle = yield* spawner.spawn(shellCommand).pipe(
                Effect.mapError((error) => fail("ShellSpawnFailed", toErrorMessage(error)))
              )

              const stdoutDeferred = yield* Deferred.make<string>()
              const stderrDeferred = yield* Deferred.make<string>()

              const startCollector = (
                stream: Stream.Stream<Uint8Array, unknown, never>,
                deferred: Deferred.Deferred<string>
              ) =>
                collectBoundedOutput(stream, outputLimitBytes).pipe(
                  Effect.flatMap((output) => Deferred.succeed(deferred, output)),
                  Effect.forkScoped,
                  Effect.asVoid
                )

              yield* startCollector(handle.stdout, stdoutDeferred)
              yield* startCollector(handle.stderr, stderrDeferred)

              const exitCodeOption = yield* handle.exitCode.pipe(
                Effect.timeoutOption(Duration.millis(timeoutMs)),
                Effect.mapError((error) => fail("ShellExecutionFailed", toErrorMessage(error)))
              )

              if (Option.isNone(exitCodeOption)) {
                yield* handle.kill({
                  killSignal: "SIGTERM",
                  forceKillAfter: Duration.millis(250)
                }).pipe(
                  Effect.ignore
                )
                return yield* Effect.fail(
                  fail("ToolTimeout", `command timed out after ${timeoutMs}ms`)
                )
              }

              const [stdout, stderr] = yield* Effect.all([
                Deferred.await(stdoutDeferred),
                Deferred.await(stderrDeferred)
              ])

              return {
                exitCode: exitCodeOption.value,
                stdout,
                stderr
              } as const
            })
          )
        })

      const writeFile: ToolExecutionService["writeFile"] = ({
        path: filePath,
        content,
        maxBytes = DEFAULT_FILE_MAX_BYTES
      }) =>
        Effect.gen(function*() {
          if (maxBytes <= 0) {
            return yield* Effect.fail(
              fail("InvalidFileLimit", "maxBytes must be greater than 0")
            )
          }

          const bytesWritten = textEncoder.encode(content).length
          if (bytesWritten > maxBytes) {
            return yield* Effect.fail(
              fail("FileTooLarge", `content exceeds ${maxBytes} bytes`)
            )
          }

          const resolvedPath = yield* resolveWorkspacePath(filePath)
          const parent = path.dirname(resolvedPath)
          const tempPath = `${resolvedPath}.${crypto.randomUUID()}.tmp`

          yield* fs.makeDirectory(parent, { recursive: true }).pipe(
            Effect.mapError((error) => fail("FileWriteFailed", toErrorMessage(error)))
          )

          yield* fs.writeFileString(tempPath, content).pipe(
            Effect.mapError((error) => fail("FileWriteFailed", toErrorMessage(error)))
          )

          yield* fs.rename(tempPath, resolvedPath).pipe(
            Effect.mapError((error) => fail("FileWriteFailed", toErrorMessage(error)))
          )

          return { path: resolvedPath, bytesWritten } as const
        })

      const sendNotification: ToolExecutionService["sendNotification"] = ({
        recipient,
        message
      }) =>
        Effect.gen(function*() {
          if (recipient.trim().length === 0) {
            return yield* Effect.fail(
              fail("InvalidRecipient", "recipient must be a non-empty string")
            )
          }
          if (message.trim().length === 0) {
            return yield* Effect.fail(
              fail("InvalidMessage", "message must be a non-empty string")
            )
          }

          const notificationId = `notif:${crypto.randomUUID()}`

          yield* sql`
            INSERT INTO notifications (
              notification_id,
              recipient,
              message,
              delivery_status,
              created_at
            ) VALUES (
              ${notificationId},
              ${recipient},
              ${message},
              ${"Delivered"},
              ${new Date().toISOString()}
            )
          `.unprepared.pipe(
            Effect.mapError((error) =>
              fail("NotificationPersistenceFailed", toErrorMessage(error))
            )
          )

          return {
            notificationId,
            delivered: true
          } as const
        })

      return {
        executeShell,
        writeFile,
        sendNotification
      } satisfies ToolExecutionService
    })
  }
) {
  static layer = Layer.effect(this, this.make)
}
