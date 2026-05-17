// The three multi-agent TUI wireframe variants.
// Each is a complete "screen" that fills its artboard.

// ── V1 · Classic 3-pane inbox ────────────────────────────────────────────────
//   [ agents ] [ sessions ] [ conversation + todos ]
function V1ThreePane({ agentCount = 3, dense = false }) {
  const agents = AGENT_SETS[agentCount] || AGENT_SETS[3];
  return (
    <div className="tui-screen">
      <WindowChrome
        title="multi-agent · inbox"
        tabs={["⌘K", "agents", "logs", "settings"]}
      />
      <div className="tui-body" style={{flex: 1, display: "flex"}}>
        <div className="tui-pane" style={{width: 180, flex: "none"}}>
          <PaneHead title="agents" count={agents.length} right="+ new" />
          <div className="tui-pane-body">
            {agents.map(a => <AgentRow key={a.id} a={a} sel={a.id === "leader"} dense={dense} />)}
          </div>
        </div>
        <div className="tui-pane" style={{width: 200, flex: "none"}}>
          <PaneHead title="sessions" count={SESSIONS.length} right="filter" />
          <div className="tui-pane-body">
            {SESSIONS.map(s => <SessionRow key={s.id} s={s} />)}
          </div>
        </div>
        <div className="tui-pane" style={{flex: 1, display: "flex", flexDirection: "column"}}>
          <PaneHead
            title="leader · redesign login flow"
            right={<span>⏸ pause &nbsp;·&nbsp; fork &nbsp;·&nbsp; config</span>}
          />
          <div style={{flex: 1, display: "flex", minHeight: 0}}>
            <div style={{flex: 1, overflow: "auto", borderRight: "1px solid var(--tui-line-3)"}}>
              <Conversation compact={dense} />
            </div>
            <div style={{width: 240, flex: "none", overflow: "auto", background: "var(--tui-bg-2)"}}>
              <div className="tui-pane-head">
                <span>todo · leader</span>
                <span className="right">2/5</span>
              </div>
              <div className="todo-list">
                {TODOS_LEADER.map((t, i) => <Todo key={i} t={t} showBar />)}
              </div>
              <div className="tui-pane-head" style={{borderTop: "1px solid var(--tui-line-3)"}}>
                <span>todo · coder-01</span>
                <span className="right">1/4</span>
              </div>
              <div className="todo-list">
                {TODOS_CODER.map((t, i) => <Todo key={i} t={t} showBar />)}
              </div>
            </div>
          </div>
          <InputBar />
        </div>
      </div>
      <StatusBar items={[
        { label: "● 3 running" , on: true },
        { label: "○ 2 waiting" },
        { label: "branch login/paper-redesign" },
        { label: "tokens 14.2k / 200k" },
      ]} />
    </div>
  );
}


