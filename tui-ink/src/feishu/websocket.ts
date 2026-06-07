// 飞书 WebSocket 长连接客户端
// 连接 wss://wss-open.feishu.cn/ws/v2
// 只处理 im.message.receive_v1 事件

// 重连配置
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY = 1000; // 1s

// WebSocket 消息结构
interface WsEvent {
  type: string;
  data?: Record<string, unknown>;
}

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
    message_type: string;
  };
}

export interface FeishuWsOptions {
  appId: string;
  appSecret: string;
  /** Called for each incoming im.message.receive_v1 event */
  onMessage?: (openId: string, text: string) => void;
}

/**
 * 计算指数退避延迟（毫秒）
 * 1s → 2s → 4s → 8s → 16s
 */
function getReconnectDelay(attempt: number): number {
  return BASE_RECONNECT_DELAY * Math.pow(2, attempt);
}

/**
 * 启动飞书 WebSocket 长连接客户端
 * 连接 wss://wss-open.feishu.cn/ws/v2
 * 发送 login 帧后监听消息，只处理 im.message.receive_v1
 * 自动重连指数退避（1s-2s-4s-8s-16s），最多 5 次
 *
 * 收到消息时调用 opts.onMessage(openId, text)；
 * 调用方负责回复和路由。
 */
export async function startFeishuWebSocket(opts: FeishuWsOptions): Promise<void> {
  const { appId, appSecret, onMessage } = opts;

  let reconnectAttempt = 0;

  const connect = async (): Promise<void> => {
    const wsUrl = 'wss://wss-open.feishu.cn/ws/v2';

    console.log('[FeishuWS] 正在连接飞书 WebSocket...');

    const ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      console.log('[FeishuWS] 连接成功');
      reconnectAttempt = 0;

      // 飞书 WebSocket 协议要求 flat 格式，不能嵌套在 data 下
      const loginFrame = {
        type: 'login',
        app_id: appId,
        app_secret: appSecret,
      };

      console.log('[FeishuWS] 发送 login 帧（凭证已隐藏）');
      ws.send(JSON.stringify(loginFrame));
    };

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const rawData = typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
        const wsEvent: WsEvent = JSON.parse(rawData);

        if (wsEvent.type !== 'im.message.receive_v1') return;

        const eventData = wsEvent.data as Record<string, unknown>;

        // 从 header.event_type 确认事件类型
        const header = eventData['header'] as Record<string, unknown> | undefined;
        if (header && header['event_type'] !== 'im.message.receive_v1') return;

        const innerEvent = eventData['event'] as Record<string, unknown> | undefined;
        if (!innerEvent) {
          console.warn('[FeishuWS] 收到 im.message.receive_v1 但没有 event 字段');
          return;
        }

        const messageEvent = innerEvent as unknown as ImMessageReceiveV1;

        const openId = messageEvent.sender?.sender_id?.open_id;
        if (!openId) {
          console.warn('[FeishuWS] 消息事件缺少 sender.sender_id.open_id');
          return;
        }

        let text = '';
        try {
          const contentObj = JSON.parse(messageEvent.message?.content || '{}');
          text = contentObj.text || '';
        } catch {
          text = messageEvent.message?.content || '';
        }

        console.log(`[FeishuWS] 消息来自 ${openId.slice(-6)}: ${text.slice(0, 60)}`);
        onMessage?.(openId, text);
      } catch (err) {
        console.warn('[FeishuWS] 消息处理异常:', err instanceof Error ? err.message : String(err));
      }
    };

    ws.onerror = (_event: Event) => {
      console.warn('[FeishuWS] 连接错误');
    };

    ws.onclose = (event: CloseEvent) => {
      console.log(`[FeishuWS] 连接关闭 (code=${event.code})`);

      if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[FeishuWS] 已达最大重连次数（5次），停止重连');
        return;
      }

      const delay = getReconnectDelay(reconnectAttempt);
      reconnectAttempt++;
      console.log(`[FeishuWS] ${delay / 1000}s 后尝试第 ${reconnectAttempt} 次重连...`);

      setTimeout(() => { connect(); }, delay);
    };
  };

  await connect();
}
