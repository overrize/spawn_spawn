// Root: design canvas with 3 wireframe variants + spec card + tweaks panel.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "paper",
  "agentCount": 3,
  "dense": false,
  "boxChars": true
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // apply palette + box-chars at the document level
  React.useEffect(() => {
    document.documentElement.setAttribute("data-palette", t.palette);
    document.documentElement.setAttribute("data-boxchars", t.boxChars ? "on" : "off");
  }, [t.palette, t.boxChars]);

  // Sizes — each artboard is the live wireframe. Big enough to read at 1× zoom,
  // not so big that all three don't fit on a laptop.
  const W = 900, H = 580;

  return (
    <>
      <div className="page-header">
        <h1>multi-agent TUI · wireframes</h1>
        <p>
          三种不同方向的低保真线框,探索 leader / secretary / worker 多 agent 协作的
          TUI 形态。所有变体共享底部的状态栏字形和键位规范 (见下方 spec 卡片)。
        </p>
        <div className="meta">
          <span>fidelity wireframe</span>
          <span>palette {t.palette}</span>
          <span>agents {t.agentCount}</span>
          <span>density {t.dense ? "compact" : "comfy"}</span>
        </div>
      </div>

      <DesignCanvas>
        <DCSection id="variants" title="布局变体" subtitle="三个完全不同的多 agent 组织方式">
          <DCArtboard id="v1" label="V1 · 三栏 inbox · classic" width={W} height={H}>
            <V1ThreePane agentCount={t.agentCount} dense={t.dense} />
          </DCArtboard>
          <DCArtboard id="v2" label="V2 · 对话 + 底部 dock" width={W} height={H}>
            <V2Dock agentCount={t.agentCount} dense={t.dense} />
          </DCArtboard>
          <DCArtboard id="v3" label="V3 · DAG mini-map + tabs" width={W} height={H}>
            <V3Dag agentCount={t.agentCount} dense={t.dense} />
          </DCArtboard>
        </DCSection>

        <DCSection id="spec" title="TUI 规范" subtitle="字形 / 角色 / 键盘 / 配色">
          <DCArtboard id="spec-card" label="TUI 规范卡片" width={1400} height={760}>
            <SpecCard />
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakSection label="主题 palette" />
        <TweakRadio
          label="palette"
          value={t.palette}
          onChange={(v) => setTweak("palette", v)}
          options={[
            { value: "paper", label: "paper" },
            { value: "green", label: "green" },
            { value: "amber", label: "amber" },
          ]}
        />

        <TweakSection label="agent 数量演示" />
        <TweakRadio
          label="agents"
          value={t.agentCount}
          onChange={(v) => setTweak("agentCount", v)}
          options={[
            { value: 1, label: "1" },
            { value: 3, label: "3" },
            { value: 8, label: "8" },
          ]}
        />

        <TweakSection label="选项" />
        <TweakToggle
          label="紧凑密度"
          value={t.dense}
          onChange={(v) => setTweak("dense", v)}
        />
        <TweakToggle
          label="box-drawing 字符"
          value={t.boxChars}
          onChange={(v) => setTweak("boxChars", v)}
        />
      </TweaksPanel>
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
