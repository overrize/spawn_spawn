import { store, AgentStore } from './store/index.js';
import { computeSwarmTopology, SwarmTopology } from './store/swarm.js';
import { defaultTheme } from './themes/default.js';
import { statusBar } from './components/status.js';
import { agentTree } from './components/tree.js';
import { memoryTable } from './components/table.js';
import { eventLog } from './components/log.js';
import { box } from './components/box.js';
import { Renderer } from './engine/renderer.js';
import { spawnBridge } from '../omo-bridge/index.js';
import { AgentType } from '../src/core/types.js';

import type { Bounds, Theme } from './engine/types.js';

const theme: Theme = defaultTheme;

async function snapshot(): Promise<void> {
  const { spawnId: s1 } = await spawnBridge.spawnAgent('Auth service', ['use-oauth2']);
  const { spawnId: s2 } = await spawnBridge.spawnAgent('Database layer', ['postgres-only']);

  spawnBridge.memorySet(s1, 'auth.provider', 'jwt');
  spawnBridge.memorySet(s1, 'token.ttl', 3600);
  spawnBridge.memorySet(s1, 'endpoint.url', 'https://auth.example.com');
  spawnBridge.memorySet(s2, 'db.host', 'localhost');
  spawnBridge.memorySet(s2, 'db.port', 5432);

  const { forkId: f1 } = await spawnBridge.forkAgent(s1, 'Login handler');
  const { forkId: f2 } = await spawnBridge.forkAgent(s1, 'Token refresh');
  await spawnBridge.forkAgent(s2, 'Query builder');
  await spawnBridge.pauseAgent(f2);

  spawnBridge.memorySet(s1, 'cache.strategy', 'redis');
  spawnBridge.memoryDelete(s1, 'token.ttl');

  store.refresh();
  const state = store.getState();

  const width = Math.min(process.stdout.columns ?? 120, 120);
  const height = 40;

  const renderer = new Renderer(width, height);

  const statusBounds: Bounds = { x: 0, y: 0, width, height: 1 };
  const treeBounds: Bounds = { x: 0, y: 1, width: Math.floor(width * 0.65), height: height - 1 };
  const rightW = width - treeBounds.width;
  const memBounds: Bounds = { x: treeBounds.width, y: 0, width: rightW, height: Math.floor(height * 0.55) };
  const logBounds: Bounds = { x: treeBounds.width, y: memBounds.height, width: rightW, height: height - memBounds.height };

  renderer.clear();

  for (const c of statusBar(statusBounds, state.team, theme)) renderer.draw(c);
  for (const c of box(treeBounds, theme, { title: ' Agent Tree ' })) renderer.draw(c);

  const treeInner: Bounds = { x: treeBounds.x + 1, y: treeBounds.y + 1, width: treeBounds.width - 2, height: treeBounds.height - 2 };
  for (const c of agentTree(treeInner, state.tree, null, theme)) renderer.draw(c);

  for (const c of box(memBounds, theme, { title: ' Shared Memory ' })) renderer.draw(c);
  const memInner: Bounds = { x: memBounds.x + 1, y: memBounds.y + 1, width: memBounds.width - 2, height: memBounds.height - 2 };
  const spawnId = state.agents.find(a => a.type === AgentType.SPAWN)?.id ?? null;
  for (const c of memoryTable(memInner, state.memoryKeys, spawnId, theme)) renderer.draw(c);

  for (const c of box(logBounds, theme, { title: ' Events ' })) renderer.draw(c);
  const logInner: Bounds = { x: logBounds.x + 1, y: logBounds.y + 1, width: logBounds.width - 2, height: logBounds.height - 2 };
  for (const c of eventLog(logInner, state.events, theme)) renderer.draw(c);

  const output = renderer.flushToString();
  process.stdout.write(output + '\n');

  await spawnBridge.terminateAgent(s1);
  await spawnBridge.terminateAgent(s2);
}

snapshot().catch(err => {
  process.stderr.write(`Snapshot error: ${String(err)}\n`);
  process.exit(1);
});
