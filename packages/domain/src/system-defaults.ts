import type { SubroutineToolScope } from "./memory.js"
import type { MemoryScope, MemorySource, MemoryTier, SensitivityLevel } from "./status.js"

/** Hard ceiling on maxToolIterations regardless of agent config. */
export const MAX_TOOL_ITERATIONS_CAP = 200

/** Timeout for the tool loop per turn (seconds). */
export const TURN_LOOP_TIMEOUT_SECONDS = 120

/** Default pagination limit for governance/invocation HTTP queries. */
export const DEFAULT_PAGINATION_LIMIT = 100

/** Maximum pagination limit for governance/invocation HTTP queries. */
export const MAX_PAGINATION_LIMIT = 500

/** Scheduler tick interval (seconds). */
export const SCHEDULER_TICK_SECONDS = 10

/** Default token capacity for new agent state. */
export const DEFAULT_TOKEN_CAPACITY = 200_000

/** Default max tool iterations per turn. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 200

/** Memory entity defaults by operation. */
export const DEFAULT_MEMORY_SEARCH_LIMIT = 20
export const DEFAULT_MEMORY_RETRIEVE_LIMIT = 10
export const DEFAULT_MEMORY_LIST_LIMIT = 20
export const DEFAULT_MEMORY_FORGET_LIMIT = 50
export const MAX_MEMORY_RETRIEVE_LIMIT = 50

/** Subroutine defaults. */
export const DEFAULT_SUBROUTINE_QUEUE_CAPACITY = 64
export const DEFAULT_SUBROUTINE_MAX_ITERATIONS = 5
export const DEFAULT_SUBROUTINE_TOOL_CONCURRENCY = "inherit" as const
export const DEFAULT_TRACE_RETENTION_DAYS = 30
export const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 1800
export const DEFAULT_CONTEXT_PRESSURE_RESERVE_TOKENS = 4000
export const DEFAULT_SUBROUTINE_DEDUPE_WINDOW_SECONDS = 30
export const DEFAULT_TRANSCRIPT_DIRECTORY = "transcripts"
export const DEFAULT_TRACE_DIRECTORY = "traces/memory"
export const DEFAULT_IDLE_CHECK_INTERVAL_SECONDS = 60

/** Memory domain defaults. */
export const DEFAULT_SUBROUTINE_TOOL_SCOPE: SubroutineToolScope = {
  fileRead: true,
  fileWrite: false,
  shell: false,
  memoryRead: true,
  memoryWrite: true,
  notification: false
}

export const DEFAULT_SENSITIVITY_LEVEL: SensitivityLevel = "Internal"
export const DEFAULT_MEMORY_TIER: MemoryTier = "SemanticMemory"
export const DEFAULT_MEMORY_SCOPE: MemoryScope = "GlobalScope"
export const DEFAULT_MEMORY_SOURCE: MemorySource = "AgentSource"

/** Post-commit outbox dispatch. */
export const POST_COMMIT_TICK_SECONDS = 5
export const POST_COMMIT_CLAIM_BATCH_SIZE = 10
export const POST_COMMIT_CLAIM_LEASE_SECONDS = 60
export const POST_COMMIT_MAX_ATTEMPTS = 5
