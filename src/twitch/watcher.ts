import type { GqlRequester } from './gql.js';
import { op } from './queries.js';
import type { Watcher, WatchResult, WatchTarget } from './types.js';

const SPADE_PATTERN = /"spade_?url": ?"(https:\/\/[.\w\-/]+)"/i;
const SETTINGS_PATTERN = /src="(https:\/\/[\w.]+\/config\/settings\.[0-9a-f]{32}\.js)"/i;

export function buildSpadeBody(target: WatchTarget, userId: string): string {
  const events = [
    {
      event: 'minute-watched',
      properties: {
        broadcast_id: target.broadcastId,
        channel_id: target.channelId,
        channel: target.login,
        client_time: new Date().toISOString(),
        game: target.gameName,
        game_id: target.gameId,
        hidden: false,
        is_live: true,
        live: true,
        logged_in: true,
        minutes_logged: 1,
        muted: false,
        user_id: Number(userId),
      },
    },
  ];
  const data = Buffer.from(JSON.stringify(events), 'utf8').toString('base64');
  return new URLSearchParams({ data }).toString();
}

export function usherUrl(login: string, signature: string, token: string): string {
  const params = new URLSearchParams({ sig: signature, token });
  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(login)}.m3u8?${params}`;
}

function mediaLines(playlist: string): string[] {
  return playlist
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function lastMediaLine(playlist: string): string | null {
  return mediaLines(playlist).at(-1) ?? null;
}

// Since 2026-10-07 Twitch counts watch time only while segments keep being requested, like a player does.
const SEGMENT_POLL_MS = 10_000;
const SEEN_SEGMENTS_LIMIT = 100;

export type WatcherDeps = {
  userId: string;
  gql: GqlRequester;
  userAgent: string;
  fetchStream: () => boolean;
  fetch?: typeof fetch;
};

export class TwitchWatcher implements Watcher {
  private spadeUrl: string | null = null;
  private variant: { login: string; url: string } | null = null;
  private seen = new Set<string>();
  private poller: { login: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly deps: WatcherDeps) {}

  async watch(target: WatchTarget): Promise<WatchResult> {
    const beacon = await this.sendBeacon(target).catch(() => false);
    if (!this.deps.fetchStream()) {
      this.stopPolling();
      return { beacon, stream: null };
    }
    if (this.poller?.login !== target.login) {
      this.stopPolling();
      this.poller = { login: target.login, timer: null };
    }
    const stream = await this.pollOnce(target);
    this.schedulePoll(target);
    return { beacon, stream };
  }

  reset(): void {
    this.stopPolling();
    this.variant = null;
    this.seen.clear();
  }

  private stopPolling(): void {
    if (this.poller?.timer) clearTimeout(this.poller.timer);
    this.poller = null;
  }

  private schedulePoll(target: WatchTarget): void {
    const poller = this.poller;
    if (!poller || poller.timer) return;
    poller.timer = setTimeout(async () => {
      poller.timer = null;
      if (this.poller !== poller) return;
      await this.pollOnce(target);
      if (this.poller === poller) this.schedulePoll(target);
    }, SEGMENT_POLL_MS);
    poller.timer.unref?.();
  }

  private pollOnce(target: WatchTarget): Promise<boolean> {
    this.inFlight ??= this.headNewSegments(target)
      .catch(() => false)
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async sendBeacon(target: WatchTarget): Promise<boolean> {
    this.spadeUrl ??= await this.findSpadeUrl(target.login);
    const res = await this.http(this.spadeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildSpadeBody(target, this.deps.userId),
    });
    if (res.status !== 204) {
      this.spadeUrl = null; // look it up again next minute
      return false;
    }
    return true;
  }

  // Channel page HTML → settings script → spade URL (the same path the web player takes).
  private async findSpadeUrl(login: string): Promise<string> {
    const html = await (await this.http(`https://www.twitch.tv/${encodeURIComponent(login)}`)).text();
    let match = SPADE_PATTERN.exec(html);
    if (!match) {
      const settings = SETTINGS_PATTERN.exec(html);
      if (!settings) throw new Error('spade URL: settings script not found');
      match = SPADE_PATTERN.exec(await (await this.http(settings[1])).text());
    }
    if (!match) throw new Error('spade URL not found');
    return match[1];
  }

  // HEADs on each new segment look like playback without downloading video.
  private async headNewSegments(target: WatchTarget): Promise<boolean> {
    if (this.variant?.login !== target.login) {
      const res = await this.deps.gql.request(
        op('PlaybackAccessToken', {
          isLive: true, isVod: false, login: target.login, platform: 'web', playerType: 'site', vodID: '',
        }),
      );
      const token = res?.data?.streamPlaybackAccessToken;
      if (!token) return false;
      const master = await (await this.http(usherUrl(target.login, token.signature, token.value))).text();
      const variantUrl = lastMediaLine(master); // the last variant is the lowest quality
      if (!variantUrl?.startsWith('http')) return false;
      this.variant = { login: target.login, url: variantUrl };
    }
    const media = await this.http(this.variant.url);
    if (media.status >= 400) {
      this.variant = null;
      return false;
    }
    const segments = mediaLines(await media.text());
    if (segments.length === 0) return false;
    let ok = true;
    for (const segment of segments) {
      if (this.seen.has(segment)) continue;
      const head = await this.http(segment, { method: 'HEAD' });
      if (head.status !== 200) {
        ok = false;
        continue;
      }
      this.seen.add(segment);
      if (this.seen.size > SEEN_SEGMENTS_LIMIT) this.seen.delete(this.seen.values().next().value!);
    }
    return ok;
  }

  private http(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = { 'User-Agent': this.deps.userAgent, ...((init.headers as Record<string, string>) ?? {}) };
    return (this.deps.fetch ?? fetch)(url, { ...init, headers });
  }
}
