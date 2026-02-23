import { TodosApi } from "@template/domain/TodosApi"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { TodosRepository } from "./TodosRepository.js"

const TodosApiLive = HttpApiBuilder.group(TodosApi, "todos", (handlers) =>
  Effect.gen(function*() {
    const todos = yield* TodosRepository
    return handlers
      .handle("getAllTodos", () => todos.getAll)
      .handle("getTodoById", (_) => todos.getById(_.params.id))
      .handle("createTodo", (_) => todos.create(_.payload.text))
      .handle("completeTodo", (_) => todos.complete(_.params.id))
      .handle("removeTodo", (_) => todos.remove(_.params.id))
  }))

export const ApiLive = HttpApiBuilder.layer(TodosApi).pipe(
  Layer.provide(TodosApiLive)
)
