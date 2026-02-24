import { Command } from "effect/unstable/cli"
import { RuntimeClient } from "./RuntimeClient.js"

const status = Command.make("status").pipe(
  Command.withDescription("Show runtime kickoff status"),
  Command.withHandler(() => RuntimeClient.use((client) => client.status))
)

const command = Command.make("agent").pipe(
  Command.withSubcommands([status])
)

export const cli = Command.run(command, {
  version: "0.0.0"
})
