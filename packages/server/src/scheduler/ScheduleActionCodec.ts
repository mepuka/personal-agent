import {
  BackgroundAction,
  type BackgroundAction as BackgroundActionModel
} from "@template/domain/ports"
import { Schema } from "effect"

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
