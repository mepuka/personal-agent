import {
  BackgroundAction,
  type BackgroundAction as BackgroundActionModel
} from "@template/domain/ports"
import { Schema } from "effect"

export const LEGACY_SCHEDULE_COMMAND_PREFIX = "action:command:"
export const LEGACY_MEMORY_SUBROUTINE_PREFIX = "action:memory_subroutine:"

const BackgroundActionFromJson = Schema.fromJsonString(BackgroundAction)
const decodeBackgroundActionFromJson = Schema.decodeUnknownSync(BackgroundActionFromJson)
const encodeBackgroundActionToJson = Schema.encodeSync(BackgroundActionFromJson)

export const encodeBackgroundActionPayloadJson = (action: BackgroundActionModel): string =>
  encodeBackgroundActionToJson(action)

export const decodeBackgroundActionPayloadJson = (
  payloadJson: string
): BackgroundActionModel | null => {
  try {
    return decodeBackgroundActionFromJson(payloadJson)
  } catch {
    return null
  }
}

export const decodeMaybeUriComponent = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const toLegacyActionRef = (action: BackgroundActionModel): string => {
  switch (action.kind) {
    case "Log":
      return "action:log"
    case "HealthCheck":
      return "action:health_check"
    case "Command":
      return `${LEGACY_SCHEDULE_COMMAND_PREFIX}${encodeURIComponent(action.command)}`
    case "MemorySubroutine":
      return `${LEGACY_MEMORY_SUBROUTINE_PREFIX}${action.subroutineId}`
    case "Unknown":
      return action.actionRef
  }
}

export const fromLegacyActionRef = (actionRef: string): BackgroundActionModel => {
  switch (actionRef) {
    case "action:log":
      return { kind: "Log" }
    case "action:health_check":
      return { kind: "HealthCheck" }
  }

  if (actionRef.startsWith(LEGACY_MEMORY_SUBROUTINE_PREFIX)) {
    const subroutineId = actionRef.slice(LEGACY_MEMORY_SUBROUTINE_PREFIX.length).trim()
    if (subroutineId.length > 0) {
      return { kind: "MemorySubroutine", subroutineId }
    }
  }

  if (actionRef.startsWith(LEGACY_SCHEDULE_COMMAND_PREFIX)) {
    const encodedCommand = actionRef.slice(LEGACY_SCHEDULE_COMMAND_PREFIX.length)
    return {
      kind: "Command",
      command: decodeMaybeUriComponent(encodedCommand)
    }
  }

  return { kind: "Unknown", actionRef }
}
