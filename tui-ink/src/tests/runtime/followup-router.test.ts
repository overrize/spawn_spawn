import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFollowup, discriminateContinuity, isStatusQuery } from "../../runtime/FollowupRouter.js";

describe("discriminateContinuity", () => {
  it("merges rapid split-bubble input before routing", () => {
    const decision = discriminateContinuity({
      text: "权限怎么处理",
      msSinceLastUserMessage: 900,
    });

    assert.equal(decision.route, "merge_with_pending_input");
    assert.equal(decision.reason, "within_input_window");
  });

  it("keeps ambiguous short bubbles on the same busy base agent", () => {
    const decision = discriminateContinuity({
      text: "Jira 也要",
      baseAgentBusy: true,
      msSinceLastUserMessage: 4_000,
    });

    assert.equal(decision.route, "same_agent_queue");
    assert.equal(decision.reason, "short_ambiguous");
  });

  it("forks only when the user explicitly marks a new or parallel task", () => {
    const decision = discriminateContinuity({
      text: "新任务 帮我整理 GitHub repo 权限模型",
      baseAgentBusy: true,
      msSinceLastUserMessage: 4_000,
    });

    assert.equal(decision.route, "fork_new_agent");
    assert.equal(decision.reason, "explicit_new_task");
    assert.ok(decision.confidence >= 0.9);
  });

  it("uses recent entity overlap to keep connector follow-ups together", () => {
    const decision = discriminateContinuity({
      text: "GitHub repo 权限同步也要考虑",
      baseAgentBusy: true,
      msSinceLastUserMessage: 12_000,
      recentEntities: ["Google Workspace", "GitHub", "Jira"],
    });

    assert.equal(decision.route, "same_agent_queue");
    assert.equal(decision.reason, "recent_entity_overlap");
  });

  it("uses active task overlap for longer continuation messages", () => {
    const decision = discriminateContinuity({
      text: "权限模型里面还要包括审计日志、失败重试和管理员审批流程",
      baseAgentBusy: true,
      activeTaskGoal: "设计组织连接器的权限模型、审计日志、同步策略和失败重试",
      msSinceLastUserMessage: 20_000,
    });

    assert.equal(decision.route, "same_agent_queue");
    assert.equal(decision.reason, "active_goal_overlap");
  });

  it("allows long unrelated work to fork when it is not recent context", () => {
    const decision = discriminateContinuity({
      text: "帮我写一份新的前端性能优化计划，覆盖首屏加载、路由拆包、图片压缩、缓存策略、监控指标、上线回滚方案、灰度发布、错误采集、性能预算和团队执行排期",
      baseAgentBusy: true,
      msSinceLastUserMessage: 120_000,
      activeTaskGoal: "设计组织连接器的权限模型、审计日志、同步策略和失败重试",
      recentEntities: ["Google Workspace", "GitHub", "Jira"],
    });

    assert.equal(decision.route, "fork_new_agent");
    assert.equal(decision.reason, "independent_or_unclear");
  });

  it("forks explicit standalone file inspection even when the text is short", () => {
    const decision = discriminateContinuity({
      text: "让 agent 检查一个不存在的文件路径：tui-ink/src/not-exist-abc.ts，并说明为什么找不到",
      baseAgentBusy: true,
      msSinceLastUserMessage: 8_000,
    });

    assert.equal(decision.route, "fork_new_agent");
    assert.equal(decision.reason, "explicit_standalone_task");
  });
});

describe("classifyFollowup", () => {
  it("routes obvious Chinese follow-ups to the same base agent", () => {
    for (const text of [
      "继续",
      "那这个怎么做？",
      "为什么？",
      "上面那个方案展开一下",
      "改成更安全的方式",
    ]) {
      assert.equal(classifyFollowup(text).isFollowup, true, text);
    }
  });

  it("routes short ambiguous split-bubble fragments to the same base agent", () => {
    for (const text of [
      "还有 GitHub",
      "Jira 也要",
      "权限怎么处理",
      "Notion / Confluence 呢",
    ]) {
      const decision = classifyFollowup(text);
      assert.equal(decision.isFollowup, true, text);
      assert.equal(decision.reason, "short_ambiguous", text);
    }
  });

  it("keeps explicit new tasks eligible for concurrent fork", () => {
    for (const text of [
      "新任务 帮我整理 GitHub 权限方案",
      "另外帮我看一下 Jira 接入",
      "in parallel check the Slack connector",
    ]) {
      assert.equal(classifyFollowup(text).isFollowup, false, text);
    }
  });

  it("does not over-classify a standalone request as follow-up", () => {
    assert.equal(
      classifyFollowup(
        "帮我设计 Google Workspace 同步员工和部门的 schema，并给出权限模型、同步策略、失败重试、审计日志、安全边界、数据隔离、管理员配置、增量同步和异常恢复流程",
      ).isFollowup,
      false,
    );
  });
});

describe("isStatusQuery", () => {
  it("detects busy-turn status probes that should not wait behind the queue", () => {
    for (const text of ["结论呢", "为什么会卡住", "现在什么情况", "status"]) {
      assert.equal(isStatusQuery(text), true, text);
    }
  });

  it("does not treat normal work as a status probe", () => {
    assert.equal(isStatusQuery("分析 httpAgent send 队列"), false);
  });
});
