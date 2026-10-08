import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miner, type Intervals, type LogEntry } from '../src/miner.js';
import { AuthError, GqlOperationError, NetworkError } from '../src/twitch/errors.js';
import type { Campaign, LiveChannel, TwitchClient, Watcher, WatchTarget } from '../src/twitch/types.js';
import { makeCampaign, makeChannel, makeDrop, NOW, PRIORITY } from './helpers.js';

class FakeApi implements TwitchClient {
  campaigns: Campaign[] = [];
  channels: Record<string, LiveChannel[]> = {};
  offline = new Set<string>();
  claims: string[] = [];
  error: Error | null = null;
  getCampaignsCalls = 0;

  async getCampaigns(gameIds?: string[]) {
    this.getCampaignsCalls++;
    if (this.error) throw this.error;
    return structuredClone(this.campaigns.filter((c) => !gameIds || gameIds.includes(c.game.id)));
  }
  async getLiveChannels(c: Campaign) {
    if (this.error) throw this.error;
    return structuredClone((this.channels[c.id] ?? []).filter((ch) => !this.offline.has(ch.login)));
  }
  async getStreamInfo(login: string) {
    if (this.error) throw this.error;
    if (this.offline.has(login)) return null;
    return Object.values(this.channels).flat().find((ch) => ch.login === login) ?? null;
  }
  async claimDrop(id: string) {
    this.claims.push(id);
    for (const c of this.campaigns) for (const d of c.drops) if (d.claimId === id) d.claimed = true;
    return true;
  }
}

class FakeWatcher implements Watcher {
  watched: string[] = [];
  async watch(t: WatchTarget) {
    this.watched.push(t.login);
    return { beacon: true, stream: null };
  }
  reset() {}
}

function setup(intervals: Partial<Intervals> = {}) {
  const api = new FakeApi();
  const watcher = new FakeWatcher();
  const logs: LogEntry[] = [];
  const miner = new Miner({ api, watcher, user: 'me', getPriority: () => PRIORITY, intervals, onLog: (e) => logs.push(e) });
  return { api, watcher, miner, logs };
}

