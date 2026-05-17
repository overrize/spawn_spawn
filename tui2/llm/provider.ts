import * as https from 'node:https';
import { ToolDef, ToolCall } from './tools.js';

export interface ModelConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  thinking: boolean;
  maxTokens: number;
  temperature: number;
}

export const DEFAULT_CONFIG: ModelConfig = {
  provider: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  model: 'deepseek-reasoner',
  baseUrl: 'https://api.deepseek.com',
  thinking: true,
  maxTokens: 8192,
  temperature: 0.7,
};

export interface StreamChunk {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  done: boolean;
}

export async function* streamChat(
  config: ModelConfig,
  messages: Array<{ role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }>,
  tools?: ToolDef[],
): AsyncGenerator<StreamChunk> {
  const bodyObj: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
  };

  if (config.thinking) bodyObj.thinking = { type: 'enabled' };
  if (tools && tools.length > 0) bodyObj.tools = tools;

  const body = JSON.stringify(bodyObj);
  const url = new URL('/v1/chat/completions', config.baseUrl);

  const response = await new Promise<any>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname, port: 443, path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'Accept': 'text/event-stream',
        },
      },
      res => resolve(res),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  let buffer = '';
  let content = '', reasoning = '';
  const toolCalls: Map<number, ToolCall> = new Map();

  for await (const chunk of response) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') {
        yield { content, reasoning, toolCalls: [...toolCalls.values()], done: true };
        return;
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (delta.content) content += delta.content;

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { id: tc.id ?? '', function: { name: tc.function?.name ?? '', arguments: '' } });
            }
            const existing = toolCalls.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name = tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          }
        }

        yield {
          content, reasoning,
          toolCalls: [...toolCalls.values()],
          done: json.choices?.[0]?.finish_reason === 'tool_calls',
        };
      } catch {}
    }
  }
  yield { content, reasoning, toolCalls: [...toolCalls.values()], done: true };
}
