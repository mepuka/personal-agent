/** Hard ceiling on maxToolIterations regardless of agent config. */
export const MAX_TOOL_ITERATIONS_CAP = 200

/** Timeout for the tool loop per turn (seconds). */
export const TURN_LOOP_TIMEOUT_SECONDS = 15

/** Default pagination limit for governance/invocation HTTP queries. */
export const DEFAULT_PAGINATION_LIMIT = 100

/** Maximum pagination limit for governance/invocation HTTP queries. */
export const MAX_PAGINATION_LIMIT = 500

/** Scheduler tick interval (seconds). */
export const SCHEDULER_TICK_SECONDS = 10

/** Default token capacity for new agent state. */
export const DEFAULT_TOKEN_CAPACITY = 200_000

/** Default max tool iterations per turn. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 10

/** Memory entity defaults by operation. */
export const DEFAULT_MEMORY_SEARCH_LIMIT = 20
export const DEFAULT_MEMORY_RETRIEVE_LIMIT = 10
export const DEFAULT_MEMORY_LIST_LIMIT = 20
export const DEFAULT_MEMORY_FORGET_LIMIT = 50
export const MAX_MEMORY_RETRIEVE_LIMIT = 50
