import type { AgentStatePort, GovernancePort, SchedulePort, SessionTurnPort } from "@template/domain/ports"
import { ServiceMap } from "effect"

export const AgentStatePortTag = ServiceMap.Service<AgentStatePort>(
  "server/ports/AgentStatePort"
)

export const SessionTurnPortTag = ServiceMap.Service<SessionTurnPort>(
  "server/ports/SessionTurnPort"
)

export const SchedulePortTag = ServiceMap.Service<SchedulePort>("server/ports/SchedulePort")

export const GovernancePortTag = ServiceMap.Service<GovernancePort>("server/ports/GovernancePort")