// ── V2 · 2-pane + bottom dock ────────────────────────────────────────────────
//   left rail merges agents + sessions
//   big center conversation
//   bottom dock = live tool calls + todos + token meter
function V2Dock({ agentCount = 3, dense = false }) {
  const agents = AGENT_SETS[agentCount] || AGENT_SETS[3];
  return (
    <div className="tui-screen">
      <WindowChrome
        title="multi-agent · workbench"
        tabs={["⌘K", "files", "git", "?"]}
      />
      <div className="tui-body" style={{flex: 1, display: "flex"}}>
        <div className="tui-pane" style={{width: 220, flex: "none"}}>
          <PaneHead title="agents" count={agents.length} right="⌘1" />
          <div className="tui-pane-body" style={{flex: "none", maxHeight: "50%"}}>
            {agents.map(a => <AgentRow key={a.id} a={a} sel={a.id === "leader"} dense={dense} />)}
          </div>
          <PaneHead title="threads · leader" count={SESSIONS.length} />
          <div className="tui-pane-body">
            {SESSIONS.slice(0, 4).map(s => <SessionRow key={s.id} s={s} />)}
          </div>
        </div>
        <div className="tui-pane" style={{flex: 1, display: "flex", flexDirection: "column"}}>
          <PaneHead
            title="◆ leader / redesign login flow"
            right={<span>↻ replay · ⏸ pause · ⑂ fork · ⚙ config</span>}
          />
          <div style={{flex: 1, overflow: "auto"}}>
            <Conversation />
          </div>
          <InputBar />
        </div>
      </div>
      {/* bottom dock */}
      <div className="tui-dock" style={{maxHeight: 168}}>
        <div className="tui-dock-col">
          <h4>● live · leader</h4>
          <div style={{fontSize: 11, color: "var(--tui-ink-2)"}}>
            <div><span className="spin" /> generating wireframe v2 of 3</div>
            <div style={{color: "var(--tui-ink-3)", marginTop: 2}}>step 14 of ~22 · 0:42</div>
            <div className="bar striped" style={{marginTop: 6}}><i style={{width: "64%"}}/></div>
          </div>
          <div style={{marginTop: 8, fontSize: 10, color: "var(--tui-ink-3)"}}>
            <div>► read_file docs/login.html</div>
            <div>► write_file wireframe-v2.html</div>
            <div style={{color: "var(--tui-warn)"}}>⚠ approve_request: git push?</div>
          </div>
        </div>
        <div className="tui-dock-col">
          <h4>☐ todo · leader  2/5</h4>
          {TODOS_LEADER.slice(0,4).map((t, i) => <Todo key={i} t={t} showBar />)}
        </div>
        <div className="tui-dock-col">
          <h4>☐ todo · coder-01  1/4</h4>
          {TODOS_CODER.slice(0,4).map((t, i) => <Todo key={i} t={t} showBar />)}
        </div>
      </div>
      <StatusBar items={[
        { label: "● 3 running", on: true },
        { label: "approvals: 1 pending" },
        { label: "diff: +124 −18" },
        { label: "tokens 14.2k / 200k · $0.18" },
      ]} />
    </div>
  );
}


