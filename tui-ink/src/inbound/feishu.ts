import type { InboundMessage } from "./types.js";

export interface FeishuIncomingRaw {
  openId: string;
  contentRaw: string;
  chatId: string;
  chatType: string;
  messageId: string;
  messageType: string;
  raw?: unknown;
  receivedAt?: number;
}

type FeishuPostElement = {
  tag?: string;
  text?: string;
  href?: string;
  user_id?: string;
};

type FeishuPostBody = {
  title?: string;
  content?: FeishuPostElement[][];
};

export function extractFeishuText(contentRaw: string, messageType: string): string {
  try {
    const contentObj = JSON.parse(contentRaw || "{}") as Record<string, unknown>;
    const text = contentObj["text"];
    if (typeof text === "string" && text.trim()) return text;

    if (messageType === "post" || contentObj["zh_cn"] || contentObj["en_us"] || contentObj["content"]) {
      const postBody = (contentObj["zh_cn"] ?? contentObj["en_us"] ?? contentObj) as FeishuPostBody | undefined;
      if (!postBody) return "";
      const parts: string[] = [];
      if (postBody.title) parts.push(postBody.title);
      for (const row of postBody.content ?? []) {
        const rowText = row.map(extractPostElementText).filter(Boolean).join("");
        if (rowText) parts.push(rowText);
      }
      return parts.join("\n").trim();
    }
  } catch {
    return contentRaw;
  }
  return "";
}

export function normalizeFeishuMessage(input: FeishuIncomingRaw): InboundMessage | null {
  const text = extractFeishuText(input.contentRaw, input.messageType).trim();
  if (!text) return null;
  const replyType = input.chatType === "group" ? "chat_id" : "open_id";
  const replyId = input.chatType === "group" ? input.chatId : input.openId;
  return {
    source: "feishu",
    conversationId: input.openId,
    senderId: input.openId,
    messageId: input.messageId,
    text,
    chatId: input.chatId,
    chatType: input.chatType,
    messageType: input.messageType,
    replyTarget: { replyId, replyType, rootMessageId: input.messageId },
    raw: input.raw,
    receivedAt: input.receivedAt ?? Date.now(),
  };
}

function extractPostElementText(element: FeishuPostElement): string {
  if (element.tag === "text") return element.text ?? "";
  if (element.tag === "a") return element.text ?? element.href ?? "";
  if (element.tag === "at") return element.text ?? "";
  return element.text ?? "";
}
