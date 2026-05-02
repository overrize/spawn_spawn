/** Unique identifier for agents */
export type AgentId = string;

/** Unique identifier for tasks */
export type TaskId = string;

/** Serializable JSON-compatible value */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Serializable memory entry */
export interface MemoryEntry {
  key: string;
  value: JsonValue;
  updatedAt: number; // epoch ms
  updatedBy: AgentId;
}

/** Snapshot of the entire shared memory */
export interface MemorySnapshot {
  entries: Record<string, MemoryEntry>;
  createdAt: number;
  createdBy: AgentId;
}

/** Lifecycle states for all agent types */
export enum AgentStatus {
  IDLE = "IDLE",
  INITIALIZING = "INITIALIZING",
  RUNNING = "RUNNING",
  PAUSED = "PAUSED",
  RESUMING = "RESUMING",
  TERMINATING = "TERMINATING",
  TERMINATED = "TERMINATED",
  ERROR = "ERROR",
}

/** Valid transitions between agent states */
export const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  [AgentStatus.IDLE]: [AgentStatus.INITIALIZING],
  [AgentStatus.INITIALIZING]: [AgentStatus.RUNNING, AgentStatus.ERROR],
  [AgentStatus.RUNNING]: [AgentStatus.PAUSED, AgentStatus.TERMINATING, AgentStatus.ERROR],
  [AgentStatus.PAUSED]: [AgentStatus.RESUMING, AgentStatus.TERMINATING],
  [AgentStatus.RESUMING]: [AgentStatus.RUNNING, AgentStatus.ERROR],
  [AgentStatus.TERMINATING]: [AgentStatus.TERMINATED, AgentStatus.ERROR],
  [AgentStatus.TERMINATED]: [],
  [AgentStatus.ERROR]: [AgentStatus.TERMINATING],
};

/** Type of agent in the hierarchy */
export enum AgentType {
  MAIN = "MAIN",
  SPAWN = "SPAWN",
  FORK = "FORK",
}

/** Task context propagated through the agent hierarchy */
export interface TaskContext {
  taskId: TaskId;
  description: string;
  parentChain: AgentId[]; // ordered from root to direct parent
  constraints: string[];
  metadata: Record<string, JsonValue>;
}

/** Configuration for spawning a new agent */
export interface SpawnConfig {
  taskDescription: string;
  constraints?: string[];
  metadata?: Record<string, JsonValue>;
}

/** Configuration for forking from a spawn agent */
export interface ForkConfig {
  taskDescription: string;
  constraints?: string[];
  metadata?: Record<string, JsonValue>;
}

/** Event emitted when shared memory changes */
export enum MemoryEventType {
  SET = "memory:set",
  DELETE = "memory:delete",
  CLEAR = "memory:clear",
  SNAPSHOT = "memory:snapshot",
}

/** Payload for shared memory events */
export interface MemoryEventPayload {
  type: MemoryEventType;
  key?: string;
  value?: JsonValue;
  previousValue?: JsonValue;
  agentId: AgentId;
  timestamp: number;
}
