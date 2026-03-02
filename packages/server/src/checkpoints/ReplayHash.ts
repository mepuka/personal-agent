import { Effect } from "effect"

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ value: String(value) })
  }
}

const canonicalize = (input: unknown): unknown => {
  if (Array.isArray(input)) {
    return input.map(canonicalize)
  }
  if (input !== null && typeof input === "object") {
    const objectInput = input as Record<string, unknown>
    return Object.keys(objectInput)
      .sort((a, b) => a.localeCompare(b))
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(objectInput[key])
        return acc
      }, {})
  }
  return input
}

export const canonicalJsonStringify = (value: unknown): string =>
  safeJsonStringify(canonicalize(value))

export const makeCheckpointPayloadHash = (
  action: string,
  payload: unknown
): Effect.Effect<string> => {
  const canonicalPayload = canonicalJsonStringify(payload)
  return Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${action}:${canonicalPayload}`)
    )
  ).pipe(
    Effect.map((buffer) =>
      Array.from(
        new Uint8Array(buffer),
        (byte) => byte.toString(16).padStart(2, "0")
      ).join("")
    )
  )
}
