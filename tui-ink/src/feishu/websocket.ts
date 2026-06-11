// Feishu WebSocket long-connection client
// Protocol: POST /callback/ws/endpoint first to get a dynamic auth URL, then connect
// Only handles im.message.receive_v1 events

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

const MAX_RECONNECT_ATTEMPTS = 5;
const BOOTSTRAP_URL = 'https://open.feishu.cn/callback/ws/endpoint';

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
    content: string;
    chat_type: string;
    chat_id: string;
    message_type: string;
  };
}

export interface FeishuWsOptions {
  appId: string;
  appSecret: string;
  /** Called for each incoming im.message.receive_v1 event */
  onMessage?: (openId: string, text: string, chatId: string, chatType: string, messageId: string) => void;
  /** Called with status updates so the TUI can display them */
  onStatus?: (msg: string) => void;
}

/**
 * Minimal protobuf parser — returns all length-delimited fields keyed by field number.
 * Feishu WS v2 Frame: field 8 = JSON event payload (confirmed empirically).
 */
function extractAllProtobufBytesFields(buf: Buffer): Record<number, Buffer> {
  const result: Record<number, Buffer> = {};
  let pos = 0;
  while (pos < buf.length) {
    let tag = 0, shift = 0;
    do {
      if (pos >= buf.length) return result;
      const b = buf[pos++]!;
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    } while (shift < 64);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      while (pos < buf.length && (buf[pos++]! & 0x80)) {}
    } else if (wireType === 1) { pos += 8;
    } else if (wireType === 5) { pos += 4;
    } else if (wireType === 2) {
      let len = 0; shift = 0;
      do {
        if (pos >= buf.length) return result;
        const b = buf[pos++]!;
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      } while (shift < 64);
      result[fieldNum] = buf.subarray(pos, pos + len);
      pos += len;
    } else { return result; }
  }
  return result;
}

async function fetchWsEndpoint(appId: string, appSecret: string): Promise<{ url: string; reconnectInterval: number }> {
  const resp = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'locale': 'zh' },
    body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
  });

  const json = await resp.json() as {
    code: number;
    msg: string;
    data?: { URL: string; ClientConfig?: { ReconnectInterval?: number } };
  };

  if (json.code !== 0) {
    throw new Error(`Feishu WS bootstrap failed: code=${json.code} msg=${json.msg}`);
  }

  return {
    url: json.data!.URL,
    reconnectInterval: json.data?.ClientConfig?.ReconnectInterval ?? 90,
  };
}

/**
 * Start the Feishu WebSocket long-connection client.
 *
 * Flow:
 * 1. POST /callback/ws/endpoint (PascalCase body) → dynamic WSS URL with auth ticket
 * 2. Connect to that URL (no separate login frame needed — auth is in the URL)
 * 3. Listen for im.message.receive_v1 events, call opts.onMessage
 *
 * Auto-reconnects up to MAX_RECONNECT_ATTEMPTS times with exponential back-off.
 * Each reconnect re-runs the bootstrap to get a fresh URL.
 */
export async function startFeishuWebSocket(opts: FeishuWsOptions): Promise<void> {
  const { appId, appSecret, onMessage, onStatus } = opts;

  const log = (msg: string) => {
    process.stderr.write(`[FeishuWS] ${msg}\n`);
    onStatus?.(msg);
  };

  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
                   process.env.http_proxy  || process.env.HTTP_PROXY;
  const wsOpts = proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {};
  if (proxyUrl) log(`using proxy ${proxyUrl}`);

  // Feishu uses at-least-once delivery — deduplicate by event_id
  const seenEventIds = new Set<string>();

  let reconnectAttempt = 0;

  const connect = async (): Promise<void> => {
    log('fetching connection URL...');

    let wsUrl: string;
    let reconnectInterval: number;
    try {
      ({ url: wsUrl, reconnectInterval } = await fetchWsEndpoint(appId, appSecret));
    } catch (err) {
      log(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect();
      return;
    }

    log('connecting...');
    const ws = new WebSocket(wsUrl, wsOpts);
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    ws.on('open', () => {
      log('connected');
      reconnectAttempt = 0;
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, reconnectInterval * 1000 * 0.8);
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        // Feishu WS v2 frames are protobuf-encoded.
        // Field 6 (Payload) contains the JSON event body.
        let jsonStr: string;
        if (Buffer.isBuffer(data)) {
          // Feishu WS v2 Frame: JSON event payload is in field 8 (not field 6).
          // Field 5 = headers (nested proto), field 8 = event JSON, field 9/11 = message IDs.
          const allFields = extractAllProtobufBytesFields(data);
          const payload = allFields[8];
          if (!payload || payload.length === 0) return; // ping/control frame
          jsonStr = payload.toString('utf-8');
        } else {
          jsonStr = data;
        }

        const frame = JSON.parse(jsonStr) as Record<string, unknown>;

        const header = frame['header'] as Record<string, unknown> | undefined;
        const eventType = header?.['event_type'] as string | undefined;
        if (eventType !== 'im.message.receive_v1') return;

        // Deduplicate: Feishu may deliver the same event multiple times
        const eventId = header?.['event_id'] as string | undefined;
        if (eventId) {
          if (seenEventIds.has(eventId)) { log(`dup event ${eventId.slice(-8)}, skipped`); return; }
          seenEventIds.add(eventId);
          if (seenEventIds.size > 500) {
            // Evict oldest entries to bound memory (Set preserves insertion order)
            const first = seenEventIds.values().next().value;
            if (first) seenEventIds.delete(first);
          }
        }

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

        const messageId = msgEvent.message?.message_id ?? '';
        log(`msg from=...${openId.slice(-6)} chat_type=${chatType} len=${text.length} msgId=${messageId.slice(-8)}`);
        onMessage?.(openId, text, chatId, chatType, messageId);
      } catch (err) {
        log(`message error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ws.on('error', (err: Error) => {
      log(`error: ${err.message}`);
    });

    ws.on('close', (code: number) => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      log(`closed (code=${code})`);
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      log('max reconnect attempts reached, giving up');
      return;
    }
    const delay = Math.pow(2, reconnectAttempt) * 1000;
    reconnectAttempt++;
    log(`reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(() => { connect(); }, delay);
  };

  await connect();
}
