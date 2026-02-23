import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { ApiLive } from "./Api.js"
import { TodosRepository } from "./TodosRepository.js"

const HttpLive = HttpRouter.serve(
  ApiLive.pipe(Layer.provide(TodosRepository.layer))
).pipe(
  Layer.provideMerge(BunHttpServer.layer({ port: 3000 }))
)

Layer.launch(HttpLive).pipe(
  BunRuntime.runMain
)
