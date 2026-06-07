import { startFeishuWebSocket } from './src/feishu/websocket';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';

dotenv.config();

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('[TestWS] FEISHU_APP_ID or FEISHU_APP_SECRET missing in .env');
  process.exit(1);
}

console.log('[TestWS] Starting test...');
console.log('[TestWS] Credentials loaded (hidden)');

try {
  console.log('[TestWS] Calling startFeishuWebSocket()...');
  startFeishuWebSocket({
    appId: APP_ID,
    appSecret: APP_SECRET,
    onMessage: (openId, text) => {
      console.log(`[TestWS] Received message from ${openId}: ${text}`);
    },
  });
  console.log('[TestWS] startFeishuWebSocket() returned (connection likely dropped or ended).');
} catch (err) {
  console.error('[TestWS] Failed to start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Auto-exit after 15 seconds
setTimeout(() => {
  console.log('[TestWS] Test timeout reached (15s). Exiting.');
  process.exit(0);
}, 15000);
