import { Option, Schema } from "effect"

const RecoveredToolErrorPayload = Schema.Struct({
  ok: Schema.Literal(false),
  errorCode: Schema.String,
  message: Schema.String
})
const decodeRecoveredToolErrorPayload = Schema.decodeOption(
  Schema.fromJsonString(RecoveredToolErrorPayload)
)

export const isRecoveredToolErrorOutput = (outputJson: string): boolean =>
  Option.isSome(decodeRecoveredToolErrorPayload(outputJson))
