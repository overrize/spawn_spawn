// Shared TUI primitives for the multi-agent wireframes.
// Plain low-fi blocks: window chrome, panes, rows, todo lines, conversation.

// ── data ─────────────────────────────────────────────────────────────────────
// Different agent rosters keyed by demo size so the count tweak swaps them out.
const AGENT_SETS = {
  1: [
    { id: "leader", name: "leader", role: "Leader", lvl: 0, status: "run", sub: "writing PRD draft", busy: true },
  ],
  3: [
    { id: "leader",  name: "leader",       role: "Leader",     lvl: 0, status: "run",  sub: "planning · 3 todos", busy: true },
    { id: "sec",     name: "secretary",    role: "Secretary",  lvl: 1, status: "wait", sub: "watching inbox" },
    { id: "coder",   name: "coder-01",     role: "Worker",     lvl: 1, status: "run",  sub: "edit src/api.ts", busy: true },
  ],
  8: [
    { id: "leader",   name: "leader",       role: "Leader",    lvl: 0, status: "run",  sub: "planning · 5 todos", busy: true },
    { id: "sec",      name: "secretary",    role: "Secretary", lvl: 1, status: "run",  sub: "triaging inbox", busy: true },
    { id: "coder",    name: "coder-01",     role: "Worker",    lvl: 1, status: "run",  sub: "edit src/api.ts", busy: true },
    { id: "coder2",   name: "coder-02",     role: "Worker",    lvl: 2, status: "wait", sub: "waiting on coder-01" },
    { id: "tester",   name: "tester",       role: "Worker",    lvl: 1, status: "run",  sub: "vitest --watch", busy: true },
    { id: "reviewer", name: "reviewer",     role: "Worker",    lvl: 1, status: "done", sub: "approved 2 diffs" },
    { id: "doc",      name: "doc-writer",   role: "Worker",    lvl: 2, status: "wait", sub: "queued" },
    { id: "scout",    name: "web-scout",    role: "Worker",    lvl: 1, status: "warn", sub: "rate limited · retrying" },
  ],
};

const SESSIONS = [
  { id: "s1", title: "redesign login flow",        last: "2m",  unread: 3, sel: true },
  { id: "s2", title: "kline ws reconnect bug",     last: "8m",  unread: 1 },
  { id: "s3", title: "agents page wireframe pass", last: "1h",  unread: 0 },
  { id: "s4", title: "settings · theme tokens",    last: "3h",  unread: 0 },
  { id: "s5", title: "i18n strings sweep",         last: "y'day", unread: 0 },
];

const CONVERSATION = [
  { who: "user", text: "把 login 页改成纸色 + 双栏,左表单右滚动报价。先给我个 wireframe。" },
  { who: "agent", text: "好,我先 spawn 一个 secretary 跟一个 coder-01。三步:1)读 tokens 2)出三种线框 3)汇总。" },
  { who: "tool", name: "spawn_agent", args: "role=secretary, goal='watch inbox'", result: "agent-id=sec-7f3" },
  { who: "tool", name: "read_file",   args: "docs/login.html", result: "1.2k tokens" },
  { who: "agent", text: "tokens 拿到了。开始画 v1 — 左表单 60%,右报价 40%,顶 logo + Graham 名言。" },
];

const TODOS_LEADER = [
  { state: "done", text: "读取 docs/login.html + tokens.css", t: "0:12" },
  { state: "done", text: "调度 secretary 监控 inbox",       t: "0:03" },
  { state: "run",  text: "生成 3 种 wireframe 候选",         t: "0:42", progress: 64 },
  { state: "todo", text: "汇总 + 出对比表",                  t: "—" },
  { state: "todo", text: "等待用户挑选并迭代",                t: "—" },
];
const TODOS_CODER = [
  { state: "done", text: "git checkout -b login/paper-redesign", t: "0:01" },
  { state: "run",  text: "重写 LoginForm.tsx (paper tokens)",    t: "1:24", progress: 38 },
  { state: "todo", text: "接入 QuoteRail 组件",                  t: "—" },
  { state: "todo", text: "添加 Graham quote rotator",            t: "—" },
];

// ── primitives ───────────────────────────────────────────────────────────────

function Dot({ state }) {
  return <span className={`dot ${state}`} />;
}

