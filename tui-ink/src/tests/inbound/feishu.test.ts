import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFeishuText, normalizeFeishuMessage } from "../../inbound/feishu.js";

describe("Feishu inbound normalization", () => {
  it("extracts text message content", () => {
    const text = extractFeishuText(JSON.stringify({ text: "hello" }), "text");
    assert.equal(text, "hello");
  });

  it("extracts rich post content with title and rows", () => {
    const text = extractFeishuText(JSON.stringify({
      zh_cn: {
        title: "标题",
        content: [
          [{ tag: "text", text: "第一行" }],
          [{ tag: "text", text: "第二" }, { tag: "text", text: "行" }],
        ],
      },
    }), "post");
    assert.equal(text, "标题\n第一行\n第二行");
  });

  it("extracts top-level post content without zh_cn wrapper", () => {
    const text = extractFeishuText(JSON.stringify({
      title: "",
      content: [[
        { tag: "text", text: "给 " },
        { tag: "text", text: "parseTestCounts" },
        { tag: "text", text: " 加 " },
        { tag: "text", text: "bun" },
        { tag: "text", text: " 框架解析" },
      ]],
    }), "post");
    assert.equal(text, "给 parseTestCounts 加 bun 框架解析");
  });

  it("keeps useful text from post links and mentions", () => {
    const text = extractFeishuText(JSON.stringify({
      zh_cn: {
        content: [[
          { tag: "text", text: "看 " },
          { tag: "a", text: "文档", href: "https://example.com" },
          { tag: "at", text: "@bot" },
        ]],
      },
    }), "post");
    assert.equal(text, "看 文档@bot");
  });

  it("falls back to raw content when content is not JSON", () => {
    assert.equal(extractFeishuText("plain raw", "text"), "plain raw");
  });

  it("returns null for empty inbound messages", () => {
    const inbound = normalizeFeishuMessage({
      openId: "ou_1",
      contentRaw: JSON.stringify({ text: "   " }),
      chatId: "chat_1",
      chatType: "p2p",
      messageId: "msg_1",
      messageType: "text",
      receivedAt: 100,
    });
    assert.equal(inbound, null);
  });

  it("normalizes p2p reply target to open_id", () => {
    const inbound = normalizeFeishuMessage({
      openId: "ou_1",
      contentRaw: JSON.stringify({ text: "hello" }),
      chatId: "chat_1",
      chatType: "p2p",
      messageId: "msg_1",
      messageType: "text",
      receivedAt: 100,
    });
    assert.ok(inbound);
    assert.equal(inbound.replyTarget?.replyId, "ou_1");
    assert.equal(inbound.replyTarget?.replyType, "open_id");
    assert.equal(inbound.conversationId, "ou_1");
    assert.equal(inbound.receivedAt, 100);
  });

  it("normalizes group reply target to chat_id", () => {
    const inbound = normalizeFeishuMessage({
      openId: "ou_1",
      contentRaw: JSON.stringify({ text: "hello group" }),
      chatId: "chat_1",
      chatType: "group",
      messageId: "msg_2",
      messageType: "text",
    });
    assert.ok(inbound);
    assert.equal(inbound.replyTarget?.replyId, "chat_1");
    assert.equal(inbound.replyTarget?.replyType, "chat_id");
    assert.equal(inbound.replyTarget?.rootMessageId, "msg_2");
  });
});
