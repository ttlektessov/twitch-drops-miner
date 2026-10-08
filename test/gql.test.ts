import { describe, expect, it, vi } from 'vitest';
import { AuthError, GqlOperationError, NetworkError } from '../src/twitch/errors.js';
import { GqlClient, randomHex, type PersistedOp } from '../src/twitch/gql.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const op: PersistedOp = {
  operationName: 'Inventory',
  extensions: { persistedQuery: { version: 1, sha256Hash: 'hash' } },
};

function setup(responses: Array<Response | Error>) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const gql = new GqlClient({
    token: 'tok', clientId: 'cid', deviceId: 'dev', userAgent: 'ua',
    fetch: fetch as unknown as typeof globalThis.fetch, sleep,
  });
  return { gql, fetch, sleep };
}

describe('GqlClient', () => {
  it('posts the operation with auth headers and returns the body', async () => {
    const { gql, fetch } = setup([json({ data: { ok: 1 } })]);
    await expect(gql.request(op)).resolves.toEqual({ data: { ok: 1 } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://gql.twitch.tv/gql');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('OAuth tok');
    expect(headers['Client-Id']).toBe('cid');
    expect(headers['X-Device-Id']).toBe('dev');
    expect(headers['User-Agent']).toBe('ua');
    expect(JSON.parse(init!.body as string)).toEqual(op);
  });

  it('returns batched responses as an array', async () => {
    const { gql } = setup([json([{ data: { a: 1 } }, { data: { b: 2 } }])]);
    await expect(gql.request([op, op])).resolves.toEqual([{ data: { a: 1 } }, { data: { b: 2 } }]);
  });

  it('throws AuthError on HTTP 401', async () => {
    const { gql } = setup([json({ error: 'Unauthorized', status: 401, message: 'bad token' }, 401)]);
    await expect(gql.request(op)).rejects.toBeInstanceOf(AuthError);
  });

  it('retries network failures and 5xx with backoff', async () => {
    const { gql, sleep } = setup([new Error('ECONNRESET'), json({}, 503), json({ data: { ok: 1 } })]);
    await expect(gql.request(op)).resolves.toEqual({ data: { ok: 1 } });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 15000]);
  });

  it('gives up with NetworkError after all retries', async () => {
    const { gql, sleep } = setup([new Error('a'), new Error('b'), new Error('c'), new Error('d')]);
    await expect(gql.request(op)).rejects.toBeInstanceOf(NetworkError);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('retries transient GQL errors', async () => {
    const { gql } = setup([json({ errors: [{ message: 'service timeout' }] }), json({ data: { ok: 1 } })]);
    await expect(gql.request(op)).resolves.toEqual({ data: { ok: 1 } });
  });

  it('retries PersistedQueryNotFound once, then reports the operation as changed', async () => {
    const notFound = () => json({
      errors: [{ message: 'PersistedQueryNotFound' }], extensions: { operationName: 'Inventory' },
    });
    const { gql, sleep } = setup([notFound(), notFound()]);
    const error = await gql.request(op).catch((e) => e);
    expect(error).toBeInstanceOf(GqlOperationError);
    expect(error.operation).toBe('Inventory');
    expect(error.message).toContain('Twitch API changed: Inventory');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('turns other error bodies into GqlOperationError', async () => {
    const { gql } = setup([json({ error: 'Bad Request', status: 400, message: 'nope' }, 400)]);
    await expect(gql.request(op)).rejects.toBeInstanceOf(GqlOperationError);
  });

  it('tolerates partial "server error" responses', async () => {
    const { gql } = setup([json({ data: { x: null }, errors: [{ message: 'server error', path: ['x'] }] })]);
    await expect(gql.request(op)).resolves.toEqual({
      data: { x: null }, errors: [{ message: 'server error', path: ['x'] }],
    });
  });
});

describe('randomHex', () => {
  it('returns lowercase hex of the requested length', () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(15)).toMatch(/^[0-9a-f]{15}$/);
  });
});
