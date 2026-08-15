import type { TurnPhase } from "./types.js";

export type SessionState = TurnPhase | "idle";
export type SessionTransition =
  | "start"
  | "work"
  | "request_approval"
  | "resolve_approval"
  | "request_input"
  | "resolve_input"
  | "stop"
  | "complete"
  | "fail"
  | "restart";

const TRANSITIONS: Record<SessionState, Partial<Record<SessionTransition, SessionState>>> = {
  idle: { start: "starting" },
  starting: { work: "working", request_approval: "awaiting_approval", request_input: "awaiting_input", stop: "stopping", complete: "completed", fail: "failed", restart: "interrupted_unknown" },
  working: { request_approval: "awaiting_approval", request_input: "awaiting_input", stop: "stopping", complete: "completed", fail: "failed", restart: "interrupted_unknown" },
  awaiting_approval: { resolve_approval: "working", stop: "stopping", fail: "failed", restart: "interrupted_unknown" },
  awaiting_input: { resolve_input: "working", stop: "stopping", fail: "failed", restart: "interrupted_unknown" },
  stopping: { complete: "completed", fail: "failed", restart: "interrupted_unknown" },
  completed: { start: "starting" },
  failed: { start: "starting" },
  interrupted_unknown: { start: "starting" },
};

export function transition(state: SessionState, event: SessionTransition): SessionState {
  const next = TRANSITIONS[state][event];
  if (!next) throw new Error(`Invalid session transition: ${state} -> ${event}`);
  return next;
}

export function isActiveState(state: SessionState): boolean {
  return ["starting", "working", "awaiting_approval", "awaiting_input", "stopping"].includes(state);
}