function StatusIcon({ state }) {
  if (state === "run") return <span className="spin" />;
  if (state === "wait") return <span style={{color: "var(--tui-ink-3)"}}>◯</span>;
  if (state === "done") return <span style={{color: "var(--tui-ink-3)"}}>✓</span>;
  if (state === "warn") return <span style={{color: "var(--tui-warn)"}}>⚠</span>;
  if (state === "err")  return <span style={{color: "var(--tui-down)"}}>✗</span>;
  return <span>·</span>;
}

function WindowChrome({ title, tabs, palette, children }) {
  return (
    <div className="tui-frame">
      <div className="tui-titlebar">
        <span className="dots"><i/><i/><i/></span>
        <span className="title">{title}</span>
        {tabs && (
          <span className="tabs">
            {tabs.map((t, i) => <span key={i}>{t}</span>)}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function PaneHead({ title, count, right }) {
  return (
    <div className="tui-pane-head">
      <span>{title}</span>
      {count != null && <span className="count">{count}</span>}
      {right && <span className="right">{right}</span>}
    </div>
  );
}

function AgentRow({ a, sel, dense }) {
  return (
    <div className={`tui-row lvl${a.lvl} ${sel ? "sel" : ""}`} style={dense ? {padding: "3px 10px"} : undefined}>
      <span className="icon"><Dot state={a.status} /></span>
      <span className="label">
        <span style={{color: "var(--tui-ink)"}}>{a.name}</span>
        {!dense && a.sub && <div className="sub">{a.sub}</div>}
      </span>
      <span className="tag">{a.role[0]}</span>
    </div>
  );
}

function SessionRow({ s }) {
  return (
    <div className={`tui-row ${s.sel ? "sel" : ""}`}>
      <span className="icon">{s.unread ? "●" : "○"}</span>
      <span className="label">
        <span>{s.title}</span>
        <div className="sub">{s.last} ago</div>
      </span>
      {s.unread > 0 && <span className="tag" style={{borderColor: "var(--tui-accent)", color: "var(--tui-accent)"}}>{s.unread}</span>}
    </div>
  );
}

function Bubble({ b }) {
  if (b.who === "tool") {
    return (
      <div className="bubble tool">
        <div className="who">► tool · {b.name}</div>
        <div className="body">
          <div className="args">{"  "}args: {b.args}</div>
          <div>{"  "}→ {b.result}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="bubble">
      <div className={`who ${b.who === "user" ? "user" : ""}`}>{b.who === "user" ? "▶ you" : "◆ leader"}</div>
      <div className="body">{b.text}</div>
    </div>
  );
}

function Conversation({ compact }) {
  return (
    <div className="conv" style={compact ? {padding: "8px 12px"} : undefined}>
      {CONVERSATION.map((b, i) => <Bubble key={i} b={b} />)}
    </div>
  );
}

function Todo({ t, showBar }) {
  const glyph = t.state === "done" ? "✓" : t.state === "run" ? "◐" : "◯";
  return (
    <div className={`todo ${t.state}`}>
      <span className="glyph">{glyph}</span>
      <span>
        <div className="text">{t.text}</div>
        {showBar && t.state === "run" && (
          <div className="bar"><i style={{width: `${t.progress}%`}}/></div>
        )}
      </span>
      <span className="meta">{t.t}</span>
    </div>
  );
}

function TodoList({ todos = TODOS_LEADER, showBar = true, title }) {
  return (
    <div>
      {title && <div className="tui-pane-head">{title}</div>}
      <div className="todo-list">
        {todos.map((t, i) => <Todo key={i} t={t} showBar={showBar} />)}
      </div>
    </div>
  );
}

function InputBar({ hint = "send to leader", placeholder = "type a message · ⌘K palette · @ to mention agent" }) {
  return (
    <div className="tui-input">
      <span className="prompt">›</span>
      <span className="ph">{placeholder}</span>
      <span className="caret" />
      <span className="keys">
        <kbd>↩</kbd>send
        <kbd>⇧↩</kbd>newline
        <kbd>⌘K</kbd>palette
      </span>
    </div>
  );
}

function StatusBar({ items }) {
  return (
    <div className="tui-status">
      {items.map((it, i) => (
        <span key={i} className={`seg ${it.on ? "on" : ""}`}>
          {it.label}
        </span>
      ))}
      <span className="gap" />
      <span className="seg">⌘? help</span>
    </div>
  );
}

Object.assign(window, {
  AGENT_SETS, SESSIONS, CONVERSATION, TODOS_LEADER, TODOS_CODER,
  Dot, StatusIcon, WindowChrome, PaneHead,
  AgentRow, SessionRow, Bubble, Conversation, Todo, TodoList,
  InputBar, StatusBar,
});
