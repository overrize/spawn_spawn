export interface AgentModelConfig {
  model: string;
  provider: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
}

export interface SpawnProfile {
  name: string;
  description: string;
  model: AgentModelConfig;
  maxForks: number;
  memoryQuota: number;
  autoResume: boolean;
}

export const DEFAULT_MODEL: AgentModelConfig = {
  model: 'claude-sonnet-4',
  provider: 'anthropic',
  maxTokens: 200000,
  temperature: 0.7,
  systemPrompt: 'You are a task execution agent in a spawn/fork orchestration system.',
};

export const PRESET_PROFILES: SpawnProfile[] = [
  {
    name: 'Code Reviewer',
    description: 'Reviews code changes, checks style and correctness',
    model: { ...DEFAULT_MODEL, model: 'claude-sonnet-4', systemPrompt: 'You are a code reviewer. Analyze code for bugs, style issues, and improvements.' },
    maxForks: 4,
    memoryQuota: 32,
    autoResume: true,
  },
  {
    name: 'Test Writer',
    description: 'Generates comprehensive test suites',
    model: { ...DEFAULT_MODEL, model: 'claude-sonnet-4', systemPrompt: 'You are a test engineer. Write thorough unit and integration tests.' },
    maxForks: 3,
    memoryQuota: 24,
    autoResume: true,
  },
  {
    name: 'Bug Hunter',
    description: 'Traces and diagnoses bugs in codebases',
    model: { ...DEFAULT_MODEL, model: 'claude-opus-4', maxTokens: 300000, systemPrompt: 'You are a debugging specialist. Trace errors and identify root causes.' },
    maxForks: 6,
    memoryQuota: 48,
    autoResume: false,
  },
  {
    name: 'Doc Writer',
    description: 'Generates and updates documentation',
    model: { ...DEFAULT_MODEL, model: 'claude-haiku-4', maxTokens: 100000, systemPrompt: 'You are a technical writer. Create clear, concise documentation.' },
    maxForks: 2,
    memoryQuota: 16,
    autoResume: true,
  },
  {
    name: 'Refactor Agent',
    description: 'Restructures code for maintainability',
    model: { ...DEFAULT_MODEL, model: 'claude-sonnet-4', systemPrompt: 'You are a refactoring specialist. Improve code structure without changing behavior.' },
    maxForks: 4,
    memoryQuota: 32,
    autoResume: false,
  },
];

export function getProfile(name: string): SpawnProfile | undefined {
  return PRESET_PROFILES.find(p => p.name.toLowerCase() === name.toLowerCase());
}