const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('Miner', () => {
  it('mines the highest-priority game on its most-watched channel', async () => {
    const { api, watcher, miner } = setup();
    const one = makeCampaign();
    const two = makeCampaign({ gameId: 'g2', gameName: 'Game Two' });
    api.campaigns = [two, one];
    api.channels = {
      [one.id]: [makeChannel({ login: 'small', viewers: 5 }), makeChannel({ login: 'big', viewers: 900 })],
      [two.id]: [makeChannel({ gameId: 'g2' })],
    };
    miner.start();
    await run(0);
    const state = miner.getState();
    expect(state.status).toBe('mining');
    expect(state.target?.game).toBe('Game One');
    expect(state.target?.channel.login).toBe('big');
    expect(watcher.watched).toEqual(['big']);
    expect(state.queue).toEqual([
      { position: 2, game: 'Game Two', state: 'ready', detail: '1 campaign · 1 drop left' },
      { position: 3, game: 'Game Three', state: 'no_campaign' },
    ]);
    miner.stop();
  });

  it('falls through to the next game when no channel is live', async () => {
    const { api, miner } = setup();
    const one = makeCampaign();
    const two = makeCampaign({ gameId: 'g2', gameName: 'Game Two' });
    api.campaigns = [one, two];
    api.channels = { [two.id]: [makeChannel({ gameId: 'g2', login: 'two' })] };
    miner.start();
    await run(0);
    expect(miner.getState().target?.channel.login).toBe('two');
    miner.stop();
  });

  it('idles when nothing is eligible and re-checks every 5 minutes', async () => {
    const { api, miner } = setup();
    api.campaigns = [makeCampaign({ linked: false })];
    miner.start();
    await run(0);
    const state = miner.getState();
    expect(state.status).toBe('idle');
    expect(state.nextCheckAt).toEqual(new Date(NOW.getTime() + 300_000));
    expect(state.queue[0]).toEqual({ position: 1, game: 'Game One', state: 'not_linked', detail: 'https://link/g1' });
    expect(api.getCampaignsCalls).toBe(1);
    await run(240_000);
    expect(api.getCampaignsCalls).toBe(1);
    await run(60_000);
    expect(api.getCampaignsCalls).toBe(2);
    miner.stop();
  });

  it('switches channel when the stream goes offline', async () => {
    const { api, miner, logs } = setup();
    const one = makeCampaign();
    const a = makeChannel({ login: 'a', viewers: 900 });
    const b = makeChannel({ login: 'b', viewers: 100 });
    api.campaigns = [one];
    api.channels = { [one.id]: [a, b] };
    miner.start();
    await run(0);
    api.offline.add('a');
    await run(180_000);
    expect(miner.getState().target?.channel.login).toBe('b');
    expect(logs.some((l) => l.kind === 'switch' && l.message.includes('stream went offline'))).toBe(true);
    miner.stop();
  });

  it('switches channel when progress stalls for two checks', async () => {
    const { api, miner, logs } = setup();
    const one = makeCampaign({ drops: [makeDrop({ currentMinutes: 10 })] });
    api.campaigns = [one];
    api.channels = { [one.id]: [makeChannel({ login: 'a', viewers: 900 }), makeChannel({ login: 'b', viewers: 100 })] };
    miner.start();
    await run(0);
    await run(180_000);
    expect(miner.getState().target?.channel.login).toBe('a');
    await run(180_000);
    expect(miner.getState().target?.channel.login).toBe('b');
    expect(logs.some((l) => l.message.includes('no progress'))).toBe(true);
    miner.stop();
  });

  it('switches to a higher-priority game at the 15-minute re-check', async () => {
    const { api, miner, logs } = setup({ stallChecks: 99 });
    const two = makeCampaign({ gameId: 'g2', gameName: 'Game Two' });
    api.campaigns = [two];
    api.channels = { [two.id]: [makeChannel({ gameId: 'g2', login: 'two' })] };
    miner.start();
    await run(0);
    expect(miner.getState().target?.game).toBe('Game Two');
    const one = makeCampaign();
    api.campaigns.push(one);
    api.channels[one.id] = [makeChannel({ login: 'one' })];
    await run(840_000);
    expect(miner.getState().target?.game).toBe('Game Two');
    await run(60_000);
    expect(miner.getState().target?.game).toBe('Game One');
    expect(logs.some((l) => l.kind === 'switch' && l.message.includes('higher-priority'))).toBe(true);
    miner.stop();
  });

  it('estimates progress between checks and claims finished drops', async () => {
    const { api, miner, logs } = setup({ stallChecks: 99 });
    const first = makeDrop({ benefitNames: ['Hoodie'], requiredMinutes: 60, currentMinutes: 58, claimId: 'claim-1' });
    const second = makeDrop({ benefitNames: ['Door Skin'], requiredMinutes: 120 });
    const one = makeCampaign({ drops: [first, second] });
    api.campaigns = [one];
    api.channels = { [one.id]: [makeChannel({ login: 'a' })] };
    miner.start();
    await run(0);
    expect(miner.getState().target?.drop).toEqual({ name: 'Hoodie', current: 58, required: 60 });
    expect(miner.getState().target?.remainingDrops).toEqual([{ name: 'Door Skin', required: 120 }]);
    await run(60_000);
    expect(miner.getState().target?.drop?.current).toBe(59);
    api.campaigns[0].drops[0].currentMinutes = 60;
    await run(120_000);
    expect(api.claims).toEqual(['claim-1']);
    expect(logs.some((l) => l.kind === 'claim' && l.message.includes('Hoodie'))).toBe(true);
    expect(miner.getState().status).toBe('mining');
    expect(miner.getState().target?.drop?.name).toBe('Door Skin');
    miner.stop();
  });

  it('stops and asks for login on AuthError', async () => {
    const { api, miner } = setup();
    api.error = new AuthError();
    miner.start();
    await run(0);
    expect(miner.getState().status).toBe('login_required');
    await run(600_000);
    expect(api.getCampaignsCalls).toBe(1);
  });

  it('goes idle on a changed Twitch API and recovers later', async () => {
    const { api, miner } = setup();
    api.error = new GqlOperationError('Inventory', 'PersistedQueryNotFound');
    miner.start();
    await run(0);
    expect(miner.getState().status).toBe('error');
    expect(miner.getState().error).toContain('Twitch API changed: Inventory');
    api.error = null;
    const one = makeCampaign();
    api.campaigns = [one];
    api.channels = { [one.id]: [makeChannel()] };
    await run(300_000);
    expect(miner.getState().status).toBe('mining');
    miner.stop();
  });

  it('keeps its target through network errors and retries after 5 minutes', async () => {
    const { api, miner } = setup({ stallChecks: 99 });
    const one = makeCampaign();
    api.campaigns = [one];
    api.channels = { [one.id]: [makeChannel({ login: 'a' })] };
    miner.start();
    await run(0);
    api.error = new NetworkError('Inventory: ECONNRESET');
    await run(180_000);
    expect(miner.getState().status).toBe('error');
    expect(miner.getState().target?.channel.login).toBe('a');
    api.error = null;
    await run(300_000);
    expect(miner.getState().status).toBe('mining');
    miner.stop();
  });
});
