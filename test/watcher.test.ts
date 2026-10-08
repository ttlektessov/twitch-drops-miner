import { describe, expect, it, vi } from 'vitest';
import type { PersistedOp } from '../src/twitch/gql.js';
import type { WatchTarget } from '../src/twitch/types.js';
import { buildSpadeBody, lastMediaLine, TwitchWatcher, usherUrl } from '../src/twitch/watcher.js';

const target: WatchTarget = {
  channelId: '135377687', login: 'posty', broadcastId: '317066421972', gameId: '263490', gameName: 'Rust',
};

function routes(map: Record<string, () => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(map).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected request ${url}`);
    return map[key]();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const spadeRoutes = {
  'https://www.twitch.tv/posty': () =>
    new Response('<script src="https://assets.twitch.tv/config/settings.0123456789abcdef0123456789abcdef.js"></script>'),
  'https://assets.twitch.tv/config/settings.': () => new Response('{"spade_url":"https://spade.example/track"}'),
  'https://spade.example/track': () => new Response(null, { status: 204 }),
};

const noGql = { request: async () => { throw new Error('gql not expected'); } };

describe('buildSpadeBody', () => {
  it('encodes a minute-watched event as base64 form data', () => {
    const data = new URLSearchParams(buildSpadeBody(target, '42')).get('data')!;
    const [event] = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    expect(event.event).toBe('minute-watched');
    expect(event.properties).toMatchObject({
      broadcast_id: '317066421972', channel_id: '135377687', channel: 'posty',
      game: 'Rust', game_id: '263490', user_id: 42, minutes_logged: 1, live: true, logged_in: true,
    });
  });
});

describe('usherUrl', () => {
  it('URL-encodes the JSON playback token', () => {
    const token = '{"channel":"posty","expires":1 }';
    const url = usherUrl('posty', 'sig123', token);
    expect(url.startsWith('https://usher.ttvnw.net/api/channel/hls/posty.m3u8?')).toBe(true);
    expect(url).not.toContain('"');
    expect(new URL(url).searchParams.get('token')).toBe(token);
    expect(new URL(url).searchParams.get('sig')).toBe('sig123');
  });
});

describe('lastMediaLine', () => {
  it('returns the last non-comment line', () => {
    expect(lastMediaLine('#EXTM3U\n#EXTINF:2,\nhttps://a/1.ts\n#EXTINF:2,\nhttps://a/2.ts\n')).toBe('https://a/2.ts');
    expect(lastMediaLine('#EXTM3U\n')).toBeNull();
  });
});

describe('TwitchWatcher', () => {
  it('finds the spade URL once and sends the beacon', async () => {
    const { fetch, calls } = routes(spadeRoutes);
    const watcher = new TwitchWatcher({ userId: '42', gql: noGql, userAgent: 'ua', fetchStream: () => false, fetch });
    await expect(watcher.watch(target)).resolves.toEqual({ beacon: true, stream: null });
    await watcher.watch(target);
    expect(calls.filter((c) => c.url.startsWith('https://www.twitch.tv/')).length).toBe(1);
    const posts = calls.filter((c) => c.url === 'https://spade.example/track');
    expect(posts).toHaveLength(2);
    expect(posts[0].init!.method).toBe('POST');
    expect((posts[0].init!.headers as Record<string, string>)['User-Agent']).toBe('ua');
  });

  it('reports a failed beacon without throwing', async () => {
    const { fetch } = routes({ ...spadeRoutes, 'https://spade.example/track': () => new Response('no', { status: 400 }) });
    const watcher = new TwitchWatcher({ userId: '42', gql: noGql, userAgent: 'ua', fetchStream: () => false, fetch });
    await expect(watcher.watch(target)).resolves.toEqual({ beacon: false, stream: null });
  });

  it('HEADs every segment of the lowest-quality stream once', async () => {
    let playlist = '#EXTM3U\n#EXTINF:2.0,\nhttps://video.example/seg1.ts\n#EXTINF:2.0,\nhttps://video.example/seg2.ts\n';
    const { fetch, calls } = routes({
      ...spadeRoutes,
      'https://usher.ttvnw.net/': () => new Response(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000\nhttps://video.example/720p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nhttps://video.example/160p.m3u8\n'),
      'https://video.example/160p.m3u8': () => new Response(playlist),
      'https://video.example/seg': () => new Response(null, { status: 200 }),
    });
    const gqlCalls: PersistedOp[] = [];
    const gql = {
      request: async (o: PersistedOp | PersistedOp[]) => {
        gqlCalls.push(o as PersistedOp);
        return { data: { streamPlaybackAccessToken: { value: '{"channel":"posty"}', signature: 'sig123' } } };
      },
    };
    const heads = () => calls.filter((c) => c.init?.method === 'HEAD').map((c) => c.url.slice(-8));
    const watcher = new TwitchWatcher({ userId: '42', gql, userAgent: 'ua', fetchStream: () => true, fetch });
    await expect(watcher.watch(target)).resolves.toEqual({ beacon: true, stream: true });
    expect(gqlCalls[0].operationName).toBe('PlaybackAccessToken');
    expect(heads()).toEqual(['/seg1.ts', '/seg2.ts']);

    playlist = '#EXTM3U\n#EXTINF:2.0,\nhttps://video.example/seg2.ts\n#EXTINF:2.0,\nhttps://video.example/seg3.ts\n';
    await watcher.watch(target);
    expect(heads()).toEqual(['/seg1.ts', '/seg2.ts', '/seg3.ts']);
    expect(gqlCalls).toHaveLength(1); // the variant playlist URL is cached per channel
    watcher.reset();
    await watcher.watch(target);
    expect(gqlCalls).toHaveLength(2);
    watcher.reset();
  });

  it('keeps requesting new segments every 10 seconds until reset', async () => {
    vi.useFakeTimers();
    try {
      let n = 1;
      const { fetch, calls } = routes({
        ...spadeRoutes,
        'https://usher.ttvnw.net/': () => new Response('#EXTM3U\nhttps://video.example/160p.m3u8\n'),
        'https://video.example/160p.m3u8': () => new Response(`#EXTM3U\n#EXTINF:2.0,\nhttps://video.example/seg${n++}.ts\n`),
        'https://video.example/seg': () => new Response(null, { status: 200 }),
      });
      const gql = { request: async () => ({ data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } }) };
      const heads = () => calls.filter((c) => c.init?.method === 'HEAD').length;
      const watcher = new TwitchWatcher({ userId: '42', gql, userAgent: 'ua', fetchStream: () => true, fetch });
      await watcher.watch(target);
      expect(heads()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(heads()).toBe(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(heads()).toBe(4);
      watcher.reset();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heads()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports stream failure when the playlist answer is an error', async () => {
    const { fetch } = routes({
      ...spadeRoutes,
      'https://usher.ttvnw.net/': () => new Response('[{"error":"Can not find channel"}]', { status: 404 }),
    });
    const gql = { request: async () => ({ data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } }) };
    const watcher = new TwitchWatcher({ userId: '42', gql, userAgent: 'ua', fetchStream: () => true, fetch });
    await expect(watcher.watch(target)).resolves.toEqual({ beacon: true, stream: false });
  });
});
