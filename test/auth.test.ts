import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID, loadSession, pollForToken, saveSession, startDeviceLogin, validateToken, type DeviceCode,
} from '../src/auth.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mockFetch = (...responses: Response[]) => {
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => responses.shift()!);
  return { fn, http: fn as unknown as typeof fetch };
};
const tmp = () => mkdtempSync(join(tmpdir(), 'tdm-auth-'));

describe('device login', () => {
  it('requests a device code with our client id', async () => {
    const { fn, http } = mockFetch(json({
      device_code: 'dc', user_code: 'ABCDEFGH', interval: 5, expires_in: 1800,
      verification_uri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH',
    }));
    const code = await startDeviceLogin('dev', http);
    expect(code).toMatchObject({
      deviceCode: 'dc', userCode: 'ABCDEFGH', intervalSec: 5,
      verificationUri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH',
    });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('https://id.twitch.tv/oauth2/device');
    expect(new URLSearchParams(String(init!.body)).get('client_id')).toBe(CLIENT_ID);
    expect((init!.headers as Record<string, string>)['X-Device-Id']).toBe('dev');
  });

  it('polls until the user approves', async () => {
    const { http } = mockFetch(
      json({ status: 400, message: 'authorization_pending' }, 400),
      json({ access_token: 'tok', token_type: 'bearer' }),
    );
    const sleep = vi.fn(async (_ms: number) => {});
    const code: DeviceCode = {
      deviceCode: 'dc', userCode: 'X', verificationUri: 'u', intervalSec: 5, expiresAt: Date.now() + 60_000,
    };
    await expect(pollForToken(code, 'dev', http, sleep)).resolves.toBe('tok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 5000]);
  });

  it('gives up when the code expires', async () => {
    const { http } = mockFetch();
    const code: DeviceCode = {
      deviceCode: 'dc', userCode: 'X', verificationUri: 'u', intervalSec: 5, expiresAt: Date.now() - 1,
    };
    await expect(pollForToken(code, 'dev', http, async () => {})).rejects.toThrow(/expired/);
  });
});

describe('validateToken', () => {
  it('returns the user for a valid token from our client', async () => {
    const { fn, http } = mockFetch(json({ client_id: CLIENT_ID, login: 'me', user_id: '123' }));
    await expect(validateToken('tok', http)).resolves.toEqual({ userId: '123', login: 'me' });
    expect((fn.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('OAuth tok');
  });

  it('returns null for an invalid token', async () => {
    const { http } = mockFetch(json({ status: 401, message: 'invalid access token' }, 401));
    await expect(validateToken('tok', http)).resolves.toBeNull();
  });

  it('returns null for a token issued to another client', async () => {
    const { http } = mockFetch(json({ client_id: 'other', login: 'me', user_id: '123' }));
    await expect(validateToken('tok', http)).resolves.toBeNull();
  });
});

describe('session storage', () => {
  it('round-trips a session', () => {
    const dir = tmp();
    const session = { token: 'tok', userId: '123', login: 'me', deviceId: 'dev' };
    saveSession(session, dir);
    expect(loadSession(dir)).toEqual(session);
  });

  it('returns null when auth.json is missing, corrupt or incomplete', () => {
    const dir = tmp();
    expect(loadSession(dir)).toBeNull();
    writeFileSync(join(dir, 'auth.json'), 'garbage');
    expect(loadSession(dir)).toBeNull();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ token: 'tok' }));
    expect(loadSession(dir)).toBeNull();
  });
});
