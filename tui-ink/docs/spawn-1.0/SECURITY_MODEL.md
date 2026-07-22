# Spawn 安全模型（M3-6）

> spawn 的 agent 能读写文件、跑命令。本文档定死"能做什么、什么必须批、什么绝对禁止"，
> 并由 `src/tests/security-model-m3-6.test.ts` 断言守护。

## 三道闸

```
agent 想执行工具
   │
   ├─①  banned 命令？ ──是──► 直接拒绝（连审批都不给）
   │
   ├─②  写路径越界？ ──是──► 拒绝（outside_workspace）
   │
   └─③  破坏性操作？ ──是──► 路由到父 Leader 审批（y/n），不直接问用户
                     └─否──► 只读/安全，自动放行
```

## ① Banned 命令（硬禁，不可审批放行）

网络/远程类命令一律拒绝，杜绝数据外泄 / 远程执行通道：
`nc ncat netcat telnet ssh scp ftp rsync curl wget http https head`
（`src/tools/registry.ts` `BANNED_COMMANDS`；`isBanned` 取命令首 token 去路径后比对，`curl`/`/usr/bin/curl` 都拦）。
拒绝理由提示用 Read/Grep/Glob/LS/WebFetch 工具替代。

## ② WorkspaceBoundary（写入边界）

所有落盘工具（Read/Write/Edit + Bash 的 cwd）解析后必须落在允许根内，否则 `outside_workspace` 拒绝。
允许根 = `process.cwd()` + `os.tmpdir()`（`resolveToolPath` → `WorkspaceBoundary.resolveInside`）。
`../` 逃逸、绝对路径越界、空路径都拒绝（`isInside` 用 `path.relative` 判断，防 `..` 前缀绕过）。

## ③ 审批矩阵（破坏性操作 → 父 Leader 批）

`BASH_DESTRUCTIVE` 命中即 `needs_approval`，**路由到父 Leader**（不是直接问用户）：
- 文件写/删/移/权限：`rm del mv cp move copy mkdir touch chmod chown tee` + 重定向 `> >>`
- 版本控制写：`git reset/checkout/branch -D/stash`
- 安装/包管理：`npm install/run/ci` `yarn add` `pip install` `apt brew choco`

只读命令（`ls cat git status grep` 等）自动放行。**未知工具默认需要审批**（`toolNeedsApproval` 兜底 true）。

审批链路：Worker 的破坏性 Bash → `findApproverLeader` 找到父 Leader → Leader 回 `tool.approved`/`tool.rejected`；
根 PM 无父可批 → 返回错误让其换非破坏性方案。y/n 只在审批浮层内生效。

## 边界（本模型不覆盖）

- 不做进程级沙箱/容器隔离；边界是**路径级 + 命令级**，不是 OS 级。
- Bash 仍可跑允许根内的任意非破坏性命令——不做细粒度系统调用过滤。
- 不防 agent 在允许根内的合法但不明智的操作（靠审批 + 人在环兜）。

## 回归

`security-model-m3-6.test.ts` 4 组断言：banned 拒绝 · 破坏性需审批/只读放行 · 越界写拒绝 · 未知工具默认审批。
改动任何安全机制必须先过这些用例。
