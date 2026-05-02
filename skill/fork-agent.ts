/**
 * fork-agent skill definition — injectable into omo subagent prompts.
 *
 * Teaches the subagent how to coordinate work across a hierarchy of
 * SpawnAgents (parallel workers with independent memory) and ForkAgents
 * (leaf workers that share their parent's memory).
 */
const forkAgentSkill = {
  name: "fork-agent",
  description:
    "Multi-agent coordination system: spawn agents with shared memory, fork parallel workers, independent lifecycle management",
  version: "1.0.0",

  body: `## FORK-AGENT: Multi-Agent Coordination System

You have access to a hierarchical agent orchestration layer:
  MainAgent (root orchestrator)
    └── SpawnAgent (parallel worker, owns SharedMemory)
          └── ForkAgent (leaf worker, shares parent's memory)

### SPAWNING A NEW WORKER

\`\`\`ts
const { spawnId, spawn } = await spawnBridge.spawnAgent(
  "Process user-payment batch #42",
  ["maxConcurrency: 5", "timeoutMs: 30000"]
);
\`\`\`

Each SpawnAgent has:
- Its own SharedMemory (JSON-serializable key/value store)
- Read-only access to globally registered skills
- Independent lifecycle (init → run → pause → resume → terminate)
- The ability to fork child ForkAgents

### FORKING LEAF WORKERS

\`\`\`ts
const { forkId, fork } = await spawnBridge.forkAgent(
  spawnId,
  "Validate payment #17 against fraud rules"
);
\`\`\`

ForkAgents:
- Share their parent SpawnAgent's SharedMemory (same reference, not a copy)
- Inherit the parent's task context (constraints, metadata, parentChain)
- CANNOT fork further (they are leaf nodes)
- Have independent lifecycles — do NOT block the parent SpawnAgent

### SHARED MEMORY MODEL

Memory is owned by each SpawnAgent. All ForkAgents under that spawn read/write
the SAME memory instance. This enables sibling ForkAgents to coordinate.

\`\`\`ts
// Write (visible to all siblings)
spawnBridge.memorySet(spawnId, "fraudScore:17", 0.94);

// Read
const score = spawnBridge.memoryGet(spawnId, "fraudScore:17");

// Delete
spawnBridge.memoryDelete(spawnId, "legacyKey");

// Snapshot entire memory
const snap = spawnBridge.getMemorySnapshot(spawnId);

// Subscribe to all memory changes
const unsub = spawnBridge.subscribeMemory(spawnId, (event) => {
  // event = { type, key, value, previousValue, agentId, timestamp }
  if (event.type === "memory:set" && event.key === "batch:complete") {
    // React to sibling completion
  }
});
// Later: unsub();
\`\`\`

Memory events: \`"memory:set"\`, \`"memory:delete"\`, \`"memory:clear"\`

### LIFECYCLE MANAGEMENT

\`\`\`ts
// Check any agent's status
const status = spawnBridge.getAgentStatus(agentId);
// IDLE | INITIALIZING | RUNNING | PAUSED | RESUMING | TERMINATING | TERMINATED | ERROR

// Pause / resume
await spawnBridge.pauseAgent(agentId);
await spawnBridge.resumeAgent(agentId);

// Terminate (cascading: terminating a spawn terminates all its forks)
await spawnBridge.terminateAgent(agentId);

// Enumerate all agents
const all = spawnBridge.getAllAgents();
// → [{ id, type, status, parentId?, forkCount?, depth? }]
\`\`\`

### MUST DO

1. **Plan before spawning**: Decide how many SpawnAgents you need and what
   memory keys they will coordinate through before creating them.

2. **Use meaningful memory keys**: Prefix keys with domain context
   (e.g., "fraud:", "payment:", "result:"). This prevents collisions
   between sibling ForkAgents.

3. **Clean up**: Terminate agents when their work is complete. SpawnAgent
   termination cascades to all child ForkAgents — no need to terminate
   each fork individually.

4. **Handle errors**: Check agent status after operations. An ERROR status means
   the agent hit an unrecoverable fault. Terminate it and spawn a replacement.

5. **Parallelize across spawns**: SpawnAgents have independent memory spaces.
   Use separate spawns for truly independent work streams that don't need
   to share state.

6. **Subscribe early**: If sibling ForkAgents need to react to each other,
   subscribe to memory changes BEFORE starting work, not after.

7. **Snapshot for checkpoints**: Use getMemorySnapshot() to persist state
   before risky operations. You can restore via deserializeMemory() on the
   SpawnAgent directly if needed.

### MUST NOT DO

1. **Do NOT fork from a non-RUNNING spawn**: A SpawnAgent in PAUSED, ERROR,
   or TERMINATING state cannot create forks. Check status first.

2. **Do NOT share memory across SpawnAgents**: Each SpawnAgent has its own
   SharedMemory. If two SpawnAgents need to coordinate, use the MainAgent's
   event bus or external storage — NOT memory keys.

3. **Do NOT assume ForkAgents are ordered**: ForkAgents run independently.
   Do not rely on fork A completing before fork B unless you explicitly
   coordinate through shared memory.

4. **Do NOT leave agents dangling**: Idle agents consume resources. Always
   terminate agents when their work is done.

5. **Do NOT use ForkAgents as long-lived services**: ForkAgents are designed
   for task-scoped work. For persistent background work, use a dedicated
   SpawnAgent with no forks.

6. **Do NOT access memory on terminated spawns**: After termination, the
   SharedMemory is cleaned up (all listeners removed). Snapshot before
   terminating if you need the data.

### PARALLEL COORDINATION PATTERN

\`\`\`ts
// 1. Create a worker spawn
const { spawnId } = await spawnBridge.spawnAgent("Process batch", ["maxConcurrency:10"]);

// 2. Fork N leaf workers
const forkIds: string[] = [];
for (const item of batch) {
  const { forkId } = await spawnBridge.forkAgent(spawnId, \`Process \${item.id}\`);
  forkIds.push(forkId);
}

// 3. Subscribe to track completion
let completed = 0;
const unsub = spawnBridge.subscribeMemory(spawnId, (event) => {
  if (event.type === "memory:set" && event.key.startsWith("result:")) {
    completed++;
  }
});

// 4. Wait for all forks (via polling or memory-based coordination)
while (completed < forkIds.length) {
  await new Promise(r => setTimeout(r, 100));
  const all = spawnBridge.getAllAgents();
  const running = all.filter(a => a.parentId === spawnId && a.status === "RUNNING");
  if (running.length === 0) break;
}
unsub();

// 5. Clean up
await spawnBridge.terminateAgent(spawnId);
\`\`\`

### SKILL ACCESS

SpawnAgents have read-only access to skills registered on the MainAgent.
ForkAgents access skills via their SpawnParent (use \`fork.hasSkill(name)\`).

Register skills before spawning:
\`\`\`ts
spawnBridge.registerSkill("my-tool", "Description of what this tool does");
\`\`\``,
};

export default forkAgentSkill;
