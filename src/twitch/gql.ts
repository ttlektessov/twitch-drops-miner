import { randomBytes } from 'node:crypto';
import { AuthError, GqlOperationError, NetworkError } from './errors.js';

export type PersistedOp = {
  operationName: string;
  variables?: Record<string, unknown>;
  extensions: { persistedQuery: { version: 1; sha256Hash: string } };
};

export interface GqlRequester {
  request(ops: PersistedOp | PersistedOp[]): Promise<any>;
}

export type GqlOptions = {
  token: string;
  clientId: string;
  deviceId: string;
  userAgent: string;
  /** Origin/Referer the Twitch client normally sends; defaults to the web site. */
  clientUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
};

const GQL_URL = 'https://gql.twitch.tv/gql';
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

// Messages Twitch returns for hiccups that succeed on retry.
const TRANSIENT = new Set([
  'service error',
  'service timeout',
  'service unavailable',
  'context deadline exceeded',
  'request cancelled',
]);

export function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

export class GqlClient implements GqlRequester {
  private readonly sessionId = randomHex(16);

  constructor(private readonly opts: GqlOptions) {}

  async request(ops: PersistedOp | PersistedOp[]): Promise<any> {
    const http = this.opts.fetch ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const delays = this.opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const names = (Array.isArray(ops) ? ops : [ops]).map((o) => o.operationName).join(', ');
    let problem = 'unknown error';

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1]);
      let res: Response;
      try {
        res = await http(GQL_URL, { method: 'POST', headers: this.headers(), body: JSON.stringify(ops) });
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (res.status === 401) throw new AuthError();
      if (res.status >= 500) {
        problem = `HTTP ${res.status}`;
        continue;
      }
      let body: any;
      try {
        body = await res.json();
      } catch {
        problem = `HTTP ${res.status} with a non-JSON body`;
        continue;
      }
      const retryReason = this.check(Array.isArray(body) ? body : [body], names, attempt);
      if (retryReason) {
        problem = retryReason;
        continue;
      }
      return body;
    }
    throw new NetworkError(`${names}: ${problem}`);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'Accept-Language': 'en-US',
      Authorization: `OAuth ${this.opts.token}`,
      'Client-Id': this.opts.clientId,
      'Client-Session-Id': this.sessionId,
      'X-Device-Id': this.opts.deviceId,
      'User-Agent': this.opts.userAgent,
      Origin: this.opts.clientUrl ?? 'https://www.twitch.tv',
      Referer: `${this.opts.clientUrl ?? 'https://www.twitch.tv'}/`,
    };
  }

  /** Throws on fatal errors, returns a reason when the request should be retried, null when OK. */
  private check(items: any[], names: string, attempt: number): string | null {
    for (const item of items) {
      const operation: string = item?.extensions?.operationName ?? names;
      if (item?.error) {
        if (item.status === 401) throw new AuthError();
        throw new GqlOperationError(operation, `${item.error}: ${item.message ?? ''}`);
      }
      for (const e of item?.errors ?? []) {
        const message = String(e?.message ?? 'unknown error');
        if (TRANSIENT.has(message)) return message;
        if (message === 'PersistedQueryNotFound' && attempt === 0) return message;
        if (message === 'server error') continue; // partial data; parse.ts tolerates nulls
        throw new GqlOperationError(operation, message);
      }
    }
    return null;
  }
}
