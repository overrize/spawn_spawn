// 飞书消息发送模块
// 参考 SOP: E:\spawn-work\feishu-bot-sop.md
// 支持文本(text)、富文本(post)、卡片消息(interactive)

import { feishuLog } from './debug.js';
import {
  FeishuMessageRequest,
  FeishuMessageResponse,
  FeishuError,
  FeishuTextContent,
  FeishuPostContent,
  FeishuInteractiveContent,
  FeishuCardElement,
} from './types.js';

/* ------------------------------------------------------------------ */
/*  TokenManager 接口                                                  */
/* ------------------------------------------------------------------ */

/** Token 管理器，负责获取和缓存 tenant_access_token */
export interface TokenManager {
  /** 返回一个有效的 tenant_access_token */
  getToken(): Promise<string>;
}

/* ------------------------------------------------------------------ */
/*  内部辅助函数                                                       */
/* ------------------------------------------------------------------ */

/**
 * 发送飞书消息（底层函数）
 * @param token 有效的 tenant_access_token
 * @param params 消息请求参数（FeishuMessageRequest）
 * @returns 响应的 data 部分
 */
async function sendMessage(
  token: string,
  params: FeishuMessageRequest
): Promise<FeishuMessageResponse['data']> {
  // receive_id_type must be a query parameter, not in the body
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${params.receive_id_type}`;
  const { receive_id_type: _, ...body } = params;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 网络层面的异常（DNS 失败、连接拒绝等）
    throw new FeishuError(
      99999,
      `网络请求失败：${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 尝试解析 JSON 响应体
  let data: FeishuMessageResponse;
  try {
    data = await response.json();
  } catch {
    // 响应体不是合法 JSON（可能 HTML 错误页等）
    throw new FeishuError(
      response.status,
      `HTTP ${response.status}：非 JSON 响应`,
      response.status
    );
  }

  // 飞书 API 业务错误（code !== 0）或 HTTP 状态码异常
  if (data.code !== 0) {
    throw new FeishuError(
      data.code,
      data.msg || '发送消息失败',
      response.status
    );
  }

  return data.data;
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                          */
/* ------------------------------------------------------------------ */

/**
 * 发送文本消息
 * @param receiveId 接收者 ID（open_id / user_id / chat_id / email）
 * @param receiveIdType 接收者 ID 类型
 * @param text 文本内容
 * @param tokenManager Token 管理器
 */
export async function sendTextMessage(
  receiveId: string,
  receiveIdType: FeishuMessageRequest['receive_id_type'],
  text: string,
  tokenManager: TokenManager
): Promise<FeishuMessageResponse['data']> {
  const token = await tokenManager.getToken();
  const content: FeishuTextContent = { text };

  return sendMessage(token, {
    receive_id: receiveId,
    receive_id_type: receiveIdType,
    msg_type: 'text',
    content: JSON.stringify(content),
  } as FeishuMessageRequest);
}

/**
 * 发送富文本消息
 * @param receiveId 接收者 ID
 * @param receiveIdType 接收者 ID 类型
 * @param postContent 富文本内容对象（支持多语言）
 * @param tokenManager Token 管理器
 *
 * @example
 * ```ts
 * sendPostMessage(openId, 'open_id', {
 *   zh_cn: {
 *     title: '任务完成通知',
 *     content: [
 *       [
 *         { tag: 'text', text: '您的任务已完成，详情请查看 ' },
 *         { tag: 'a', text: '这里', href: 'https://example.com' },
 *       ],
 *     ],
 *   },
 * }, tokenManager)
 * ```
 */
export async function sendPostMessage(
  receiveId: string,
  receiveIdType: FeishuMessageRequest['receive_id_type'],
  postContent: FeishuPostContent,
  tokenManager: TokenManager
): Promise<FeishuMessageResponse['data']> {
  const token = await tokenManager.getToken();

  return sendMessage(token, {
    receive_id: receiveId,
    receive_id_type: receiveIdType,
    msg_type: 'post',
    content: JSON.stringify(postContent),
  } as FeishuMessageRequest);
}

/**
 * 发送卡片消息（interactive）
 * @param receiveId 接收者 ID
 * @param receiveIdType 接收者 ID 类型
 * @param card 卡片消息内容对象
 * @param tokenManager Token 管理器
 *
 * @example
 * ```ts
 * sendCardMessage(chatId, 'chat_id', {
 *   config: { wide_screen_mode: true },
 *   header: {
 *     title: { tag: 'plain_text', content: '任务状态更新' },
 *     template: 'green',
 *   },
 *   elements: [
 *     { tag: 'markdown', content: '**Agent 任务完成**\n\n- 目标：分析代码质量\n- 结果：发现 3 处问题\n- 耗时：2.3s' },
 *     { tag: 'hr' },
 *     { tag: 'note', elements: [{ tag: 'plain_text', content: 'multi-agent TUI · 自动通知' }] },
 *   ],
 * }, tokenManager)
 * ```
 */
export async function sendCardMessage(
  receiveId: string,
  receiveIdType: FeishuMessageRequest['receive_id_type'],
  card: FeishuInteractiveContent,
  tokenManager: TokenManager
): Promise<FeishuMessageResponse['data']> {
  const token = await tokenManager.getToken();

  return sendMessage(token, {
    receive_id: receiveId,
    receive_id_type: receiveIdType,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  } as FeishuMessageRequest);
}

/* ------------------------------------------------------------------ */
/*  处理中 reaction 指示器                                              */
/* ------------------------------------------------------------------ */

/**
 * 在用户消息上添加 emoji reaction，表示 bot 正在处理。
 * 返回 reaction_id，用于后续删除。
 */
export async function addProcessingReaction(
  messageId: string,
  tokenManager: TokenManager,
  emojiType = 'THINKING'
): Promise<string | null> {
  try {
    const token = await tokenManager.getToken();
    const resp = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      }
    );
    const json = await resp.json() as { code: number; data?: { reaction_id: string } };
    if (json.code !== 0) return null;
    return json.data?.reaction_id ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  流式回复：卡片占位 + patch 更新                                      */
/* ------------------------------------------------------------------ */

/**
 * 将回复文本切成若干片段，供流式 patch 逐段展示。
 * 返回的每个元素是新增的文本块（调用方累加 acc += chunk）。
 */
export function splitForStreaming(text: string): string[] {
  if (!text.trim()) return [];

  // Split by paragraph breaks — these are always hard boundaries.
  // Each paragraph becomes at least one segment; long paragraphs (> 80 chars)
  // are further split by sentence-ending punctuation.
  const rawParagraphs = text.split(/(\n\n+)/);  // keep separators in array
  const segments: string[] = [];

  let i = 0;
  while (i < rawParagraphs.length) {
    const piece = rawParagraphs[i] ?? '';
    i++;
    // Skip separator-only pieces — they'll be prepended to the next paragraph segment
    if (/^\n+$/.test(piece)) continue;

    // Prepend any preceding separator (if any)
    const prevPiece = rawParagraphs[i - 2] ?? '';
    const sep = /^\n+$/.test(prevPiece) ? prevPiece : '';
    const para = piece.trim();
    if (!para) continue;

    if (para.length <= 80) {
      // Short paragraph → single segment
      segments.push((segments.length > 0 ? sep : '') + para);
    } else {
      // Long paragraph → split by sentences
      const parts = para.match(/[^。！？；.!?\n]+[。！？；.!?]?/g) ?? [para];
      let buf = segments.length > 0 ? sep : '';
      for (const part of parts) {
        buf += part;
        if (buf.replace(/^\n+/, '').length >= 40) {
          segments.push(buf);
          buf = '';
        }
      }
      if (buf.replace(/^\n+/, '').trim()) {
        if (segments.length > 0) { segments[segments.length - 1] += buf; }
        else { segments.push(buf); }
      }
    }
  }

  if (segments.length === 0) return [text];

  // Cap at 12 segments — merge adjacent ones if needed
  while (segments.length > 12) {
    const mid = Math.floor(segments.length / 2);
    segments.splice(mid, 2, (segments[mid] ?? '') + (segments[mid + 1] ?? ''));
  }
  return segments;
}

/**
 * 构建回复卡片内容。accumulated 是当前已显示的文本，done 表示全部输出完。
 */
export function buildAnswerCard(
  accumulated: string,
  done: boolean,
  elapsedMs?: number,
): FeishuInteractiveContent {
  const displayContent = !accumulated
    ? '⏳ 正在思考…'
    : accumulated + (done ? '' : ' ▋');

  const elements: FeishuCardElement[] = [{ tag: 'markdown', content: displayContent }];
  if (done && elapsedMs !== undefined) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `耗时 ${(elapsedMs / 1000).toFixed(1)}s` }],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: done ? '回复' : '回复中…' },
      template: done ? 'green' : 'blue',
    },
    elements,
  };
}

