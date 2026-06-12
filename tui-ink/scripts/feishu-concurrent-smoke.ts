#!/usr/bin/env npx tsx
/**
 * Feishu concurrent-dispatch smoke test (semi-automated).
 *
 * Sends 4 preset message sequences to the bot at controlled intervals.
 * Prints each send's timestamp + messageId for comparison with Feishu reply order.
 * Human verifies that replies in Feishu are isolated (no cross-contamination).
 *
 * Usage:
 *   FEISHU_APP_ID=cli_xxx \
 *   FEISHU_APP_SECRET=xxx \
 *   FEISHU_OPEN_ID=ou_xxx \
 *   npx tsx scripts/feishu-concurrent-smoke.ts
 *
 * Optional env vars:
 *   FEISHU_WINDOW_GAP_MS   — gap within input-merge window (default 500ms)
 *   FEISHU_FORK_GAP_MS     — gap between fork-triggering messages (default 4000ms)
 */

import https from "node:https";

const APP_ID     = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const OPEN_ID    = process.env.FEISHU_OPEN_ID;

if (!APP_ID || !APP_SECRET || !OPEN_ID) {
  console.error(
    "Missing required env vars: FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_OPEN_ID",
  );
  process.exit(1);
}

const WIN_GAP_MS  = Number(process.env.FEISHU_WINDOW_GAP_MS ?? 500);
const FORK_GAP_MS = Number(process.env.FEISHU_FORK_GAP_MS  ?? 4000);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function post(path: string, body: unknown, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload).toString(),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = https.request(
      {
        hostname: "open.feishu.cn",
        path,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function getToken(): Promise<string> {
  const res = await post("/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: APP_ID,
    app_secret: APP_SECRET,
  });
  if (res.code !== 0) throw new Error(`token error: ${JSON.stringify(res)}`);
  return res.tenant_access_token as string;
}

async function sendText(token: string, text: string): Promise<string> {
  const ts = new Date().toISOString();
  const res = await post(
    "/open-apis/im/v1/messages?receive_id_type=open_id",
    {
      receive_id: OPEN_ID,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
    token,
  );
  const msgId: string = res.data?.message_id ?? "(unknown)";
  console.log(`[${ts}] SENT  "${text.slice(0, 60)}"  → msgId=${msgId}`);
  if (res.code !== 0) {
    console.warn(`  ⚠ Feishu error code=${res.code} msg=${res.msg}`);
  }
  return msgId;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Smoke sequences ───────────────────────────────────────────────────────────

async function main() {
  console.log("=== Feishu Concurrent Smoke Test ===");
  console.log(`OPEN_ID=${OPEN_ID?.slice(0, 10)}...`);
  console.log(`WIN_GAP=${WIN_GAP_MS}ms  FORK_GAP=${FORK_GAP_MS}ms\n`);

  const token = await getToken();
  console.log(`Token acquired (${token.slice(0, 12)}...)\n`);

  // ── 序列 1: 合并窗口 (3 条碎片，间隔 WIN_GAP_MS，应合并为 1 次派发) ──────
  console.log("--- 序列1: 合并窗口 (3 fragments within input window) ---");
  await sendText(token, "I2C 总线");
  await sleep(WIN_GAP_MS);
  await sendText(token, "挂死怎么");
  await sleep(WIN_GAP_MS);
  await sendText(token, "排查");
  console.log("  预期: bot 回复 1 条，内容关于 I2C 总线挂死排查\n");
  await sleep(FORK_GAP_MS * 2); // 等上一序列回复完

  // ── 序列 2: 并发 fork (2 条窗口外，应触发 fork) ──────────────────────────
  console.log("--- 序列2: 并发 fork (2 独立问题，窗口外) ---");
  await sendText(token, "I2C 总线挂死怎么排查？请详细说明");
  await sleep(FORK_GAP_MS);
  await sendText(token, "SPI 全双工和半双工的区别是什么？");
  console.log("  预期: 2 条独立回复，各自只回答自己那个问题，无复述\n");
  await sleep(FORK_GAP_MS * 3);

  // ── 序列 3: 排队 (4 条窗口外，第 4 条应进 pendingQueue) ─────────────────
  console.log("--- 序列3: 排队 (4 messages, 第4条应排队) ---");
  await sendText(token, "什么是 DMA 传输？");
  await sleep(FORK_GAP_MS);
  await sendText(token, "UART 波特率怎么计算？");
  await sleep(FORK_GAP_MS);
  await sendText(token, "CAN 总线帧格式是什么？");
  await sleep(FORK_GAP_MS);
  await sendText(token, "PWM 占空比控制原理？");
  console.log("  预期: 前 3 条并发处理，第 4 条排队后依次处理\n");
  await sleep(FORK_GAP_MS * 4);

  // ── 序列 4: 乱序完成 (1 长 + 1 短，短的先完成) ───────────────────────────
  console.log("--- 序列4: 乱序完成 (长问 + 短问, 短的应先回复) ---");
  await sendText(token, "请详细解释嵌入式系统中 RTOS 的任务调度算法，包括优先级抢占、时间片轮转、优先级继承等机制，并举例说明在实际项目中如何选择合适的调度策略。");
  await sleep(FORK_GAP_MS);
  await sendText(token, "GPIO 高低电平");
  console.log("  预期: GPIO 问题先回复（更短），RTOS 问题后回复\n");

  console.log("\n=== 发送完成 ===");
  console.log("请在飞书检查机器人回复，核对：");
  console.log("  序列1: 1条回复，内容关于I2C排查");
  console.log("  序列2: 2条独立回复，无交叉复述");
  console.log("  序列3: 4条回复，均只回答各自问题");
  console.log("  序列4: 短问题先回复");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
