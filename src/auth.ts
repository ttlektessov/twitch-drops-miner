import { join } from 'node:path';
import { dataDir, readJson, writeJson } from './config.js';

// Twitch Android TV ("SmartBox") client. The device-code login and every GQL call must use the same ID.
// Twitch stopped accepting the Android app client for device login around 2026-09-18.
export const CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';
export const CLIENT_URL = 'https://android.tv.twitch.tv';
export const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 7.1; Smart Box C1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export type Session = { token: string; userId: string; login: string; deviceId: string };

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  expiresAt: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function idHeaders(deviceId: string): Record<string, string> {
  return {
    'Client-Id': CLIENT_ID,
    'User-Agent': USER_AGENT,
    'X-Device-Id': deviceId,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: CLIENT_URL,
    Referer: `${CLIENT_URL}/`,
  };
}

export async function startDeviceLogin(deviceId: string, http: typeof fetch = fetch): Promise<DeviceCode> {
  const res = await http('https://id.twitch.tv/oauth2/device', {
    method: 'POST',
    headers: idHeaders(deviceId),
    body: new URLSearchParams({ client_id: CLIENT_ID, scopes: '' }).toString(),
  });
  if (!res.ok) throw new Error(`Twitch login could not start (HTTP ${res.status})`);
  const body = await res.json();
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    intervalSec: body.interval,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

export async function pollForToken(
  code: DeviceCode,
  deviceId: string,
  http: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<string> {
  while (Date.now() < code.expiresAt) {
    await sleep(code.intervalSec * 1000);
    const res = await http('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: idHeaders(deviceId),
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    // 400 means the user hasn't entered the code yet.
    if (res.status === 200) return (await res.json()).access_token;
  }
  throw new Error('The login code expired. Run `drops login` again.');
}

export async function validateToken(
  token: string,
  http: typeof fetch = fetch,
): Promise<{ userId: string; login: string } | null> {
  const res = await http('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not check the Twitch login (HTTP ${res.status})`);
  const body = await res.json();
  if (body.client_id !== CLIENT_ID) return null;
  return { userId: String(body.user_id), login: body.login };
}

export function loadSession(dir = dataDir()): Session | null {
  const raw = readJson<Partial<Session>>(join(dir, 'auth.json'));
  if (!raw) return null;
  const { token, userId, login, deviceId } = raw;
  if ([token, userId, login, deviceId].some((v) => typeof v !== 'string' || v === '')) return null;
  return { token, userId, login, deviceId } as Session;
}

export function saveSession(session: Session, dir = dataDir()): void {
  writeJson(join(dir, 'auth.json'), session);
}
