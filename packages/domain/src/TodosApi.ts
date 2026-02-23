import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

export const TodoId = Schema.Number.pipe(Schema.brand("TodoId"))
export type TodoId = typeof TodoId.Type

export const TodoIdFromString = Schema.NumberFromString.pipe(
  Schema.brand("TodoId")
)

const NonEmptyTrimmedString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed())

export class Todo extends Schema.Class<Todo>("Todo")({
  id: TodoId,
  text: NonEmptyTrimmedString,
  done: Schema.Boolean
}) {}

export class TodoNotFound extends Schema.ErrorClass<TodoNotFound>("TodoNotFound")({
  _tag: Schema.tag("TodoNotFound"),
  id: Schema.Number
}, {
  httpApiStatus: 404
}) {}

export class TodosApiGroup extends HttpApiGroup.make("todos")
  .add(
    HttpApiEndpoint.get("getAllTodos", "/todos", {
      success: Schema.Array(Todo)
    }),
    HttpApiEndpoint.get("getTodoById", "/todos/:id", {
      params: { id: TodoIdFromString },
      success: Todo,
      error: TodoNotFound
    }),
    HttpApiEndpoint.post("createTodo", "/todos", {
      success: Todo,
      payload: Schema.Struct({ text: NonEmptyTrimmedString })
    }),
    HttpApiEndpoint.patch("completeTodo", "/todos/:id", {
      params: { id: TodoIdFromString },
      success: Todo,
      error: TodoNotFound
    }),
    HttpApiEndpoint.delete("removeTodo", "/todos/:id", {
      params: { id: TodoIdFromString },
      success: Schema.Void,
      error: TodoNotFound
    })
  )
{}

export class TodosApi extends HttpApi.make("api").add(TodosApiGroup) {}
