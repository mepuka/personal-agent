import { TodoId } from "@template/domain/TodosApi"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { TodosClient } from "./TodosClient.js"

const todoArg = Argument.string("todo").pipe(
  Argument.withDescription("The message associated with a todo")
)

const todoId = Flag.integer("id").pipe(
  Flag.withSchema(TodoId),
  Flag.withDescription("The identifier of the todo")
)

const add = Command.make("add", { todo: todoArg }).pipe(
  Command.withDescription("Add a new todo"),
  Command.withHandler(({ todo }) => TodosClient.use((c) => c.create(todo)))
)

const done = Command.make("done", { id: todoId }).pipe(
  Command.withDescription("Mark a todo as done"),
  Command.withHandler(({ id }) => TodosClient.use((c) => c.complete(id)))
)

const list = Command.make("list").pipe(
  Command.withDescription("List all todos"),
  Command.withHandler(() => TodosClient.use((c) => c.list))
)

const remove = Command.make("remove", { id: todoId }).pipe(
  Command.withDescription("Remove a todo"),
  Command.withHandler(({ id }) => TodosClient.use((c) => c.remove(id)))
)

const command = Command.make("todo").pipe(
  Command.withSubcommands([add, done, list, remove])
)

export const cli = Command.run(command, {
  version: "0.0.0"
})
