#!/usr/bin/env bun

import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { cli } from "./Cli.js"
import { RuntimeClient } from "./RuntimeClient.js"

const MainLive = RuntimeClient.layer.pipe(
  Layer.provide(BunHttpClient.layer),
  Layer.merge(BunServices.layer)
)

cli.pipe(
  Effect.provide(MainLive),
  BunRuntime.runMain
)
