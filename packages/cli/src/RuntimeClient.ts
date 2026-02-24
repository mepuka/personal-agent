import { RuntimeApi } from "@template/domain/RuntimeApi"
import { Effect, Layer, ServiceMap } from "effect"
import { HttpApiClient } from "effect/unstable/httpapi"

export class RuntimeClient extends ServiceMap.Service<RuntimeClient>()("cli/RuntimeClient", {
  make: Effect.gen(function*() {
    const client = yield* HttpApiClient.make(RuntimeApi, {
      baseUrl: "http://localhost:3000"
    })

    const status = client.runtime.getStatus({}).pipe(
      Effect.flatMap((runtimeStatus) => Effect.logInfo(runtimeStatus))
    )

    return {
      status
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make)
}
