import { AgentType } from '../../src/core/types.js';
import { AgentInfo } from '../../omo-bridge/spawn-bridge.js';
import { AgentTreeNode } from './index.js';

export interface SwarmNode {
  id: string;
  label: string;
  type: AgentType;
  status: string;
  depth: number;
  forkCount: number;
  children: SwarmNode[];
  memoryKeys: number;
}

export interface MemoryFlow {
  fromId: string;
  fromLabel: string;
  toId: string;
  toLabel: string;
  key: string;
  action: 'write' | 'read';
}

export interface SwarmTopology {
  root: SwarmNode;
  flows: MemoryFlow[];
  totalMemoryKeys: number;
}

export function computeSwarmTopology(tree: AgentTreeNode | null, memoryKeys: Map<string, Map<string, unknown>>): SwarmTopology | null {
  if (!tree) return null;

  const root = toSwarmNode(tree, memoryKeys);
  const flows = computeMemoryFlows(tree, memoryKeys);
  let totalKeys = 0;
  memoryKeys.forEach(m => { totalKeys += m.size; });

  return { root, flows, totalMemoryKeys: totalKeys };
}

function toSwarmNode(node: AgentTreeNode, memoryKeys: Map<string, Map<string, unknown>>): SwarmNode {
  const mem = node.info.type === AgentType.SPAWN ? (memoryKeys.get(node.info.id)?.size ?? 0) : 0;
  return {
    id: node.info.id,
    label: formatAgentLabel(node.info),
    type: node.info.type,
    status: node.info.status,
    depth: node.info.depth ?? 0,
    forkCount: node.info.forkCount ?? 0,
    memoryKeys: mem,
    children: node.children.map(c => toSwarmNode(c, memoryKeys)),
  };
}

function formatAgentLabel(info: AgentInfo): string {
  if (info.type === AgentType.MAIN) return 'MainAgent (orchestrator)';
  const shortId = info.id.length > 14 ? info.id.slice(0, 12) + '..' : info.id;
  return `${info.type === AgentType.SPAWN ? 'Spawn' : 'Fork'} ${shortId}`;
}

function computeMemoryFlows(tree: AgentTreeNode, memoryKeys: Map<string, Map<string, unknown>>): MemoryFlow[] {
  const flows: MemoryFlow[] = [];

  for (const spawn of tree.children) {
    const spawnMem = memoryKeys.get(spawn.info.id);
    if (!spawnMem || spawnMem.size === 0) continue;

    for (const [key] of spawnMem) {
      flows.push({
        fromId: spawn.info.id,
        fromLabel: formatAgentLabel(spawn.info),
        toId: tree.info.id,
        toLabel: formatAgentLabel(tree.info),
        key,
        action: 'write',
      });

      for (const fork of spawn.children) {
        flows.push({
          fromId: spawn.info.id,
          fromLabel: formatAgentLabel(spawn.info),
          toId: fork.info.id,
          toLabel: formatAgentLabel(fork.info),
          key,
          action: 'read',
        });
      }
    }
  }

  return flows;
}

export interface SwarmRenderNode {
  x: number;
  y: number;
  node: SwarmNode;
  parentX: number;
  parentY: number;
}

export function layoutSwarmNodes(root: SwarmNode, width: number, height: number): SwarmRenderNode[] {
  const nodes: SwarmRenderNode[] = [];
  const rootX = Math.floor(width / 2);
  const rootY = 2;

  nodes.push({ x: rootX, y: rootY, node: root, parentX: rootX, parentY: rootY });

  if (root.children.length > 0) {
    const spawnY = rootY + 3;
    const spawnWidth = width / root.children.length;
    for (let i = 0; i < root.children.length; i++) {
      const sx = Math.floor(spawnWidth * i + spawnWidth / 2);
      nodes.push({ x: sx, y: spawnY, node: root.children[i], parentX: rootX, parentY: rootY });

      const spawnNode = root.children[i];
      if (spawnNode.children.length > 0) {
        const forkY = spawnY + 3;
        const forkWidth = spawnWidth / spawnNode.children.length;
        for (let j = 0; j < spawnNode.children.length; j++) {
          const fx = Math.floor(sx - spawnWidth / 2 + forkWidth * j + forkWidth / 2);
          nodes.push({ x: fx, y: forkY, node: spawnNode.children[j], parentX: sx, parentY: spawnY });
        }
      }
    }
  }

  return nodes;
}
