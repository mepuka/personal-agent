import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { AgentStatePortMemory } from "./AgentStatePortMemory.js"
import { ApiLive } from "./Api.js"
import { GovernancePortMemory } from "./GovernancePortMemory.js"
import { MemoryPortMemory } from "./MemoryPortMemory.js"
import { SchedulePortMemory } from "./SchedulePortMemory.js"
import { SchedulerRuntime } from "./SchedulerRuntime.js"
import { SessionTurnPortMemory } from "./SessionTurnPortMemory.js"

const schedulePortLayer = SchedulePortMemory.layer

const PortsLive = Layer.mergeAll(
  AgentStatePortMemory.layer,
  SessionTurnPortMemory.layer,
  MemoryPortMemory.layer,
  GovernancePortMemory.layer,
  schedulePortLayer,
  SchedulerRuntime.layer.pipe(
    Layer.provide(schedulePortLayer)
  )
)

const HttpLive = HttpRouter.serve(
  ApiLive.pipe(Layer.provide(PortsLive))
).pipe(
  Layer.provideMerge(BunHttpServer.layer({ port: 3000 }))
)

Layer.launch(HttpLive).pipe(
  BunRuntime.runMain
)
