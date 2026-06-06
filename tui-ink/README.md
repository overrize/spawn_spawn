# tui-ink

multi-agent TUI 的实现包。完整文档见根目录 [README.md](../README.md)。

## 开发

```bash
npm install
npm run dev          # 启动（live 模式）
npm run dev -- --demo  # demo 模式，不需要 API key
npm run typecheck    # tsc --noEmit
npm test             # 全部测试
```

## 入口

- **`src/index.tsx`** — 启动、快捷键、agent 生命周期
- **`src/store.ts`** — Zustand 状态 + applyEvent
- **`src/adapters/httpAgent.ts`** — HTTP 流式 LLM adapter
- **`src/tools/registry.ts`** — 工具白名单 + 执行器
