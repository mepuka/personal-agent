# Personal Agent Architecture Specification

**Version**: 0.1.0-draft
**Date**: 2026-02-20
**Status**: Initial draft — pending review
**Ontology Version**: PAO v0.7.0
**Runtime**: Effect TypeScript (pure Effect)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Domain Model Overview](#2-domain-model-overview)
3. [Effect Ecosystem Mapping](#3-effect-ecosystem-mapping)
4. [Core Computational Model](#4-core-computational-model)
5. [Entity Definitions](#5-entity-definitions)
6. [Workflow Definitions](#6-workflow-definitions)
7. [Persistence Strategy](#7-persistence-strategy)
8. [Memory Architecture](#8-memory-architecture)
9. [AI Integration](#9-ai-integration)
10. [Governance & Safety](#10-governance--safety)
11. [Networking & Gateway](#11-networking--gateway)
12. [Error Handling & Recovery](#12-error-handling--recovery)
13. [Observability](#13-observability)
14. [Module-by-Module Ontology Mapping](#14-module-by-module-ontology-mapping)
15. [Package Structure](#15-package-structure)
16. [Deployment Topology](#16-deployment-topology)
17. [Open Questions](#17-open-questions)

---

## 1. Executive Summary

This document specifies the architecture for a personal AI agent system implemented in pure Effect TypeScript. The architecture is derived from the Personal Agent Ontology (PAO v0.7.0), a formal OWL 2 DL vocabulary defining 105 classes across 8 semantic modules.

The system uses **Effect Cluster** as its computational backbone — modeling agents, sessions, and memory as **durable entities** (stateful, addressable actors), and modeling reasoning, planning, and recovery as **durable workflows** with retriable **activities**. This is not a traditional layered service architecture; it is an **event-driven, actor-based system with durable execution guarantees**.

The system targets local-first deployment (single runner, SQLite persistence) with a clear path to cloud deployment (multi-runner, SQL coordination, HTTP gateway).

### Design Principles

1. **Ontology-driven**: Every type, relationship, and constraint traces back to PAO
2. **Durable by default**: Agent state, conversations, and workflows survive crashes
3. **Type-safe end-to-end**: Effect Schema as single source of truth for validation, serialization, and API contracts
4. **Local-first, cloud-ready**: Same code runs locally (single process) or distributed (multi-node)
5. **Secure and auditable**: Governance, permissions, and audit are first-class, not afterthoughts
6. **Composable**: Every component is a Layer, every operation is an Effect

---

## 2. Domain Model Overview

The PAO defines 8 semantic modules. Each module maps to specific architectural components:

| Ontology Module | Classes | Architectural Role |
|---|---|---|
| **Identity & Actors** | Agent, AIAgent, HumanUser, SubAgent, Persona, FoundationModel, ModelDeployment | Entity definitions, identity management |
| **Conversation & Interaction** | Conversation, Session, Turn, Message, ToolInvocation, ContentBlock | Session entity protocol, turn processing |
| **Memory Architecture** | MemoryTier (4), MemoryOperation (5), MemoryItem, Episode, Claim, MemoryBlock | Memory entity, persistence strategy |
| **Goals, Plans, Tasks** | Goal, Plan, Task, Belief, Desire, Intention, Deliberation, Justification | Workflow definitions, BDI reasoning |
| **Error Recovery** | ErrorRecoveryEvent, RetryAttempt, ReplanEvent, RollbackEvent, FailureType | Workflow retry/recovery semantics |
| **Governance & Safety** | PermissionPolicy, SafetyConstraint, Hook, AuditEntry, SandboxPolicy, ConsentRecord | Middleware, policy enforcement |
| **Dialog Pragmatics** | DialogAct, CommunicativeFunction, CommonGround, GroundingAct | Turn classification, grounding logic |
| **External Services** | ExternalService, Integration, ServiceCapability, ServiceConnection | Integration entity, capability discovery |

### Key Metrics

- **105 OWL classes** to be represented as Effect Schema types
- **128 object properties** defining relationships (many become entity message protocols)
- **32 data properties** defining attributes (become Schema fields)
- **65 named individuals** defining value partitions (become `Schema.Literal` unions)
- **17 disjoint value partition types** (become discriminated unions)
- **4 identity keys** (Agent, Session, Conversation, FoundationModel — become branded ID types)

---

## 3. Effect Ecosystem Mapping

### Package Dependencies

| Effect Package | Role in Architecture | Ontology Alignment |
|---|---|---|
| `effect` | Core runtime, Schema, Context, Layer, Ref, Stream, Schedule | Foundation for everything |
| `@effect/cluster` | Durable entities, sharding, workflows, activities | Agent/Session/Memory entities, Plan workflows |
| `@effect/ai` | LanguageModel service, Tool/Toolkit, Chat, streaming | ModelInvocation, ToolInvocation, Turn generation |
| `@effect/platform` | HttpApi, KeyValueStore, FileSystem | Gateway API, procedural memory storage |
| `@effect/platform-bun` | Bun runtime bindings | Local execution environment |
| `@effect/sql` | Abstract SQL client, transactions, reactive queries | Domain state persistence |
| `@effect/sql-sqlite-bun` | SQLite via Bun | Local persistence backend |
| `@effect/cli` | CLI commands, args, options | CLI interface to agent |
| `@effect/rpc` | RPC protocol definitions | Entity message schemas |

### Construct Mapping

| OWL Construct | Effect Construct | Example |
|---|---|---|
| `owl:Class` | `Schema.Class` or `Schema.TaggedClass` | `class Turn extends Schema.Class<Turn>("Turn")({...})` |
| `owl:oneOf` (value partition) | `Schema.Literal` union | `const TaskStatus = Schema.Literal("Pending", "InProgress", "Completed", "Blocked")` |
| `owl:DatatypeProperty` | Schema field | `id: Schema.String.pipe(Schema.brand("AgentId"))` |
| `owl:ObjectProperty` | Typed reference or entity message | `sessionId: SessionId` (reference) or RPC call (message) |
| `owl:hasKey` | Branded ID type | `const AgentId = Schema.String.pipe(Schema.brand("AgentId"))` |
| `owl:disjointUnionOf` | `Schema.Union` with discriminator | `const MemoryTier = Schema.Union(WorkingMemory, EpisodicMemory, ...)` |
| `owl:FunctionalProperty` | Required single-value field | `hasStatus: TaskStatus` (not an array) |
| `owl:someValuesFrom` | Required field (non-optional) | `hasPersona: Persona` (mandatory on AIAgent) |
| `owl:minQualifiedCardinality` | Branded collection with min constraint | `sharedAcrossAgents: Schema.Array(AgentId).pipe(Schema.minItems(2))` |
| `rdfs:subClassOf` | Schema `extend` or class hierarchy | `class AIAgent extends Agent.extend<AIAgent>("AIAgent")({...})` |
| `owl:TransitiveProperty` | Graph traversal in query layer | `blocks/blockedBy` resolved transitively |
| `owl:inverseOf` | Bidirectional references in storage | Both sides maintained by repository |
| `prov:wasGeneratedBy` | Provenance metadata fields | `generatedBy: EventId, attributedTo: AgentId` |

---

## 4. Core Computational Model

### The Three Pillars

The architecture rests on three Effect Cluster primitives:

#### 4.1 Entities (Stateful Durable Actors)

An **Entity** is a long-lived, addressable, stateful unit that processes typed RPC messages. Entities are the primary organizational unit of the system.

**Properties:**
- **Addressable**: Every entity has a unique address (`EntityAddress = shardId + entityType + entityId`)
- **Stateful**: Maintains internal state across messages (via Ref or external storage)
- **Durable**: Messages marked `Persisted` survive runner crashes and are replayed on recovery
- **Sharded**: Entities are distributed across runners via consistent hashing on entityId
- **Lifecycle-managed**: Idle entities are reaped; active entities stay in memory

**Entity types in this system:**

| Entity Type | Ontology Class | State | Key Messages |
|---|---|---|---|
| `AgentEntity` | AIAgent | Persona, config, active tools, permissions | Configure, GetStatus, UpdatePersona |
| `SessionEntity` | Session | Turn history, context window, working memory | ProcessTurn, GetHistory, Compact, End |
| `ConversationEntity` | Conversation | Session chain, common ground | StartSession, ContinueSession, GetGround |
| `MemoryEntity` | MemoryTier(s) | Memory items per tier | Encode, Retrieve, Consolidate, Forget |
| `IntegrationEntity` | Integration | Connection state, capabilities | Connect, Disconnect, DiscoverCapabilities |

#### 4.2 Workflows (Durable Multi-Step Processes)

A **Workflow** is a durable, multi-step computation that survives crashes. Workflows are checkpointed — on recovery, they resume from the last completed activity, not from the beginning.

**Properties:**
- **Durable**: Execution state is persisted; workflows resume after crashes
- **Composed of Activities**: Each step is an individually retriable activity
- **Checkpointed**: Progress is saved after each activity completes
- **Cancellable**: Can be interrupted and rolled back
- **Triggered by entities**: An entity can spawn a workflow in response to a message

**Workflow types in this system:**

| Workflow | Ontology Concept | Activities | Trigger |
|---|---|---|---|
| `DeliberationWorkflow` | Deliberation (BDI) | ConsiderBeliefs, ConsiderDesires, ProduceIntention, CreatePlan | Goal created or updated |
| `PlanExecutionWorkflow` | Plan + Task[] | ExecuteTask (per task, respecting dependencies) | Intention committed |
| `TurnProcessingWorkflow` | Turn + ModelInvocation | ClassifyIntent, RetrieveMemory, InvokeModel, ExecuteTools, EncodeMem | Session receives new turn |
| `ErrorRecoveryWorkflow` | ErrorRecoveryEvent | Retry, Replan, Rollback (strategy selection) | Activity failure in any workflow |
| `CompactionWorkflow` | CompactionEvent | SelectItems, Summarize, UpdateTiers, RecordDispositions | Context window approaching capacity |
| `CapabilityDiscoveryWorkflow` | CapabilityDiscoveryEvent | QueryService, ParseCapabilities, RegisterTools | Integration connected |
| `ConsolidationWorkflow` | Consolidation (MemoryOp) | SelectEpisodes, ExtractFacts, StoreSemantic, DecayEpisodic | Periodic or triggered |

#### 4.3 Activities (Retriable Units of Work)

An **Activity** is a single unit of work within a workflow. Activities are the boundary of retry — if an activity fails, it can be retried without re-executing previous activities.

**Properties:**
- **Retriable**: Failed activities can be retried with configurable schedules
- **Idempotent** (ideally): Activities should produce the same result on replay
- **Side-effecting**: Activities are where real work happens (LLM calls, DB writes, tool execution)
- **Typed**: Input and output schemas are defined, enabling durable serialization

**Key activities:**

| Activity | Ontology Concept | Side Effects | Retry Strategy |
|---|---|---|---|
| `InvokeModel` | ModelInvocation | LLM API call | Exponential backoff, 3 attempts |
| `ExecuteTool` | ToolInvocation | Tool-specific | Configurable per tool |
| `EncodeMemory` | Encoding (MemoryOp) | SQLite write | Immediate retry, 2 attempts |
| `RetrieveMemory` | Retrieval (MemoryOp) | SQLite read | Immediate retry, 2 attempts |
| `EvaluatePolicy` | PermissionPolicy check | Read policies | No retry (deterministic) |
| `WriteAuditEntry` | AuditEntry | SQLite append | Retry until success |
| `SendMessage` | Message via Channel | Network I/O | Exponential backoff |
| `ClassifyDialogAct` | DialogAct | LLM call (fast) | Exponential backoff, 2 attempts |

### How They Compose

```
User sends message
    │
    ▼
SessionEntity receives ProcessTurn message
    │
    ├─ Spawns TurnProcessingWorkflow
    │       │
    │       ├─ Activity: ClassifyDialogAct
    │       │     └─ Determines CommunicativeFunction (Inform/Request/Clarify/...)
    │       │
    │       ├─ Activity: EvaluatePolicy
    │       │     └─ Checks PermissionPolicy, SafetyConstraint
    │       │     └─ Writes AuditEntry
    │       │
    │       ├─ Activity: RetrieveMemory
    │       │     └─ Queries relevant memories across tiers
    │       │     └─ Assembles context for LLM
    │       │
    │       ├─ Activity: InvokeModel
    │       │     └─ Calls LanguageModel.generateText/streamText
    │       │     └─ Includes tool definitions from AgentEntity
    │       │     └─ Returns response with possible tool calls
    │       │
    │       ├─ Activity: ExecuteTool (0..N, parallel)
    │       │     └─ For each ToolCallPart in response
    │       │     └─ Validates against PermissionPolicy
    │       │     └─ Executes tool handler
    │       │     └─ Records ToolResult, ComplianceStatus
    │       │
    │       ├─ Activity: EncodeMemory
    │       │     └─ Stores new Episode in EpisodicMemory
    │       │     └─ Updates Claims in SemanticMemory if new facts
    │       │     └─ Updates MemoryBlocks if preferences changed
    │       │
    │       ├─ Activity: UpdateCommonGround
    │       │     └─ Records GroundingAct with AcceptanceEvidence
    │       │
    │       └─ Returns Turn with ContentBlocks
    │
    ├─ Updates context window token tracking
    │
    ├─ If context window near capacity:
    │     └─ Spawns CompactionWorkflow
    │
    └─ Sends response back to client
```

### Failure Recovery Flow

```
Activity fails (e.g., InvokeModel returns RateLimited)
    │
    ├─ Workflow engine checks retry schedule
    │     ├─ If retries remaining: RetryAttempt (increment hasAttemptCount)
    │     └─ If retries exhausted: Spawn ErrorRecoveryWorkflow
    │
    ▼
ErrorRecoveryWorkflow
    │
    ├─ Activity: ClassifyFailure
    │     └─ Determines FailureType (Timeout, AuthenticationFailure, RateLimited, etc.)
    │
    ├─ Activity: SelectStrategy (based on FailureType)
    │     ├─ Timeout/RateLimited → RetryAttempt with backoff
    │     ├─ AuthenticationFailure → Escalate to user
    │     ├─ DependencyFailure → ReplanEvent (find alternative)
    │     └─ ConfigurationError → RollbackEvent (restore last good state)
    │
    ├─ Activity: ExecuteStrategy
    │     └─ Performs selected recovery action
    │
    └─ Records hasRecoveryOutcome: "resolved" | "escalated" | "abandoned"
```

---

## 5. Entity Definitions

### 5.1 AgentEntity

**Ontology source**: `pao:AIAgent`

**Identity**: `AgentId` (branded string, `owl:hasKey`)

**State**:
```
- persona: Persona                          # pao:hasPersona
- permissionMode: PermissionMode            # pao:operatesInMode
- availableTools: Map<ToolName, ToolDef>    # pao:hasAvailableTool
- integrations: Set<IntegrationId>          # pao:hasIntegration
- model: FoundationModelConfig              # pao:usesModel
- hooks: Array<HookDefinition>              # pao:hasHook
- externalServices: Set<ServiceId>          # pao:hasExternalService
- beliefs: Map<ClaimId, Belief>             # pao:heldBelief (BDI)
- desires: Set<DesireId>                    # pao:holdsDesire (BDI)
- activeGoals: Set<GoalId>                  # pao:pursuesGoal
- sandboxPolicy: SandboxPolicy              # pao:enforcedBySandboxPolicy
```

**RPC Protocol** (messages this entity accepts):
```
- Configure(config: AgentConfig) → void
- GetStatus() → AgentStatus
- UpdatePersona(persona: Persona) → void
- RegisterTool(tool: ToolDefinition) → void
- RemoveTool(toolName: string) → void
- AddBelief(belief: Belief) → void
- SetDesire(desire: Desire) → void
- PursueGoal(goal: Goal) → GoalId          # Triggers DeliberationWorkflow
- GetBeliefs() → Array<Belief>
- GetActiveGoals() → Array<Goal>
- SpawnSubAgent(config: SubAgentConfig) → AgentId
```

**Persistence**: State persisted to SQLite on mutation. Restored on entity activation.

**Shard group**: `"agent"` — agents are long-lived, low-count entities.

### 5.2 SessionEntity

**Ontology source**: `pao:Session`

**Identity**: `SessionId` (branded string, `owl:hasKey`)

**State**:
```
- conversationId: ConversationId            # pao:partOfConversation
- status: SessionStatus                     # pao:hasStatus (Active|Ended|Interrupted)
- participants: Set<AgentId>                # pao:hasParticipant
- turns: Array<TurnRecord>                  # ordered by hasTurnIndex
- contextWindow: ContextWindowState         # pao:hasContextWindow
  - tokenCapacity: number                   # pao:hasTokenCapacity
  - tokensUsed: number                      # pao:hasTokensUsed
- workingMemory: Array<MemoryItem>          # current context items
- continuedFrom: Option<SessionId>          # pao:continuedFrom
- temporalExtent: TemporalInterval          # pao:hasTemporalExtent
- channel: ChannelType                      # pao:sentViaChannel
```

**RPC Protocol**:
```
- ProcessTurn(input: TurnInput) → Stream<TurnOutput>   # Main interaction loop
- GetHistory(options?: HistoryOptions) → Array<Turn>
- GetContextWindow() → ContextWindowState
- Compact() → CompactionResult                          # Triggers CompactionWorkflow
- End() → SessionSummary                                # Status → Ended
- Interrupt() → void                                    # Status → Interrupted
- Continue() → SessionId                                # Creates new session, links via continuedFrom
```

**Persistence**: Turn history in SQLite. Working memory reconstructed from turns + memory tiers.

**Shard group**: `"session"` — sessions are medium-lived, higher-count.

**Key behavior**: The `ProcessTurn` message is the heart of the system. It spawns a `TurnProcessingWorkflow` and streams the response back to the caller. The workflow is durable — if the runner crashes mid-turn, the workflow resumes from the last completed activity.

### 5.3 ConversationEntity

**Ontology source**: `pao:Conversation`

**Identity**: `ConversationId` (branded string, `owl:hasKey`)

**State**:
```
- sessions: Array<SessionId>                # ordered, linked via continuedFrom/continuedBy
- commonGround: CommonGroundState           # pao:CommonGround
- participants: Set<AgentId>                # all agents across sessions
- temporalExtent: TemporalInterval          # pao:hasTemporalExtent
```

**RPC Protocol**:
```
- StartSession(config: SessionConfig) → SessionId
- ContinueSession(fromSessionId: SessionId) → SessionId
- GetCommonGround() → CommonGroundState
- UpdateCommonGround(act: GroundingAct) → void
- GetSessions() → Array<SessionSummary>
```

**Shard group**: `"conversation"` — long-lived, lower-count.

### 5.4 MemoryEntity

**Ontology source**: `pao:MemoryTier` (all 4 tiers managed by one entity per agent)

**Identity**: `AgentId` (one memory entity per agent)

**State**:
```
- episodic: EpisodicStore                   # pao:EpisodicMemory
  - episodes: indexed by time, topic        # pao:Episode instances
- semantic: SemanticStore                   # pao:SemanticMemory
  - claims: Map<ClaimId, Claim>             # with confidence, evidence
  - facts: indexed by topic                 # general knowledge
- procedural: ProceduralStore               # pao:ProceduralMemory
  - systemPrompts: Map<string, string>      # via KeyValueStore
  - learnedPolicies: Array<Policy>
- retentionPolicies: Map<TierId, RetentionPolicy>
```

**RPC Protocol**:
```
- Encode(item: MemoryItem, tier: MemoryTierType) → MemoryItemId
- Retrieve(query: MemoryQuery) → Array<MemoryItem>      # Cross-tier search
- Consolidate(options?: ConsolidationOptions) → ConsolidationResult
- Forget(itemId: MemoryItemId) → void
- Rehearse(itemId: MemoryItemId) → void                  # Updates lastAccessTime
- GetBlock(key: string) → Option<MemoryBlock>            # Letta-style core memory
- SetBlock(key: string, value: string) → void
- Erase(request: ErasureRequest) → ErasureEvent          # Privacy-driven deletion
```

**Persistence**:
- Episodic + Semantic → SQLite (structured, queryable, time-indexed)
- Procedural → KeyValueStore (file-based, fast reads)
- Memory blocks → KeyValueStore (simple key-value)

**Shard group**: `"memory"` — one per agent, long-lived.

### 5.5 IntegrationEntity

**Ontology source**: `pao:Integration`, `pao:ExternalService`

**Identity**: `IntegrationId` (branded string)

**State**:
```
- service: ExternalServiceConfig            # pao:ExternalService
  - endpoint: URI                           # pao:hasEndpoint
  - transport: ServiceTransport             # pao:hasServiceTransport (stdio|sse|http)
  - identifier: string                      # pao:hasServiceIdentifier
- status: IntegrationStatus                 # pao:hasIntegrationStatus
- connection: Option<ConnectionState>       # pao:ServiceConnection
- capabilities: Array<ServiceCapability>    # pao:exposesCapability
- providedTools: Array<ToolDefinition>      # pao:providesTool
```

**RPC Protocol**:
```
- Connect() → ConnectionStatus
- Disconnect() → void
- DiscoverCapabilities() → Array<ServiceCapability>     # Triggers CapabilityDiscoveryWorkflow
- GetStatus() → IntegrationStatus
- InvokeTool(name: string, input: unknown) → ToolResult
```

**Shard group**: `"integration"` — medium-lived, tied to agent lifecycle.

---

## 6. Workflow Definitions

### 6.1 TurnProcessingWorkflow

**Ontology source**: `pao:Turn`, `pao:ModelInvocation`, `pao:ToolInvocation`

**Trigger**: `SessionEntity.ProcessTurn` message

**Input**:
```
- agentId: AgentId
- sessionId: SessionId
- userMessage: Message (with ContentBlocks)
- conversationContext: ConversationContext
```

**Activities (in order)**:

1. **ClassifyDialogAct**
   - Input: userMessage
   - Output: `DialogAct` with `CommunicativeFunction`
   - Side effects: Fast LLM classification call
   - Retry: 2 attempts, exponential backoff
   - Ontology: `pao:DialogAct`, `pao:hasCommunicativeFunction`

2. **EvaluatePolicy**
   - Input: agentId, intended actions (from message classification)
   - Output: `AuthorizationDecision` (Allow | Deny | RequireApproval)
   - Side effects: Reads PermissionPolicy, writes AuditEntry
   - Retry: No retry (deterministic)
   - Ontology: `pao:PermissionPolicy`, `pao:AuditEntry`, `pao:AuthorizationDecision`

3. **RetrieveMemory**
   - Input: userMessage, conversationContext, agentId
   - Output: `Array<MemoryItem>` (relevant items from all tiers)
   - Side effects: SQLite reads, KeyValueStore reads, updates `hasLastAccessTime`
   - Retry: 2 attempts, immediate
   - Ontology: `pao:Retrieval`, `pao:MemoryItem`

4. **AssemblePrompt**
   - Input: system prompt (from ProceduralMemory), retrieved memories, turn history, user message
   - Output: Complete `Prompt` for LLM
   - Side effects: None (pure computation)
   - Retry: Not needed
   - Note: This is where WorkingMemory is constructed — the LLM context window

5. **InvokeModel**
   - Input: assembled Prompt, GenerationConfiguration, ToolDefinitions
   - Output: `GenerateTextResponse` (text + tool calls + reasoning + usage)
   - Side effects: LLM API call via `@effect/ai` LanguageModel service
   - Retry: 3 attempts, exponential backoff (respects FailureType)
   - Ontology: `pao:ModelInvocation`, `pao:GenerationConfiguration`, `pao:FoundationModel`

6. **ExecuteTools** (0..N, parallel with concurrency limit)
   - Input: `Array<ToolCallPart>` from model response
   - Output: `Array<ToolResult>` with ComplianceStatus
   - Side effects: Tool-specific (file I/O, HTTP calls, DB queries, etc.)
   - Retry: Configurable per tool definition
   - Policy: Each tool invocation checked against PermissionPolicy
   - Audit: Each invocation creates AuditEntry with AuthorizationDecision
   - Ontology: `pao:ToolInvocation`, `pao:ToolResult`, `pao:ComplianceStatus`

7. **EncodeMemory**
   - Input: Turn content, tool results, model reasoning
   - Output: `Array<MemoryItemId>` (items stored)
   - Side effects: SQLite writes (episodic), KeyValueStore writes (if preferences detected)
   - Retry: 2 attempts, immediate
   - Ontology: `pao:Encoding`, `pao:Episode`, `pao:Claim`

8. **UpdateCommonGround**
   - Input: Turn results, dialog act classification
   - Output: `GroundingAct` with `AcceptanceEvidence`
   - Side effects: Updates ConversationEntity's CommonGround
   - Retry: 1 attempt
   - Ontology: `pao:GroundingAct`, `pao:CommonGround`, `pao:AcceptanceEvidence`

**Output**: `Turn` with `ContentBlocks`, `DialogAct`, token usage, and metadata.

**Streaming**: The `InvokeModel` activity streams `TextDeltaPart` chunks back through the workflow to the SessionEntity, which streams them to the client. Tool executions and memory encoding happen after the model response completes.

### 6.2 DeliberationWorkflow

**Ontology source**: `pao:Deliberation` (BDI model)

**Trigger**: `AgentEntity.PursueGoal` message

**Input**:
```
- agentId: AgentId
- goal: Goal
```

**Activities**:

1. **ConsiderBeliefs**
   - Input: agentId, goal
   - Output: `Array<Belief>` (relevant beliefs)
   - Side effects: Reads from MemoryEntity (semantic tier)
   - Ontology: `pao:considersBelief`

2. **ConsiderDesires**
   - Input: agentId, goal, relevant beliefs
   - Output: `Array<Desire>` (compatible desires)
   - Side effects: Reads agent desires
   - Ontology: `pao:considersDesire`

3. **ProduceIntention**
   - Input: beliefs, desires, goal
   - Output: `Intention` with `Justification`
   - Side effects: LLM reasoning call to formulate intention
   - Ontology: `pao:producesIntention`, `pao:Intention`, `pao:Justification`

4. **CreatePlan**
   - Input: intention, available tools, agent capabilities
   - Output: `Plan` with ordered `Array<Task>` and dependency graph
   - Side effects: LLM planning call, persists Plan to storage
   - Ontology: `pao:Plan`, `pao:hasTask`, `pao:achievesGoal`

**Output**: `Plan` ready for execution. Triggers `PlanExecutionWorkflow`.

### 6.3 PlanExecutionWorkflow

**Ontology source**: `pao:Plan`, `pao:Task`

**Trigger**: `DeliberationWorkflow` completion

**Input**:
```
- plan: Plan
- tasks: Array<Task> (with dependency graph via blockedBy/blocks)
```

**Activities** (dynamic, based on task graph):

For each task in topological order (respecting `blockedBy` dependencies):

1. **CheckTaskPreconditions**
   - Verifies all `blockedBy` tasks are Completed
   - Checks for `Checkpoint` requirements (`CheckpointDecision`: Approved | Rejected | Deferred)

2. **ExecuteTask**
   - Task status: Pending → InProgress
   - Executes task-specific logic (may involve ToolInvocations, sub-agent spawning, etc.)
   - Task status: InProgress → Completed (or Blocked on failure)

3. **RecordTaskOutcome**
   - Persists task result and status transition
   - Updates plan progress

**Parallelism**: Independent tasks (no `blockedBy` relationship) execute concurrently.

**Failure handling**: If a task fails, the workflow spawns an `ErrorRecoveryWorkflow`. Based on the recovery outcome:
- `resolved` → retry the task
- `escalated` → pause the plan, notify user
- `abandoned` → mark task as Blocked, attempt to continue with non-dependent tasks

### 6.4 CompactionWorkflow

**Ontology source**: `pao:CompactionEvent`, `pao:CompactionDisposition`

**Trigger**: SessionEntity context window approaching capacity (`tokensUsed / tokenCapacity > threshold`)

**Activities**:

1. **SelectItemsForCompaction**
   - Analyzes turns and memory items in working memory
   - Scores by recency, relevance, sensitivity
   - Output: items with proposed `ItemFate` (Preserved | Dropped | Summarized | Archived)

2. **SummarizeItems**
   - For items with fate `Summarized`: LLM summarization call
   - Produces summary MemoryItem stored in SemanticMemory
   - Ontology: `pao:producedSummary`

3. **UpdateMemoryTiers**
   - Items with fate `Archived`: move from WorkingMemory to EpisodicMemory
   - Items with fate `Dropped`: remove from WorkingMemory
   - Items with fate `Preserved`: keep in WorkingMemory

4. **RecordDispositions**
   - Creates `CompactionDisposition` for each item with `fateReason`
   - Links to `CompactionEvent` via `pao:compactedItem`

### 6.5 ErrorRecoveryWorkflow

**Ontology source**: `pao:ErrorRecoveryEvent`, `pao:FailureType`

**Trigger**: Activity failure in any workflow

**Input**:
```
- failedActivity: ActivityDescriptor
- error: Cause<E>
- context: WorkflowContext
```

**Activities**:

1. **ClassifyFailure**
   - Maps error to `FailureType`: Timeout | AuthenticationFailure | RateLimited | DependencyFailure | ConfigurationError | NetworkError

2. **SelectStrategy**
   - Based on FailureType and attempt count:
     - Timeout → RetryAttempt (with increasing delay)
     - RateLimited → RetryAttempt (respect rate limit headers)
     - AuthenticationFailure → Escalate to user
     - DependencyFailure → ReplanEvent (find alternative approach)
     - ConfigurationError → RollbackEvent (restore last known good)
     - NetworkError → RetryAttempt (with jitter)

3. **ExecuteStrategy**
   - Performs the selected recovery action
   - Records `hasAttemptCount`, `hasRecoveryOutcome`

### 6.6 ConsolidationWorkflow

**Ontology source**: `pao:Consolidation` (MemoryOperation)

**Trigger**: Periodic (e.g., end of session) or explicit request

**Activities**:

1. **SelectEpisodes**
   - Queries EpisodicMemory for episodes eligible for consolidation
   - Considers `hasLastAccessTime`, `isEvictionCandidate`, `retentionPeriodDays`

2. **ExtractFacts**
   - LLM call to extract generalizable facts from episodes
   - Produces `Claim` objects with `hasConfidence` and `hasEvidence`

3. **StoreSemanticMemory**
   - Writes extracted Claims to SemanticMemory tier
   - Deduplicates against existing claims

4. **DecayEpisodic**
   - Marks consolidated episodes for eventual `Forgetting`
   - Respects `RetentionPolicy` constraints

---

## 7. Persistence Strategy

### 7.1 Storage Backend Selection

| Storage | Backend | Use Case | Why |
|---|---|---|---|
| **Cluster MessageStorage** | SQLite | Durable message delivery, workflow checkpoints | Required for crash recovery |
| **Cluster RunnerStorage** | SQLite | Shard coordination, runner health | Required for cluster operation |
| **Domain State** | SQLite | Entity state, turn history, memory items, audit log | Structured, queryable, transactional |
| **Procedural Memory** | KeyValueStore (file) | System prompts, learned behaviors, config | Fast reads, simple key-value |
| **Memory Blocks** | KeyValueStore (file) | Letta-style core memory blocks | Fast key-value access |

### 7.2 SQLite Schema (Core Tables)

```sql
-- Agent state
agents (agent_id PK, persona JSON, permission_mode, model_config JSON, created_at, updated_at)
agent_tools (agent_id FK, tool_name, tool_definition JSON)
agent_beliefs (agent_id FK, claim_id FK, belief JSON)
agent_desires (agent_id FK, desire_id PK, desire JSON)

-- Conversations and sessions
conversations (conversation_id PK, created_at, common_ground JSON)
sessions (session_id PK, conversation_id FK, status, channel_type,
          continued_from FK, token_capacity, tokens_used, started_at, ended_at)

-- Turns and messages
turns (turn_id PK, session_id FK, conversation_id FK, turn_index,
       participant_agent_id FK, content_blocks JSON, dialog_act JSON,
       model_invocation_id FK, created_at)

-- Tool invocations
tool_invocations (invocation_id PK, turn_id FK, session_id FK, agent_id FK,
                  tool_name, input JSON, output JSON, compliance_status,
                  policy_id FK, invocation_group_id, created_at)

-- Memory items
memory_items (item_id PK, agent_id FK, tier, content JSON, topic,
              sensitivity_level, memory_scope, memory_source,
              retention_policy_id FK, last_access_time, is_eviction_candidate,
              attributed_to FK, generated_by FK, created_at)

-- Episodes (subtype of memory_item)
episodes (item_id FK PK, temporal_start, temporal_end, events JSON)

-- Claims (subtype of memory_item)
claims (item_id FK PK, claim_type, confidence REAL, evidence JSON, about_agent_id FK)

-- Goals, plans, tasks
goals (goal_id PK, agent_id FK, status, description, created_at)
plans (plan_id PK, goal_id FK, created_at)
tasks (task_id PK, plan_id FK, status, description, created_at)
task_dependencies (task_id FK, blocked_by_task_id FK)

-- Governance
permission_policies (policy_id PK, agent_id FK, grants JSON, restricts JSON)
audit_entries (entry_id PK, invocation_id FK, decision, reason, log_id FK, created_at)
consent_records (consent_id PK, subject_agent_id FK, purpose, created_at)
retention_policies (policy_id PK, retention_period_days)

-- External services
external_services (service_id PK, endpoint URI, transport, identifier, name)
integrations (integration_id PK, service_id FK, agent_id FK, status, created_at)
service_capabilities (capability_id PK, service_id FK, type, definition JSON)

-- Observability
operational_metrics (metric_id PK, metric_name, entity_id, entity_type)
metric_observations (observation_id PK, metric_id FK, value REAL, recorded_at)
reliability_incidents (incident_id PK, entity_id, entity_type, recovery_id FK, created_at)
```

### 7.3 KeyValueStore Layout

```
procedural-memory/
  {agentId}/
    system-prompt          # Main system prompt
    persona-prompt         # Persona-specific instructions
    policies/
      {policyName}         # Learned behavioral policies
    skills/
      {skillName}          # Learned skill descriptions

memory-blocks/
  {agentId}/
    {blockKey}             # Letta-style core memory blocks
                           # e.g., "human", "persona", "preferences"

agent-config/
  {agentId}/
    config                 # Agent configuration
    model-deployment       # Current model deployment config
    generation-config      # Generation parameters
```

### 7.4 Migration to Cloud

The persistence layer is designed for easy migration:

| Local | Cloud | Migration Path |
|---|---|---|
| SQLite (bun:sqlite) | PostgreSQL | Change `@effect/sql-sqlite-bun` → `@effect/sql-pg`. Same SqlClient interface. |
| KeyValueStore (file) | Redis or S3 | Change Layer providing KeyValueStore. Same KV interface. |
| Single runner | Multi-runner | Add RunnerAddress config, use SQL advisory locks for shard coordination |

The key insight is that **all persistence goes through Effect abstractions** (SqlClient, KeyValueStore, MessageStorage, RunnerStorage). The concrete implementations are provided via Layers and can be swapped without changing any business logic.

---

## 8. Memory Architecture

### 8.1 Four-Tier Model

The ontology defines a precise 4-tier memory model (`owl:disjointUnionOf`). Each tier has distinct characteristics:

| Tier | Ontology Class | Volatility | Storage | Access Pattern |
|---|---|---|---|---|
| **Working** | `pao:WorkingMemory` | Highest | In-memory (session state) | Read on every turn, rebuilt from context |
| **Episodic** | `pao:EpisodicMemory` | Medium | SQLite (time-indexed) | Write per turn, read on retrieval |
| **Semantic** | `pao:SemanticMemory` | Low | SQLite (topic-indexed) | Write on consolidation, read on retrieval |
| **Procedural** | `pao:ProceduralMemory` | Lowest | KeyValueStore (file) | Write rarely, read on session start |

### 8.2 Memory Operations

Five operations (`owl:disjointUnionOf`), mapped to MemoryEntity RPC methods:

| Operation | Ontology | When | From → To |
|---|---|---|---|
| **Encoding** | `pao:Encoding` | After each turn | New items → Episodic (or Semantic for facts) |
| **Retrieval** | `pao:Retrieval` | During turn processing | Query across all tiers → Working Memory |
| **Consolidation** | `pao:Consolidation` | End of session or periodic | Episodic → Semantic (extract generalizable facts) |
| **Forgetting** | `pao:Forgetting` | Retention policy expiry or compaction | Remove items respecting RetentionPolicy |
| **Rehearsal** | `pao:Rehearsal` | On repeated access | Updates `hasLastAccessTime`, strengthens item |

### 8.3 Memory Item Metadata

Every memory item carries provenance and governance metadata (from ontology restrictions):

```
MemoryItem:
  id: MemoryItemId
  tier: MemoryTierType                    # Which tier it's stored in
  content: string                         # pao:hasContent
  topic: Option<SKOSConcept>              # pao:hasTopic
  sensitivityLevel: SensitivityLevel      # pao:hasSensitivityLevel
  memoryScope: MemoryScope                # pao:hasMemoryScope (Session|Project|Global)
  memorySource: MemorySource              # pao:hasMemorySource (User|System|Agent)
  retentionPolicy: RetentionPolicyId      # pao:governedByRetention
  lastAccessTime: DateTime                # pao:hasLastAccessTime
  isEvictionCandidate: boolean            # pao:isEvictionCandidate
  attributedTo: AgentId                   # prov:wasAttributedTo
  generatedBy: EventId                    # prov:wasGeneratedBy
```

### 8.4 Multi-Agent Memory

The ontology supports shared memory (`pao:SharedMemoryArtifact`):

- Shared artifacts must be accessible to at least 2 agents (`minQualifiedCardinality 2`)
- Write conflicts (`pao:MemoryWriteConflict`) resolved by `PermissionPolicy`
- This maps to Cluster entities — agents on different shards accessing the same memory entity

---

## 9. AI Integration

### 9.1 Language Model Service

The `@effect/ai` package provides a `LanguageModel` service tag. The architecture wraps this with ontology-aligned abstractions:

**FoundationModel** (ontology: `pao:FoundationModel`):
```
- modelId: ModelId (branded string, owl:hasKey)
- modelVersion: string
- provider: ModelProvider
```

**ModelDeployment** (ontology: `pao:ModelDeployment`):
```
- model: FoundationModel
- endpoint: URI (or provider-specific config)
- generationConfig: GenerationConfiguration
```

**GenerationConfiguration** (ontology: `pao:GenerationConfiguration`):
```
- temperature: number                     # pao:hasTemperature
- topP: number                            # pao:hasTopP
- maxOutputTokens: number                 # pao:hasMaxOutputTokens
- seed: Option<number>                    # pao:hasSeed
- promptVersion: string                   # pao:hasPromptVersion
```

### 9.2 Tool System

Tools are defined using `@effect/ai`'s `Tool.make()` and composed via `Toolkit`:

```
OntologyToolDefinition (pao:ToolDefinition)
  → @effect/ai Tool<Name, Config, Requirements>
    - parametersSchema: Schema (validated input)
    - successSchema: Schema (typed result)
    - failureSchema: Schema (typed error)
```

Each tool invocation creates an audit trail:
1. PermissionPolicy evaluated → AuthorizationDecision
2. AuditEntry written with decision + reason
3. Tool handler executed (if allowed)
4. ToolResult recorded with ComplianceStatus
5. All wrapped in ToolInvocation entity with full provenance

### 9.3 Model Invocation Tracking

Every LLM call is tracked as a `ModelInvocation` event:

```
ModelInvocation:
  deployment: ModelDeploymentId
  turn: TurnId                            # pao:modelInvocationForTurn
  generationConfig: GenerationConfiguration
  inputTokens: number
  outputTokens: number
  reasoning: Option<string>               # Extended thinking content
  finishReason: FinishReason
  temporalExtent: TemporalInterval        # Start/end time
```

---

## 10. Governance & Safety

### 10.1 Policy Enforcement

The ontology defines a comprehensive governance model. In the architecture, this maps to **middleware and activities**:

**PermissionPolicy** (ontology: `pao:PermissionPolicy`, aligned with `odrl:Policy`):
- Evaluated as an Activity in every TurnProcessingWorkflow
- Checked before every ToolInvocation
- Stored in SQLite, cached in AgentEntity state

**Decision flow**:
```
Action requested
  → Load applicable PermissionPolicies for agent
  → Evaluate against SafetyConstraints
  → Produce AuthorizationDecision (Allow | Deny | RequireApproval)
  → Write AuditEntry with decision + reason
  → If RequireApproval: pause workflow, notify user via Checkpoint
  → If Deny: reject action, record in audit log
  → If Allow: proceed
```

### 10.2 Hook System

Hooks (ontology: `pao:Hook`) intercept tool invocations:

```
ToolInvocation requested
  → Check agent's hooks
  → For each matching hook:
    → HookExecution event created
    → Hook logic runs (may modify, block, or log the invocation)
  → If not blocked: proceed with invocation
```

### 10.3 Audit Trail

Every significant action produces an `AuditEntry`:

```
AuditEntry:
  invocationId: ToolInvocationId          # pao:auditForInvocation
  decision: AuthorizationDecision         # pao:recordsDecision
  reason: string                          # pao:hasDecisionReason
  logId: AuditLogId                       # pao:writtenToAuditLog
  timestamp: DateTime
```

Audit entries are append-only in SQLite. They are never deleted (except via ErasureEvent with explicit consent).

### 10.4 Privacy

- **SensitivityLevel**: Every MemoryItem tagged (Public | Internal | Confidential | Restricted)
- **ConsentRecord**: Tracks data subject consent for specific purposes
- **RetentionPolicy**: Automatic expiry of memory items after `retentionPeriodDays`
- **ErasureEvent**: User-requested deletion, recorded with `requestedBy` provenance
- **SandboxPolicy**: Filesystem/network restrictions enforced per agent

---

## 11. Networking & Gateway

### 11.1 Local Mode

In local mode, the CLI communicates directly with entities through the Cluster's in-process routing:

```
CLI Command
  → Effect program
  → Sharding.sendLocal()
  → Entity processes message
  → Response returned directly
```

No HTTP server needed. Single process, single runner.

### 11.2 Gateway Mode (HTTP API)

For network access (web clients, other services, future cloud deployment), the system exposes an HTTP API gateway using `@effect/platform`'s `HttpApi`:

**Gateway API structure**:
```
POST   /conversations                     # Start new conversation
GET    /conversations/:id                 # Get conversation state
POST   /conversations/:id/sessions        # Start session in conversation
POST   /sessions/:id/turns               # Process a turn (streaming response)
GET    /sessions/:id/history              # Get turn history
POST   /sessions/:id/compact             # Trigger compaction
DELETE /sessions/:id                      # End session

GET    /agents/:id                        # Get agent status
PATCH  /agents/:id                        # Update agent config
POST   /agents/:id/goals                 # Set a goal (triggers deliberation)
GET    /agents/:id/memory                # Query memory
POST   /agents/:id/memory/consolidate    # Trigger consolidation

GET    /agents/:id/tools                 # List available tools
POST   /agents/:id/integrations          # Add integration
DELETE /agents/:id/integrations/:iid     # Remove integration

GET    /audit                             # Query audit log
```

**Implementation**: The gateway uses `EntityProxy` from `@effect/cluster` to bridge entity RPC protocols to HTTP endpoints. This means the HTTP API is **derived from the entity protocols**, not hand-coded — the entity RPC schemas become the API contract automatically.

**Middleware stack**:
```
Request
  → Authentication (who is calling)
  → Rate limiting
  → Request validation (Schema-driven)
  → Policy check (is caller authorized for this entity)
  → Entity routing (Sharding resolves entity address)
  → Entity processes message
  → Response serialization
  → Audit logging
```

### 11.3 Streaming

The `ProcessTurn` endpoint supports streaming via Server-Sent Events (SSE) or WebSocket:

```
POST /sessions/:id/turns
Accept: text/event-stream

event: text-start
data: {}

event: text-delta
data: {"delta": "Hello, "}

event: text-delta
data: {"delta": "how can I help?"}

event: tool-call
data: {"name": "search", "input": {...}}

event: tool-result
data: {"name": "search", "output": {...}}

event: text-end
data: {"usage": {"inputTokens": 150, "outputTokens": 42}}

event: finish
data: {"turnId": "...", "turnIndex": 3}
```

### 11.4 Multi-Node (Future Cloud)

```
                    ┌─────────────────┐
                    │   Load Balancer  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
        │  Runner 1  │ │  Runner 2  │ │  Runner 3  │
        │ (Gateway + │ │ (Gateway + │ │ (Gateway + │
        │  Entities) │ │  Entities) │ │  Entities) │
        └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
              │              │              │
              └──────────────┼──────────────┘
                             │
                    ┌────────▼────────┐
                    │   PostgreSQL     │
                    │ (RunnerStorage + │
                    │  MessageStorage +│
                    │  Domain State)   │
                    └─────────────────┘
```

Each runner runs the same code. Sharding distributes entities across runners. The gateway on each runner can accept any request — if the target entity is on a different runner, the request is forwarded via RPC.

---

## 12. Error Handling & Recovery

### 12.1 Error Taxonomy

The ontology defines a `FailureType` value partition. This maps to Effect's tagged error system:

```
FailureType (owl:oneOf):
  - Timeout              → Schedule.exponential backoff
  - AuthenticationFailure → Escalate immediately
  - RateLimited          → Schedule.spaced (respect retry-after)
  - DependencyFailure    → Replan (find alternative)
  - ConfigurationError   → Rollback to last good config
  - NetworkError         → Schedule.exponential with jitter
```

### 12.2 Error Propagation

```
Activity failure
  │
  ├─ Activity-level retry (Schedule-based, configured per activity)
  │     └─ If success: continue workflow
  │
  ├─ Retries exhausted → ErrorRecoveryWorkflow
  │     ├─ RetryAttempt (with different strategy)
  │     ├─ ReplanEvent (revise the plan)
  │     └─ RollbackEvent (restore previous state)
  │
  ├─ Recovery outcome:
  │     ├─ resolved → resume original workflow
  │     ├─ escalated → notify user, pause workflow
  │     └─ abandoned → mark task as Blocked
  │
  └─ Unrecoverable → Cause<E> propagated to caller with full trace
```

### 12.3 Cluster-Level Recovery

Effect Cluster handles infrastructure-level failures automatically:

- **Runner crash**: Shard locks expire → other runners acquire → unprocessed messages replayed
- **Message loss**: Persisted messages re-delivered from MessageStorage
- **Entity crash**: Entity re-instantiated on next message, state restored from storage
- **Network partition**: Messages stored in MessageStorage, delivered when connectivity restored

---

## 13. Observability

### 13.1 Metrics (Ontology: `pao:OperationalMetric`, `pao:MetricObservation`)

```
Metrics to track:
  - turns_processed (counter, per agent)
  - model_invocations (counter, per model/deployment)
  - tool_invocations (counter, per tool)
  - token_usage (histogram, input/output)
  - memory_items_stored (gauge, per tier)
  - active_sessions (gauge)
  - context_window_utilization (gauge, per session)
  - compaction_events (counter)
  - error_recovery_events (counter, per failure type)
  - audit_decisions (counter, per decision type)
```

### 13.2 Cluster Metrics

Effect Cluster provides built-in metrics:
- Active shards, runners, healthy runners, singletons
- Message processing latency
- Entity activation/deactivation rates

### 13.3 Reliability Incidents (Ontology: `pao:ReliabilityIncident`)

Tracked when services degrade:
```
ReliabilityIncident:
  entity: EntityAddress
  failureType: FailureType
  linkedToRecovery: Option<ErrorRecoveryEventId>
  duration: TemporalInterval
  impact: string
```

### 13.4 Telemetry

`@effect/ai` supports OpenTelemetry GenAI semantic conventions. All LLM calls produce spans with:
- Model name, provider, operation type
- Request parameters (temperature, max_tokens, etc.)
- Response metadata (finish reason, token usage)
- Latency and error information

---

## 14. Module-by-Module Ontology Mapping

This section provides a detailed mapping of every ontology module to specific Effect constructs.

### Module 1: Identity & Actors

| Ontology Class | Effect Construct | Notes |
|---|---|---|
| `pao:Agent` | `Schema.TaggedClass("Agent")` | Abstract base, not instantiated directly |
| `pao:AIAgent` | `AgentEntity` (Cluster Entity) | Primary entity type |
| `pao:HumanUser` | `Schema.TaggedClass("HumanUser")` | Data type, not an entity (represented externally) |
| `pao:SubAgent` | `AgentEntity` with `spawnedBy` field | Same entity type, linked to parent |
| `pao:Organization` | `Schema.TaggedClass("Organization")` | Data type with `hasMember` relation |
| `pao:Persona` | `Schema.Class("Persona")` | Value object in AgentEntity state |
| `pao:ToolDefinition` | `@effect/ai Tool<Name, Config, R>` | Direct mapping to Effect's tool system |
| `pao:AgentRole` | `Schema.Literal("AssistantRole", "UserRole")` | Value partition |
| `pao:FoundationModel` | `Schema.Class("FoundationModel")` | Config type with `ModelId` branded key |
| `pao:ModelProvider` | `Schema.Class("ModelProvider")` | Identifies provider (OpenAI, Anthropic, etc.) |
| `pao:ModelDeployment` | `Schema.Class("ModelDeployment")` | Runtime config for model endpoint |
| `pao:GenerationConfiguration` | `Schema.Class("GenerationConfiguration")` | temperature, topP, maxOutputTokens, seed |

**Branded ID types**:
- `AgentId = Schema.String.pipe(Schema.brand("AgentId"))` (`owl:hasKey pao:hasAgentId`)
- `ModelId = Schema.String.pipe(Schema.brand("ModelId"))` (`owl:hasKey pao:hasModelId`)

### Module 2: Conversation & Interaction

| Ontology Class | Effect Construct | Notes |
|---|---|---|
| `pao:Conversation` | `ConversationEntity` | Durable entity, manages session chain |
| `pao:Session` | `SessionEntity` | Durable entity, manages turn sequence |
| `pao:Turn` | `Schema.Class("Turn")` | Data type stored in session state + SQLite |
| `pao:Message` | `Schema.Class("Message")` | Value object within Turn |
| `pao:ContentBlock` | `Schema.TaggedClass` union | TextBlock, ToolUseBlock, ToolResultBlock, ImageBlock |
| `pao:ContentBlockType` | `Schema.Literal(...)` | Discriminator for ContentBlock union |
| `pao:ToolInvocation` | Activity within TurnProcessingWorkflow | Durable, retriable, audited |
| `pao:ToolResult` | `Schema.Class("ToolResult")` | Output of tool activity |
| `pao:ToolInvocationGroup` | Concurrency group | Parallel tool execution within a turn |
| `pao:ModelInvocation` | Activity within TurnProcessingWorkflow | The LLM call itself |
| `pao:CommunicationChannel` | `Schema.Class("CommunicationChannel")` | Config type |
| `pao:ChannelType` | `Schema.Literal("CLI", "Messaging", "WebChat", "APIChannel", "VoiceChannel", "EmailChannel")` | Value partition |
| `pao:ContextWindow` | State within SessionEntity | Tracks token capacity/usage |

**Branded ID types**:
- `SessionId = Schema.String.pipe(Schema.brand("SessionId"))` (`owl:hasKey pao:hasSessionId`)
- `ConversationId = Schema.String.pipe(Schema.brand("ConversationId"))` (`owl:hasKey pao:hasConversationId`)
- `TurnId = Schema.String.pipe(Schema.brand("TurnId"))`

### Module 3: Memory Architecture

| Ontology Class | Effect Construct | Notes |
|---|---|---|
| `pao:MemoryTier` | Abstract type, 4-way union | Discriminated by tier type |
| `pao:WorkingMemory` | Session state (in-memory) | Rebuilt each turn from context |
| `pao:EpisodicMemory` | SQLite table + MemoryEntity | Time-indexed episodes |
| `pao:SemanticMemory` | SQLite table + MemoryEntity | Topic-indexed claims/facts |
| `pao:ProceduralMemory` | KeyValueStore + MemoryEntity | System prompts, behaviors |
| `pao:MemoryItem` | `Schema.TaggedClass("MemoryItem")` | Base type with metadata |
| `pao:Episode` | `Schema.TaggedClass("Episode")` extends MemoryItem | Time-bounded event cluster |
| `pao:Claim` | `Schema.TaggedClass("Claim")` extends MemoryItem | Proposition with confidence |
| `pao:MemoryBlock` | `Schema.Class("MemoryBlock")` | Key-value pair (Letta pattern) |
| `pao:MemoryOperation` | 5-way union | Encoding, Retrieval, Consolidation, Forgetting, Rehearsal |
| `pao:SharedMemoryArtifact` | MemoryItem with `sharedAcrossAgents` constraint | Multi-agent access |
| `pao:MemoryWriteConflict` | Cluster entity conflict resolution | Policy-resolved |
| `pao:MemorySource` | `Schema.Literal("UserSource", "SystemSource", "AgentSource")` | Provenance |
| `pao:MemoryScope` | `Schema.Literal("SessionScope", "ProjectScope", "GlobalScope")` | Visibility |
| `pao:SensitivityLevel` | `Schema.Literal("Public", "Internal", "Confidential", "Restricted")` | Privacy |
| `pao:RetentionPolicy` | `Schema.Class("RetentionPolicy")` | Days-based retention |

### Module 4: Goals, Plans, Tasks (BDI)

| Ontology Class | Effect Construct | Notes |
|---|---|---|
| `pao:Goal` | `Schema.Class("Goal")` | Triggers DeliberationWorkflow |
| `pao:Plan` | Workflow definition | Durable plan execution |
| `pao:Task` | Activity within PlanExecutionWorkflow | Individual work unit |
| `pao:Belief` | `Schema.Class("Belief")` | Proposition in agent state |
| `pao:Desire` | `Schema.Class("Desire")` | Outcome in agent state |
| `pao:Intention` | `Schema.Class("Intention")` | Commitment, links goal to plan |
| `pao:Deliberation` | `DeliberationWorkflow` | BDI reasoning process |
| `pao:Justification` | `Schema.Class("Justification")` | Evidence for intention |
| `pao:Checkpoint` | Workflow checkpoint | Requires CheckpointDecision |
| `pao:CheckpointDecision` | `Schema.Literal("Approved", "Rejected", "Deferred")` | Gate control |
| `pao:TaskStatus` | `Schema.Literal("Pending", "InProgress", "Completed", "Blocked")` | Task lifecycle |
| `pao:StatusTransition` | Event record | From/to status with trigger |

### Module 5: Error Recovery

| Ontology Class | Effect Construct | Notes |
|---|---|---|
| `pao:ErrorRecoveryEvent` | `ErrorRecoveryWorkflow` | Durable recovery process |
| `pao:RetryAttempt` | `Schedule`-based retry | Within activity or workflow |
| `pao:ReplanEvent` | Workflow activity | Revise plan on failure |
| `pao:RollbackEvent` | Workflow activity | Restore previous state |
| `pao:FailureType` | `Schema.Literal("Timeout", "AuthenticationFailure", ...)` | Error classification |
| `pao:ReliabilityIncident` | Metric + event record | Tracked for observability |

### Module 6: Governance & Safety

| Ontology Class | Effect Construct | Notes |
|---|---|---|
| `pao:PermissionPolicy` | `Schema.Class("PermissionPolicy")` + middleware | Evaluated in EvaluatePolicy activity |
| `pao:SafetyConstraint` | Hard-coded policy rules | Non-negotiable limits |
| `pao:Hook` | `Schema.Class("Hook")` + interceptor | Pre/post tool invocation |
| `pao:HookExecution` | Event record | Logged execution of hook |
| `pao:AuditEntry` | SQLite append-only table | Every decision recorded |
| `pao:AuditLog` | SQLite table container | Queryable audit trail |
| `pao:SandboxPolicy` | Runtime constraint | File/network restrictions |
| `pao:ConsentRecord` | SQLite table | Data subject consent tracking |
| `pao:PermissionMode` | `Schema.Literal("Permissive", "Standard", "Restrictive")` | Agent operating mode |
| `pao:AuthorizationDecision` | `Schema.Literal("Allow", "Deny", "RequireApproval")` | Policy output |

### Module 7: Dialog Pragmatics

| Ontology Class | Effect Construct | Notes |
|---|---|---|
| `pao:DialogAct` | `Schema.Class("DialogAct")` | Classified in TurnProcessing activity |
| `pao:CommunicativeFunction` | `Schema.Literal("Inform", "Request", "Confirm", "Clarify", "Accept", "Reject")` | Intent type |
| `pao:CommonGround` | State in ConversationEntity | Shared knowledge accumulator |
| `pao:GroundingAct` | Activity in TurnProcessingWorkflow | Updates common ground |
| `pao:AcceptanceEvidence` | `Schema.Class("AcceptanceEvidence")` | Proof of understanding |
| `pao:ClarificationRequest` | `Schema.Class("ClarificationRequest")` | References ambiguous turn |

### Module 8: External Services

| Ontology Class | Effect Construct | Notes |
|---|---|---|
| `pao:ExternalService` | `Schema.Class("ExternalService")` | Config type |
| `pao:Integration` | `IntegrationEntity` | Durable entity managing connection |
| `pao:ServiceConnection` | State within IntegrationEntity | Runtime connection state |
| `pao:ServiceCapability` | `Schema.Union(Tool, Resource, Prompt)` | 3-way capability union |
| `pao:CapabilityDiscoveryEvent` | `CapabilityDiscoveryWorkflow` | Discovers what service offers |
| `pao:IntegrationStatus` | `Schema.Literal("Connected", "Disconnected", "Error", "Initializing")` | Connection state |
| `pao:ConnectionStatus` | `Schema.Literal("Open", "Closed", "Reconnecting", "Failed")` | Transport state |

---

## 15. Package Structure

The monorepo packages should be restructured to support this architecture:

```
packages/
├── domain/                    # Pure types, schemas, branded IDs
│   └── src/
│       ├── ids.ts             # All branded ID types
│       ├── status.ts          # All value partition types
│       ├── agent.ts           # Agent, Persona, FoundationModel schemas
│       ├── conversation.ts    # Conversation, Session, Turn, Message schemas
│       ├── memory.ts          # MemoryItem, Episode, Claim, MemoryBlock schemas
│       ├── planning.ts        # Goal, Plan, Task, BDI schemas
│       ├── governance.ts      # Policy, Audit, Consent schemas
│       ├── dialog.ts          # DialogAct, CommonGround schemas
│       ├── services.ts        # ExternalService, Integration schemas
│       ├── errors.ts          # All tagged error types
│       └── index.ts           # Re-exports
│
├── entities/                  # Cluster entity definitions + protocols
│   └── src/
│       ├── AgentEntity.ts
│       ├── SessionEntity.ts
│       ├── ConversationEntity.ts
│       ├── MemoryEntity.ts
│       ├── IntegrationEntity.ts
│       └── index.ts
│
├── workflows/                 # Durable workflow definitions
│   └── src/
│       ├── TurnProcessingWorkflow.ts
│       ├── DeliberationWorkflow.ts
│       ├── PlanExecutionWorkflow.ts
│       ├── CompactionWorkflow.ts
│       ├── ErrorRecoveryWorkflow.ts
│       ├── ConsolidationWorkflow.ts
│       ├── CapabilityDiscoveryWorkflow.ts
│       ├── activities/        # Shared activities
│       │   ├── InvokeModel.ts
│       │   ├── ExecuteTool.ts
│       │   ├── EncodeMemory.ts
│       │   ├── RetrieveMemory.ts
│       │   ├── EvaluatePolicy.ts
│       │   └── WriteAuditEntry.ts
│       └── index.ts
│
├── persistence/               # Storage implementations
│   └── src/
│       ├── SqlRepository.ts   # SQLite domain state repository
│       ├── migrations/        # SQL migrations
│       ├── KeyValueMemory.ts  # File-based KV for procedural memory
│       └── index.ts
│
├── gateway/                   # HTTP API gateway
│   └── src/
│       ├── Api.ts             # HttpApi definition
│       ├── Middleware.ts       # Auth, rate limiting, audit
│       ├── Streaming.ts       # SSE/WebSocket turn streaming
│       └── index.ts
│
├── cli/                       # CLI interface
│   └── src/
│       ├── bin.ts
│       ├── Cli.ts             # Command definitions
│       └── index.ts
│
└── server/                    # Application assembly
    └── src/
        ├── server.ts          # Wires everything together
        ├── ClusterSetup.ts    # Sharding, runners, storage config
        └── index.ts
```

---

## 16. Deployment Topology

### Local (Initial Target)

```
Single process:
  ┌──────────────────────────────────┐
  │  CLI or HTTP Gateway             │
  │  ┌────────────────────────────┐  │
  │  │  Cluster (single runner)   │  │
  │  │  ┌──────┐ ┌──────┐ ┌────┐│  │
  │  │  │Agent │ │Session│ │Mem ││  │
  │  │  │Entity│ │Entity │ │Ent ││  │
  │  │  └──────┘ └──────┘ └────┘│  │
  │  └────────────────────────────┘  │
  │  ┌──────────┐ ┌────────────────┐ │
  │  │ SQLite   │ │ KeyValueStore  │ │
  │  │ (file)   │ │ (file)         │ │
  │  └──────────┘ └────────────────┘ │
  └──────────────────────────────────┘
```

- All in one process
- SQLite for persistence (bun:sqlite, zero setup)
- KeyValueStore backed by local filesystem
- CLI commands execute directly against local cluster
- Optional HTTP gateway for web/mobile clients

### Cloud (Future)

```
Multiple processes across nodes:
  ┌────────────┐  ┌────────────┐  ┌────────────┐
  │  Runner 1   │  │  Runner 2   │  │  Runner 3   │
  │  + Gateway   │  │  + Gateway   │  │  + Gateway   │
  │  (shards 1-100)│  (shards 101-200) (shards 201-300)
  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
         │                │                │
         └────────────────┼────────────────┘
                          │
                 ┌────────▼────────┐
                 │   PostgreSQL     │
                 │   + Redis (KV)   │
                 └─────────────────┘
```

- Same code, different Layer configuration
- SQLite → PostgreSQL (swap sql package)
- File KV → Redis (swap KV Layer)
- Single runner → multi-runner (add RunnerAddress config)
- Load balancer routes HTTP to any runner

---

## 17. Open Questions

1. **Embedding/Vector search for memory retrieval**: The ontology doesn't model vector embeddings. Should we add embedding-based semantic search for memory retrieval, or rely on structured queries (topic, time, scope)?

2. **Sub-agent lifecycle**: When a SubAgent is spawned, does it get its own MemoryEntity, or does it share the parent's? The ontology has `spawnedBy` but doesn't constrain memory sharing.

3. **Real-time subscriptions**: Should the gateway support WebSocket subscriptions for entity state changes (e.g., agent status, session updates)?

4. **Multi-model orchestration**: The ontology supports multiple FoundationModels per agent. Should different activities use different models (e.g., fast model for DialogAct classification, powerful model for main generation)?

5. **Workflow versioning**: As the system evolves, how do we handle in-flight workflows when workflow definitions change?

6. **Context window strategy**: The compaction workflow is defined, but the specific strategy for what to keep/drop/summarize needs detailed specification. Should this be configurable per agent via ProceduralMemory?

7. **Integration protocol**: The ontology models external services generically. Should we specifically model MCP (Model Context Protocol) as the primary integration protocol, given its adoption?

8. **Testing strategy**: How do we test durable workflows? Effect Cluster's `sendLocal` with serialization simulation is relevant here.

9. **Schema evolution**: As the ontology evolves (currently v0.7.0), how do we handle SQLite schema migrations for stored entity state?

10. **Shared memory consistency**: The ontology defines `MemoryWriteConflict` resolved by policy. What specific conflict resolution strategies do we implement (last-write-wins, merge, manual)?

---

## Appendix A: Ontology Reference

- **Main ontology**: `.reference/ontology/personal_agent_ontology.ttl`
- **Reference individuals**: `.reference/ontology/pao-reference-individuals.ttl`
- **Instance data**: `.reference/ontology/pao-data.ttl`
- **SHACL shapes**: `.reference/ontology/shapes/`
- **Documentation**: `.reference/ontology/docs/`
- **Changelog**: `.reference/ontology/CHANGELOG.md`

## Appendix B: Effect Source Reference

- **Core**: `.reference/effect/packages/effect/src/`
- **Cluster**: `.reference/effect/packages/cluster/`
- **AI**: `.reference/effect/packages/ai/`
- **Platform**: `.reference/effect/packages/platform/src/`
- **SQL**: `.reference/effect/packages/sql/src/`
- **CLI**: `.reference/effect/packages/cli/src/`
- **RPC**: `.reference/effect/packages/rpc/src/`

## Appendix C: Effect Solutions Guides

Run `effect-solutions show <topic>` for:
- `quick-start`, `project-setup`, `tsconfig`, `basics`
- `services-and-layers`, `data-modeling`, `error-handling`
- `config`, `testing`, `cli`
