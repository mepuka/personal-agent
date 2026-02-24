import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { ApiLive } from "./Api.js"

const HttpLive = HttpRouter.serve(
  ApiLive
).pipe(
  Layer.provideMerge(BunHttpServer.layer({ port: 3000 }))
)

Layer.launch(HttpLive).pipe(
  BunRuntime.runMain
)
