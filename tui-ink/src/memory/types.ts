// Memory Schema — 每个 agent 一个文件 .spawn/memory/<agent_id>.json

export interface MemoryFact {
  id: string;
  text: string;
  src: string;  // "tool:<name>", "btw:user", "todo:done", "handup:<agentId>"
  ts: number;
}

export interface MemoryDecision {
  id: string;
  text: string;
  rationale: string;
  ts: number;
}

export interface MemoryQuestion {
  id: string;
  text: string;
  blocking: boolean;
}

export interface ChildHandle {
  agent_id: string;
  status: "running" | "done" | "error";
  goal: string;
  handup: unknown | null;
}

export interface Tombstone {
  compact_summary: string | null;
  final_status: "done" | "error" | "interrupted" | null;
  final_artifacts: string[];
  resume_hint: string | null;
  last_todo?: string;  // JSON serialized last todo.set items
}

export interface AgentMemory {
  schema_version: 1;
  agent_id: string;
  agent_type: "PM" | "LEADER" | "SECRETARY" | "WORKER";
  session_hash?: string;  // 7-char hex for /resume <hash>
  parent_chain: string[];
  depth: number;
  created_at: number;
  updated_at: number;
  identity: {
    role_name: string;
    skills: string[];
    model: string;
  };
  dispatch: {
    background: string;
    constraints: string[];
    acceptance_criteria: string[];
    stop_conditions: string[];
  };
  working_set: {
    facts: MemoryFact[];
    decisions: MemoryDecision[];
    open_questions: MemoryQuestion[];
  };
  child_handles: ChildHandle[];
  tombstone: Tombstone;
}
