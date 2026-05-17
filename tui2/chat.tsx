import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { streamChat, ModelConfig, DEFAULT_CONFIG } from './llm/provider.js';

interface Msg { role: string; content: string; reasoning?: string }

const history: Array<{ role: string; content: string }> = [];

function App() {
  const { exit } = useApp();
  const [config, setConfig] = useState<ModelConfig>({ ...DEFAULT_CONFIG });
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'system', content: 'Spawn Chat — Enter to send, Ctrl+Q to quit, Ctrl+O to configure.' },
  ]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsField, setSettingsField] = useState(0);
  const [settingsValue, setSettingsValue] = useState('');
  const scrollRef = useRef(0);

  const FIELDS: Array<{ key: keyof ModelConfig; label: string }> = [
    { key: 'apiKey', label: 'API Key' },
    { key: 'model', label: 'Model' },
    { key: 'thinking', label: 'Thinking' },
    { key: 'maxTokens', label: 'Max Tokens' },
    { key: 'temperature', label: 'Temperature' },
  ];

  useInput((inputChar, key) => {
    if (settingsOpen) {
      if (key.escape) { setSettingsOpen(false); return; }
      if (key.return) {
        const f = FIELDS[settingsField];
        if (f.key === 'thinking') setConfig(c => ({ ...c, thinking: settingsValue === 'true' }));
        else if (f.key === 'maxTokens' || f.key === 'temperature') setConfig(c => ({ ...c, [f.key]: Number(settingsValue) || c[f.key] }));
        else setConfig(c => ({ ...c, [f.key]: settingsValue }));
        setSettingsOpen(false);
        return;
      }
      if (key.upArrow) { setSettingsField(f => Math.max(0, f - 1)); setSettingsValue(String(config[FIELDS[Math.max(0, settingsField - 1)].key])); return; }
      if (key.downArrow) { setSettingsField(f => Math.min(FIELDS.length - 1, f + 1)); setSettingsValue(String(config[FIELDS[Math.min(FIELDS.length - 1, settingsField + 1)].key])); return; }
      if (key.backspace || key.delete) { setSettingsValue(v => v.slice(0, -1)); return; }
      if (inputChar) { setSettingsValue(v => v + inputChar); }
      return;
    }

    if (key.ctrl && inputChar === 'q') { exit(); return; }
    if (key.ctrl && inputChar === 'o') {
      setSettingsOpen(true); setSettingsField(0);
      setSettingsValue(String(config[FIELDS[0].key]));
      return;
    }
    if (key.return && !streaming) {
      const msg = input.trim();
      setInput('');
      if (!msg) return;
      send(msg);
    }
  });

  function send(msg: string): void {
    if (!config.apiKey) {
      setMsgs(m => [...m, { role: 'user', content: msg }, { role: 'system', content: 'No API key. Press Ctrl+O.' }]);
      return;
    }
    setMsgs(m => [...m, { role: 'user', content: msg }]);
    history.push({ role: 'user', content: msg });
    setStreaming(true);

    const idx = msgs.length + 1;
    setMsgs(m => [...m, { role: 'assistant', content: '', reasoning: '' }]);

    (async () => {
      try {
        let content = '', reasoning = '';
        for await (const chunk of streamChat(config, history)) {
          content = chunk.content;
          reasoning = chunk.reasoning;
          setMsgs(m => { const n = [...m]; n[idx] = { role: 'assistant', content, reasoning }; return n; });
          if (chunk.done) {
            history.push({ role: 'assistant', content });
            setStreaming(false);
          }
        }
      } catch (err) {
        setMsgs(m => { const n = [...m]; n[idx] = { role: 'system', content: 'Error: ' + String(err) }; return n; });
        setStreaming(false);
      }
    })();
  }

  if (settingsOpen) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="yellow">Model Config (Esc to close, Enter to save)</Text>
        {FIELDS.map((f, i) => {
          const val = i === settingsField ? settingsValue : f.key === 'apiKey' ? '•'.repeat(16) : String(config[f.key]);
          const selected = i === settingsField;
          return (
            <Box key={f.key}>
              <Text color={selected ? 'black' : undefined} backgroundColor={selected ? 'yellow' : undefined}>
                {f.label.padEnd(14)} {val}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  return (
      <Box flexDirection="column" height="100%">
      <Box>
        <Text dimColor>Model: {config.model}{config.thinking ? ' (thinking)' : ''}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {msgs.slice(-30).map((m, i) => (
          <Box key={i} flexDirection="column">
            {m.role === 'user' ? (
              <Text color="yellow">{'>'} {m.content}</Text>
            ) : m.role === 'error' ? (
              <Text color="red">  {m.content}</Text>
            ) : (
              <Box flexDirection="column">
                {m.reasoning ? <Text dimColor>  {m.reasoning}</Text> : null}
                <Text>  {m.content}{streaming && i === msgs.slice(-30).length - 1 && m.role === 'assistant' ? '█' : ''}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
      <Box>
        <Text color="yellow">{'>'} {input}{'█'}</Text>
      </Box>
    </Box>
  );
}

render(<App />, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
