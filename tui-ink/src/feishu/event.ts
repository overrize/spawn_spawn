// 飞书事件订阅验证模块
// 参考 SOP: E:\spawn-work\feishu-bot-sop.md
// 实现：URL 挑战验证、签名验证（HMAC-SHA256）

import { createHmac } from 'node:crypto';
import { FeishuUrlChallengeQuery, FeishuEventBody } from './types.js';

/**
 * 验证飞书 URL 挑战（用于首次配置回调地址）
 * 飞书发送 GET 请求，需返回 `{ "challenge": "xxx" }`
 *
 * @param challenge 飞书发送的 URL 挑战对象（包含 challenge、token、type）
 * @param expectedToken 你在飞书后台配置的 Verification Token
 * @returns 挑战值（应返回给飞书）
 * @throws 如果 type 不是 url_verification 或 token 不匹配则抛出错误
 */
export function verifyUrlChallenge(
  challenge: FeishuUrlChallengeQuery,
  expectedToken: string
): string {
  if (challenge.type !== 'url_verification') {
    throw new Error('不是有效的 URL 挑战请求');
  }

  if (challenge.token !== expectedToken) {
    throw new Error('Verification Token 不匹配');
  }

  return challenge.challenge;
}

/**
 * 验证飞书事件回调签名（HMAC-SHA256）
 * 防止伪造请求，生产环境必须验证。
 *
 * 签名算法：
 * 1. 拼接字符串：`timestamp + nonce + encrypt_key + JSON.stringify(body)`
 * 2. 使用 HMAC-SHA256 计算摘要（key 为 encrypt_key）
 * 3. 结果与 `X-Lark-Signature` 比对
 *
 * @param encryptKey 加解密密钥（在飞书后台事件回调页面获取）
 * @param timestamp Header 中的时间戳（X-Lark-Request-Timestamp）
 * @param nonce Header 中的随机字符串（X-Lark-Request-Nonce）
 * @param body 事件请求体（已解析为对象）
 * @param signature Header 中的签名值（X-Lark-Signature）
 * @returns 是否验证通过
 */
export function verifySignature(
  encryptKey: string,
  timestamp: string,
  nonce: string,
  body: object,
  signature: string
): boolean {
  const signStr = timestamp + nonce + encryptKey + JSON.stringify(body);
  const hmac = createHmac('sha256', encryptKey).update(signStr, 'utf-8').digest('hex');
  return hmac === signature;
}
