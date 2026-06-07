// Feishu Tenant Access Token management
// ESM module — import with .js extension

import dotenv from 'dotenv';
import { FeishuError, type FeishuTokenResponse } from './types.js';

dotenv.config();

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------

/** Tenant Access Token API endpoint */
const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

/** Default token expiry in seconds (2 hours) — used when API response omits `expire` */
const DEFAULT_EXPIRE_SEC = 7200;

/** Refresh token when remaining TTL < this threshold (5 minutes) */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// -----------------------------------------------------------------------
// TokenManager — in-memory cached token with auto-refresh
// -----------------------------------------------------------------------

export class TokenManager {
  private appId: string;
  private appSecret: string;

  private token: string | null = null;
  private expiresAt: number = 0; // absolute timestamp (ms) when token expires
  private refreshPromise: Promise<string> | null = null; // guard against concurrent refresh

  constructor() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error(
        'Missing Feishu credentials: FEISHU_APP_ID and FEISHU_APP_SECRET must be set in environment or .env file.'
      );
    }

    this.appId = appId;
    this.appSecret = appSecret;
  }

  /**
   * Get a valid tenant access token.
   * - Returns cached token if it is still valid and not about to expire.
   * - Fetches a new token if cache is empty or will expire within REFRESH_THRESHOLD_MS.
   */
  async getToken(): Promise<string> {
    // If a refresh is already in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Check if cached token is still fresh enough
    if (this.token && Date.now() < this.expiresAt - REFRESH_THRESHOLD_MS) {
      return this.token;
    }

    // Need to fetch (or refresh)
    return this.fetchToken();
  }

  /** Force refresh — even if token still valid */
  async refreshToken(): Promise<string> {
    // Cancel any in-flight refresh by waiting it first?
    // Simpler: just call fetchToken which also uses refreshPromise guard.
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    return this.fetchToken();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async fetchToken(): Promise<string> {
    // Deduplicate concurrent calls: if a fetch is already in flight, join it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doFetchToken().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async doFetchToken(): Promise<string> {
    const body = JSON.stringify({
      app_id: this.appId,
      app_secret: this.appSecret,
    });

    let response: Response;

    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body,
      });
    } catch (err) {
      // Network or fetch-level error
      throw new FeishuError(
        -1,
        `Failed to reach Feishu token endpoint: ${(err as Error).message}`,
        0
      );
    }

    // Parse JSON body
    let data: FeishuTokenResponse;

    try {
      data = (await response.json()) as FeishuTokenResponse;
    } catch {
      throw new FeishuError(
        -1,
        `Invalid JSON response from token endpoint (HTTP ${response.status})`,
        response.status
      );
    }

    // Check for API-level error
    if (data.code !== 0) {
      throw FeishuError.fromApiResponse(
        { code: data.code, msg: data.msg || 'Unknown Feishu API error' },
        response.status
      );
    }

    // Determine token and expiry
    const token = data.tenant_access_token;
    const expireSec = data.expire ?? DEFAULT_EXPIRE_SEC;

    if (!token) {
      throw new FeishuError(
        -1,
        'Token response missing tenant_access_token field',
        response.status
      );
    }

    // Cache
    this.token = token;
    this.expiresAt = Date.now() + expireSec * 1000;

    return token;
  }
}

// -----------------------------------------------------------------------
// Singleton convenience function
// -----------------------------------------------------------------------

let singletonManager: TokenManager | null = null;

/**
 * Get a tenant access token (singleton convenience).
 * Creates a TokenManager on first call; reuses it thereafter.
 */
export async function getTenantAccessToken(): Promise<string> {
  if (!singletonManager) {
    singletonManager = new TokenManager();
  }
  return singletonManager.getToken();
}
