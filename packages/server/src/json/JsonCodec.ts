import { Option, Schema } from "effect"

const JsonUnknown = Schema.fromJsonString(Schema.Unknown)
const decodeJsonUnknown = Schema.decodeOption(JsonUnknown)

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const parseJsonRecordOption = (
  value: string
): Option.Option<Record<string, unknown>> => {
  const parsed = Option.getOrNull(decodeJsonUnknown(value))
  return isJsonRecord(parsed)
    ? Option.some(parsed)
    : Option.none()
}

export const safeJsonParseUnknown = (value: string): unknown | string =>
  Option.getOrElse(decodeJsonUnknown(value), () => value)

export const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ value: String(value) })
  }
}