// ── V3 · DAG mini-map + tabs ─────────────────────────────────────────────────
//   top: DAG graph of agent relationships (visual hierarchy)
//   middle: tabs per agent (chrome-style)
//   below tabs: split conv + todo
function DagSvg({ count, palette }) {
  // simple hand-laid DAG matching the agent rosters
  const nodes = {
    1: [ {id:"L", x: 50, y: 50, label: "leader", active: true} ],
    3: [
      {id:"L",  x: 50, y: 28, label: "leader",    active: true},
      {id:"S",  x: 22, y: 72, label: "secretary", active: false},
      {id:"C",  x: 78, y: 72, label: "coder-01",  active: true},
    ],
    8: [
      {id:"L",  x: 50, y: 16, label: "leader",    active: true},
      {id:"S",  x: 14, y: 52, label: "secretary", active: true},
      {id:"C1", x: 38, y: 52, label: "coder-01",  active: true},
      {id:"T",  x: 62, y: 52, label: "tester",    active: true},
      {id:"R",  x: 86, y: 52, label: "reviewer",  active: false},
      {id:"C2", x: 38, y: 86, label: "coder-02",  active: false, pending: true},
      {id:"D",  x: 24, y: 86, label: "doc",       active: false},
      {id:"W",  x: 76, y: 86, label: "web-scout", active: false, warn: true},
    ],
  };
  const edges = {
    1: [],
    3: [["L","S"], ["L","C"]],
    8: [["L","S"],["L","C1"],["L","T"],["L","R"],["C1","C2"],["S","D"],["T","W"]],
  };
  const ns = nodes[count] || nodes[3];
  const es = edges[count] || edges[3];
  const byId = Object.fromEntries(ns.map(n => [n.id, n]));
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{position: "absolute", inset: 0, width: "100%", height: "100%"}}>
      {es.map(([a, b], i) => {
        const A = byId[a], B = byId[b];
        if (!A || !B) return null;
        return (
          <line key={i} x1={A.x} y1={A.y} x2={B.x} y2={B.y}
            stroke="var(--tui-line)" strokeWidth="0.3" strokeDasharray="1 1" />
        );
      })}
      {ns.map(n => (
        <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
          <circle r="3" fill={n.active ? "var(--tui-accent)" : "var(--tui-bg)"}
            stroke={n.warn ? "var(--tui-warn)" : "var(--tui-ink-2)"} strokeWidth="0.3" />
          {n.active && <circle r="4.5" fill="none" stroke="var(--tui-accent)" strokeWidth="0.2" opacity="0.5" />}
          <text x="0" y="7" textAnchor="middle" fontSize="2.6"
            fontFamily="var(--tui-mono)"
            fill={n.active ? "var(--tui-ink)" : "var(--tui-ink-2)"}>
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function V3Dag({ agentCount = 3, dense = false }) {
  const agents = AGENT_SETS[agentCount] || AGENT_SETS[3];
  return (
    <div className="tui-screen">
      <WindowChrome
        title="multi-agent · graph view"
        tabs={["⌘K", "graph", "list", "logs"]}
      />
      <div className="dag" style={{height: 150, position: "relative"}}>
        <div className="tui-pane-head" style={{position: "absolute", top: 0, left: 0, right: 0, background: "transparent", borderBottom: "none"}}>
          <span>topology · {agents.length} agents</span>
          <span className="count">DAG</span>
          <span className="right">⤢ expand · ⟲ re-layout</span>
        </div>
        <DagSvg count={agentCount} />
        <div className="dag-legend">
          <span><span className="dot run" /> running</span>
          <span><span className="dot wait" /> waiting</span>
          <span><span className="dot warn" /> warn</span>
        </div>
      </div>
      <div className="tui-tabs">
        {agents.slice(0, 6).map((a, i) => (
          <div key={a.id} className={`tui-tab ${i === 0 ? "sel" : ""}`}>
            <Dot state={a.status} />
            <span>{a.name}</span>
            {a.busy && <span style={{color: "var(--tui-accent)", fontSize: 10}}>·{a.role === "Leader" ? "5" : "3"} todos</span>}
            <span className="close">×</span>
          </div>
        ))}
        {agents.length > 6 && <div className="tui-tab" style={{color: "var(--tui-ink-3)"}}>+{agents.length - 6}</div>}
        <div style={{marginLeft: "auto", padding: "6px 10px", color: "var(--tui-ink-3)", fontSize: 10}}>
          ⌘T new tab
        </div>
      </div>
      <div className="tui-body" style={{flex: 1, display: "flex"}}>
        <div className="tui-pane" style={{flex: 1, display: "flex", flexDirection: "column"}}>
          <div style={{flex: 1, overflow: "auto"}}>
            <Conversation compact={dense} />
          </div>
          <InputBar placeholder="reply to leader · @secretary to delegate · /command" />
        </div>
        <div className="tui-pane" style={{width: 260, flex: "none", background: "var(--tui-bg-2)"}}>
          <PaneHead title="todos · leader" count="2/5" right="DAG" />
          <div className="todo-list">
            {TODOS_LEADER.map((t, i) => <Todo key={i} t={t} showBar />)}
          </div>
          <PaneHead title="next: coder-01 hand-off" />
          <div style={{padding: "8px 12px", fontSize: 11, color: "var(--tui-ink-2)"}}>
            <div>↳ when "汇总 + 出对比表" done</div>
            <div>↳ trigger coder-01.write</div>
            <div style={{marginTop: 6, color: "var(--tui-ink-3)"}}>edge auto-derived from prompt</div>
          </div>
        </div>
      </div>
      <StatusBar items={[
        { label: `● ${agents.filter(a=>a.status==="run").length} running`, on: true },
        { label: `DAG ${agentCount === 1 ? "1n" : `${agents.length}n`}/${(agentCount===1?0:agentCount===3?2:7)}e` },
        { label: "depth 3" },
        { label: "tokens 14.2k / 200k" },
      ]} />
    </div>
  );
}


// ── Spec card ────────────────────────────────────────────────────────────────
function SpecCard() {
  const glyphs = [
    { g: "◐", lbl: "running" },
    { g: "◯", lbl: "waiting" },
    { g: "✓", lbl: "done" },
    { g: "⚠", lbl: "warn" },
    { g: "✗", lbl: "failed" },
    { g: "⏸", lbl: "paused" },
    { g: "⑂", lbl: "fork" },
    { g: "↳", lbl: "delegate" },
    { g: "▶", lbl: "user" },
    { g: "◆", lbl: "agent" },
    { g: "►", lbl: "tool call" },
    { g: "└", lbl: "child" },
  ];
  return (
    <div className="spec-card">
      <h3>TUI 规范 · 多 agent 交互</h3>
      <div style={{color: "var(--tui-ink-2)", fontSize: 11}}>
        所有线框共享的视觉/交互词汇表。
      </div>

      <h4>状态字形 (state glyphs)</h4>
      <div style={{display: "flex", flexWrap: "wrap"}}>
        {glyphs.map(g => (
          <div key={g.lbl} className="glyph-cell">
            <span className="g">{g.g}</span>
            <span className="lbl">{g.lbl}</span>
          </div>
        ))}
      </div>

      <h4>角色 (role)</h4>
      <div className="spec-grid">
        <div className="spec-row"><span className="k">Leader</span><span className="v">规划/派发,可 spawn 任意 agent</span></div>
        <div className="spec-row"><span className="k">Secretary</span><span className="v">监控/分拣/通知,不写代码</span></div>
        <div className="spec-row"><span className="k">Worker</span><span className="v">执行单一职能 (coder/tester/scout)</span></div>
        <div className="spec-row"><span className="k">DAG edge</span><span className="v">A.done → B.start</span></div>
      </div>

      <h4>布局 (layout)</h4>
      <div className="spec-grid">
        <div className="spec-row"><span className="k">V1 · 三栏</span><span className="v">agents | sessions | conv+todo</span></div>
        <div className="spec-row"><span className="k">V2 · 双栏+底栏</span><span className="v">rail | conv | dock(live/todo/io)</span></div>
        <div className="spec-row"><span className="k">V3 · DAG+标签</span><span className="v">graph 顶部, 标签切换 agent</span></div>
      </div>

      <h4>颜色与字体</h4>
      <div className="spec-grid">
        <div className="spec-row"><span className="k">bg / ink</span><span className="v">paper #fafaf7 / ink #2b2820</span></div>
        <div className="spec-row"><span className="k">accent</span><span className="v">muted teal · 仅用于 active/running</span></div>
        <div className="spec-row"><span className="k">warn / err</span><span className="v">amber #b8742b / magenta #b83565</span></div>
        <div className="spec-row"><span className="k">mono</span><span className="v">IBM Plex Mono / SF Mono</span></div>
        <div className="spec-row"><span className="k">tabular</span><span className="v">所有数字 font-variant-numeric: tabular-nums</span></div>
        <div className="spec-row"><span className="k">主题</span><span className="v">paper · green CRT · amber</span></div>
      </div>

      <h4>键盘 (keyboard)</h4>
      <div className="spec-grid">
        <div className="spec-row"><span className="k">⌘K</span><span className="v">全局 palette</span></div>
        <div className="spec-row"><span className="k">⌘1 / ⌘2 / ⌘3</span><span className="v">切换栏 (agents/sessions/conv)</span></div>
        <div className="spec-row"><span className="k">⌘T / ⌘W</span><span className="v">新 tab / 关闭</span></div>
        <div className="spec-row"><span className="k">Esc</span><span className="v">中断 agent 当前 step</span></div>
        <div className="spec-row"><span className="k">@</span><span className="v">@-mention 切换 / 分派</span></div>
        <div className="spec-row"><span className="k">/</span><span className="v">slash command (/fork /pause /config)</span></div>
      </div>

      <h4>交互原则</h4>
      <div style={{fontSize: 11, color: "var(--tui-ink-2)", lineHeight: 1.7}}>
        <div>· 鼠标可点 = 键盘可达,反之亦然</div>
        <div>· approve/reject 工具调用始终在 conversation 内联,不弹窗</div>
        <div>· 长任务必须有进度条 + 当前 step 文本 + 耗时</div>
        <div>· spawn / fork 总是显式;agent 自身不可静默 spawn</div>
        <div>· 颜色只在 running / warn / err 三处出现,其余一律中性</div>
      </div>
    </div>
  );
}

Object.assign(window, { V1ThreePane, V2Dock, V3Dag, SpecCard });
