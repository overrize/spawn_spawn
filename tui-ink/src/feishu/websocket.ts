// 飞书 WebSocket 长连接客户端
// 协议：先 POST /callback/ws/endpoint 获取动态 URL，再连接
// 只处理 im.message.receive_v1 事件

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

// 重连配置
const MAX_RECONNECT_ATTEMPTS = 5;

// Bootstrap endpoint (PascalCase body required)
const BOOTSTRAP_URL = 'https://open.feishu.cn/callback/ws/endpoint';

// im.message.receive_v1 事件结构
interface ImMessageReceiveV1 {
  sender: {
    sender_id: {
      open_id: string;
      union_id?: string;
      user_id?: string;
    };
  };
  message: {
    message_id: string;
    content: string; // JSON 字符串
    chat_type: string;
    chat_id: string;
    message_type: string;
  };
}

export interface FeishuWsOptions {
  appId: string;
  appSecret: string;
  /** Called for each incoming im.message.receive_v1 event */
  onMessage?: (openId: string, text: string, chatId: string, chatType: string) => void;
}

/**
 * 获取飞书 WebSocket 动态连接 URL
 */
async function fetchWsEndpoint(appId: string, appSecret: string): Promise<{ url: string; reconnectInterval: number }> {
  const resp = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'locale': 'zh' },
    body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
  });

  const json = await resp.json() as { code: number; msg: string; data?: { URL: string; ClientConfig?: { ReconnectInterval?: number } } };

  if (json.code !== 0) {
    throw new Error(`飞书 WebSocket bootstrap 失败: code=${json.code} msg=${json.msg}`);
  }

  return {
    url: json.data!.URL,
    reconnectInterval: json.data?.ClientConfig?.ReconnectInterval ?? 90,
  };
}

/**
 * 启动飞书 WebSocket 长连接客户端
 *
 * 协议：
 * 1. POST /callback/ws/endpoint 获取含认证参数的动态 WSS URL
 * 2. 连接到该 URL（URL 本身携带 ticket 等认证信息，无需额外 login 帧）
 * 3. 监听 im.message.receive_v1 事件，调用 opts.onMessage
 *
 * 自动重连，最多 MAX_RECONNECT_ATTEMPTS 次，每次重新 bootstrap 获取新 URL
 */
export async function startFeishuWebSocket(opts: FeishuWsOptions): Promise<void> {
  const { appId, appSecret, onMessage } = opts;

  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
                   process.env.http_proxy  || process.env.HTTP_PROXY;
  const wsOpts = proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {};

  let reconnectAttempt = 0;

  const connect = async (): Promise<void> => {
    process.stderr.write('[FeishuWS] 正在获取连接 URL...\n');

    let wsUrl: string;
    let reconnectInterval: number;
    try {
      ({ url: wsUrl, reconnectInterval } = await fetchWsEndpoint(appId, appSecret));
    } catch (err) {
      process.stderr.write(`[FeishuWS] bootstrap 失败: ${err instanceof Error ? err.message : String(err)}\n`);
      scheduleReconnect();
      return;
    }

    process.stderr.write('[FeishuWS] 正在连接...\n');
    const ws = new WebSocket(wsUrl, wsOpts);

    // Reconnect timer set by server's ReconnectInterval
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    ws.on('open', () => {
      process.stderr.write('[FeishuWS] 连接成功\n');
      reconnectAttempt = 0;
      // Keep-alive ping
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, reconnectInterval * 1000 * 0.8);
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const rawStr = typeof data === 'string' ? data : data.toString('utf-8');
        const frame = JSON.parse(rawStr) as Record<string, unknown>;

        // 飞书 WS 帧结构：frame.type / frame.header.event_type
        const header = frame['header'] as Record<string, unknown> | undefined;
        const eventType = header?.['event_type'] as string | undefined;

        if (eventType !== 'im.message.receive_v1') return;

        const event = frame['event'] as Record<string, unknown> | undefined;
        if (!event) return;

        const msgEvent = event as unknown as ImMessageReceiveV1;
        const openId = msgEvent.sender?.sender_id?.open_id;
        if (!openId) return;

        let text = '';
        try {
          const contentObj = JSON.parse(msgEvent.message?.content || '{}') as Record<string, unknown>;
          text = (contentObj['text'] as string) || '';
        } catch {
          text = msgEvent.message?.content || '';
        }

        const chatId = msgEvent.message?.chat_id || openId;
        const chatType = msgEvent.message?.chat_type || 'p2p';

        process.stderr.write(`[FeishuWS] 消息 from=${openId.slice(-6)} chat_type=${chatType}: ${text.slice(0, 60)}\n`);
        onMessage?.(openId, text, chatId, chatType);
      } catch (err) {
        process.stderr.write(`[FeishuWS] 消息处理异常: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });

    ws.on('error', (err: Error) => {
      process.stderr.write(`[FeishuWS] 连接错误: ${err.message}\n`);
    });

    ws.on('close', (code: number) => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      process.stderr.write(`[FeishuWS] 连接关闭 code=${code}\n`);
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      process.stderr.write('[FeishuWS] 已达最大重连次数，停止重连\n');
      return;
    }
    const delay = Math.pow(2, reconnectAttempt) * 1000;
    reconnectAttempt++;
    process.stderr.write(`[FeishuWS] ${delay / 1000}s 后尝试第 ${reconnectAttempt} 次重连...\n`);
    setTimeout(() => { connect(); }, delay);
  };

  await connect();
}