/**
 * 以文本消息回复一条指定消息（挂在原消息下）。
 * 用于 format=text 的气泡回复路径。
 * 返回新建回复的 message_id，失败返回 null。
 */
export async function replyToMessageWithText(
  messageId: string,
  text: string,
  tokenManager: TokenManager,
): Promise<string | null> {
  try {
    const token = await tokenManager.getToken();
    const resp = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      },
    );
    const json = await resp.json() as { code: number; data?: { message_id: string } };
    if (json.code !== 0) {
      feishuLog(`[replyToMessageWithText] code=${json.code}`);
      return null;
    }
    return json.data?.message_id ?? null;
  } catch (err) {
    feishuLog(`[replyToMessageWithText] error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 发送占位卡片（思考中），返回 message_id 供后续 patch。失败返回 null。
 */
export async function sendPlaceholderCard(
  receiveId: string,
  receiveIdType: 'open_id' | 'chat_id',
  tokenManager: TokenManager,
): Promise<string | null> {
  try {
    const data = await sendCardMessage(
      receiveId,
      receiveIdType as FeishuMessageRequest['receive_id_type'],
      buildAnswerCard('', false),
      tokenManager,
    );
    return data?.message_id ?? null;
  } catch {
    return null;
  }
}

/**
 * 更新已有卡片消息的内容（飞书 PATCH /im/v1/messages/{message_id}）。
 */
export async function patchCardMessage(
  messageId: string,
  card: FeishuInteractiveContent,
  tokenManager: TokenManager,
): Promise<void> {
  const token = await tokenManager.getToken();
  let resp: Response;
  try {
    resp = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ content: JSON.stringify(card) }),
      },
    );
  } catch (err) {
    throw new FeishuError(99999, `网络请求失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const json = await resp.json() as { code: number; msg?: string };
  if (json.code !== 0) {
    throw new FeishuError(json.code, json.msg ?? 'patch failed', resp.status);
  }
}

/**
 * 以卡片消息回复一条指定消息（挂在原消息下）。
 * 使用 Feishu reply API — 不产生独立新消息，而是作为该消息的回复可见。
 * 返回新建回复的 message_id，失败返回 null。
 */
export async function replyToMessageWithCard(
  messageId: string,
  card: FeishuInteractiveContent,
  tokenManager: TokenManager,
): Promise<string | null> {
  try {
    const token = await tokenManager.getToken();
    const resp = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          msg_type: 'interactive',
          content: JSON.stringify(card),
        }),
      },
    );
    const json = await resp.json() as { code: number; data?: { message_id: string } };
    if (json.code !== 0) {
      feishuLog(`[replyToMessageWithCard] code=${json.code}`);
      return null;
    }
    return json.data?.message_id ?? null;
  } catch (err) {
    feishuLog(`[replyToMessageWithCard] error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 删除之前加的 reaction，处理完成后调用。
 */
export async function deleteProcessingReaction(
  messageId: string,
  reactionId: string,
  tokenManager: TokenManager
): Promise<void> {
  try {
    const token = await tokenManager.getToken();
    await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
  } catch {
    // best-effort
  }
}
