import { z } from "zod";
import type { ProviderApiFetch } from "./provider.js";
import { ApiNumberSchema, fetchProviderApi } from "./usage.js";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

const OAuthTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: ApiNumberSchema.optional(),
});

export interface RefreshedOAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

export async function refreshXaiOAuthToken(
  fetchApi: ProviderApiFetch,
  refreshToken: string,
): Promise<RefreshedOAuthToken | null> {
  const trimmed = refreshToken.trim();
  if (!trimmed) return null;

  try {
    const res = await fetchProviderApi(fetchApi, XAI_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: XAI_OAUTH_CLIENT_ID,
        refresh_token: trimmed,
      }).toString(),
    });

    if (!res.ok) return null;
    const data = OAuthTokenResponseSchema.parse(await res.json());
    const expiresInSec = data.expires_in ?? 3600;
    const expiresAtMs = Date.now() + Math.max(0, expiresInSec) * 1000 - 60_000;
    return {
      accessToken: data.access_token.trim(),
      refreshToken: data.refresh_token?.trim() || trimmed,
      expiresAtMs,
    };
  } catch {
    return null;
  }
}

export async function refreshCodexOAuthToken(
  fetchApi: ProviderApiFetch,
  refreshToken: string,
): Promise<RefreshedOAuthToken | null> {
  const trimmed = refreshToken.trim();
  if (!trimmed) return null;

  try {
    const res = await fetchProviderApi(fetchApi, CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CODEX_CLIENT_ID,
        refresh_token: trimmed,
      }).toString(),
    });

    if (!res.ok) return null;
    const data = OAuthTokenResponseSchema.parse(await res.json());
    const expiresInSec = data.expires_in ?? 3600;
    const expiresAtMs = Date.now() + Math.max(0, expiresInSec) * 1000 - 60_000;
    return {
      accessToken: data.access_token.trim(),
      refreshToken: data.refresh_token?.trim() || trimmed,
      expiresAtMs,
    };
  } catch {
    return null;
  }
}

export async function refreshClaudeOAuthToken(
  fetchApi: ProviderApiFetch,
  refreshToken: string,
): Promise<RefreshedOAuthToken | null> {
  const trimmed = refreshToken.trim();
  if (!trimmed) return null;

  try {
    const res = await fetchProviderApi(fetchApi, CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: trimmed,
        client_id: CLAUDE_CLIENT_ID,
        scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers",
      }),
    });

    if (!res.ok) return null;
    const data = OAuthTokenResponseSchema.parse(await res.json());
    const expiresInSec = data.expires_in ?? 3600;
    const expiresAtMs = Date.now() + Math.max(0, expiresInSec) * 1000 - 60_000;
    return {
      accessToken: data.access_token.trim(),
      refreshToken: data.refresh_token?.trim() || trimmed,
      expiresAtMs,
    };
  } catch {
    return null;
  }
}
