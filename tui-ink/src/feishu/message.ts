// 飞书消息发送模块
// 参考 SOP: E:\spawn-work\feishu-bot-sop.md
// 支持文本(text)、富文本(post)、卡片消息(interactive)

import {
  FeishuMessageRequest,
  FeishuMessageResponse,
  FeishuError,
  FeishuTextContent,
  FeishuPostContent,
  FeishuInteractiveContent,
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
  const url = 'https://open.feishu.cn/open-apis/im/v1/messages';

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(params),
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
