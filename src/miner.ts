import type { PriorityGame } from './config.js';
import {
  buildQueue, claimableDrops, currentDrop, earnableDrops, isCampaignEligible, pickChannel, priorityIndex, rankCampaigns,
  upcomingDrops, type QueueEntry,
} from './selection.js';
import { AuthError, GqlOperationError } from './twitch/errors.js';
import { dropLabel } from './twitch/parse.js';
import type { Campaign, LiveChannel, TwitchClient, Watcher } from './twitch/types.js';

export type MinerStatus = 'starting' | 'mining' | 'idle' | 'error' | 'login_required';
export type LogKind = 'claim' | 'switch' | 'start' | 'error' | 'info';
export type LogEntry = { at: Date; kind: LogKind; message: string };

export type TargetView = {
  game: string;
  campaign: string;
  campaignEndsAt: Date;
  channel: { login: string; viewers: number };
  drop: { name: string; current: number; required: number } | null;
  remainingDrops: { name: string; required: number }[];
};

export type MinerState = {
  status: MinerStatus;
  user: string;
  target?: TargetView;
  queue: QueueEntry[];
  nextCheckAt?: Date;
  error?: string;
  log: LogEntry[];
};

export type Intervals = {
  tickMs: number;
  progressMs: number;
  reselectMs: number;
  idleRecheckMs: number;
  errorRetryMs: number;
  stallChecks: number;
};

export const DEFAULT_INTERVALS: Intervals = {
  tickMs: 60_000,
  progressMs: 180_000,
  reselectMs: 900_000,
  idleRecheckMs: 300_000,
  errorRetryMs: 300_000,
  stallChecks: 2,
};

export type MinerDeps = {
  api: TwitchClient;
  watcher: Watcher;
  getPriority: () => PriorityGame[];
  user: string;
  intervals?: Partial<Intervals>;
  onLog?: (entry: LogEntry) => void;
};

const LOG_LIMIT = 10;

const BEACON_FAILURE_LIMIT = 3;

type Active = {
  campaign: Campaign;
  channel: LiveChannel;
  estimate: number;
  progress: Progress;
  stalls: number;
};

// Progress across every earnable drop, so a finished-but-unclaimed drop doesn't look like a stall.
type Progress = { key: string; total: number; allDone: boolean };

function progressOf(campaign: Campaign, now: Date): Progress {
  const drops = earnableDrops(campaign, now);
  return {
    key: drops.map((d) => d.id).sort().join(','),
    total: drops.reduce((sum, d) => sum + d.currentMinutes, 0),
    allDone: drops.every((d) => d.currentMinutes >= d.requiredMinutes),
  };
}

type Choice = { campaign: Campaign; channel: LiveChannel };

export class Miner {
  private readonly iv: Intervals;
  private readonly listeners = new Set<(state: MinerState) => void>();
  private readonly recent: LogEntry[] = [];
  private readonly excluded = new Set<string>();
  private excludedFor: string | null = null;
  private state: MinerState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;
  private active: Active | null = null;
  private campaigns: Campaign[] = [];
  private forceSelect = true;
  private lastSelectAt = 0;
  private lastProgressAt = 0;
  private retryAt = 0;
  private error: string | null = null;
  private loginRequired = false;
  private beaconFailures = 0;

  constructor(private readonly deps: MinerDeps) {
    this.iv = { ...DEFAULT_INTERVALS, ...deps.intervals };
    this.state = { status: 'starting', user: deps.user, queue: [], log: [] };
  }

  getState(): MinerState {
    return this.state;
  }

  subscribe(listener: (state: MinerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    this.deps.watcher.reset();
  }

  refresh(): void {
    this.forceSelect = true;
    this.retryAt = 0;
    if (this.running && !this.busy) {
      if (this.timer) clearTimeout(this.timer);
      this.schedule(0);
    }
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.busy = true;
    try {
      await this.step();
    } catch (err) {
      this.handleError(err);
    } finally {
      this.busy = false;
      this.emit();
      if (this.running) this.schedule(this.iv.tickMs);
    }
  }

  private async step(): Promise<void> {
    const now = Date.now();
    if (now < this.retryAt) return;
    const sinceSelect = now - this.lastSelectAt;
    const selectDue = this.active ? sinceSelect >= this.iv.reselectMs : sinceSelect >= this.iv.idleRecheckMs;
    // Only a successful Twitch call clears an error; quiet ticks leave it showing.
    let talkedToTwitch = true;
    if (this.forceSelect || selectDue) await this.select();
    else if (this.active && now - this.lastProgressAt >= this.iv.progressMs) await this.checkProgress(this.active);
    else {
      talkedToTwitch = false;
      if (this.active) this.active.estimate += 1;
    }

    // stop() may have landed while we were waiting on Twitch.
    if (!this.running) {
      this.active = null;
      return;
    }
    const active = this.active;
    if (active) {
      const result = await this.deps.watcher.watch({
        channelId: active.channel.id,
        login: active.channel.login,
        broadcastId: active.channel.broadcastId,
        gameId: active.campaign.game.id,
        gameName: active.campaign.game.name,
      });
      if (result.beacon) this.beaconFailures = 0;
      else if (++this.beaconFailures === BEACON_FAILURE_LIMIT) {
        this.addLog('error', 'Minute-watched beacon keeps failing, so drops will not progress. Twitch may have changed its player.');
      }
    }
    if (talkedToTwitch) {
      this.error = null;
      this.retryAt = 0;
    }
  }

  private async select(): Promise<void> {
    const now = new Date();
    const priority = this.deps.getPriority();
    this.forceSelect = false;
    this.lastSelectAt = now.getTime();
    this.campaigns = await this.deps.api.getCampaigns(priority.map((g) => g.id));
    for (const campaign of this.campaigns) await this.claimReady(campaign);
    const ranked = rankCampaigns(this.campaigns, priority, now);

    const active = this.active;
    const current = active ? ranked.find((c) => c.id === active.campaign.id) : undefined;
    if (active && current) {
      const currentRank = priorityIndex(priority, current.game.id);
      const better = await this.findChoice(ranked.filter((c) => priorityIndex(priority, c.game.id) < currentRank));
      if (better) {
        this.setTarget(better, 'switch', `Switched to higher-priority game: ${better.campaign.game.name} → ${better.channel.login}`);
      } else {
        active.campaign = current;
      }
      return;
    }
    if (active) this.addLog('info', `Stopped: ${active.campaign.game.name} — ${active.campaign.name} is no longer available`);

    const choice = await this.findChoice(ranked);
    if (choice) {
      this.setTarget(choice, 'start', `Started: ${choice.campaign.game.name} → ${choice.channel.login}`);
    } else {
      this.active = null;
      this.excluded.clear();
      this.excludedFor = null;
      this.deps.watcher.reset();
    }
  }

  private async findChoice(candidates: Campaign[]): Promise<Choice | null> {
    for (const campaign of candidates) {
      const channel = pickChannel(await this.deps.api.getLiveChannels(campaign), this.excluded);
      if (channel) return { campaign, channel };
    }
    return null;
  }

  private setTarget(choice: Choice, kind: LogKind, message: string): void {
    if (this.excludedFor !== choice.campaign.id) {
      this.excluded.clear();
      this.excludedFor = null;
    }
    this.deps.watcher.reset();
    const now = new Date();
    this.active = {
      campaign: choice.campaign,
      channel: choice.channel,
      estimate: currentDrop(choice.campaign, now)?.currentMinutes ?? 0,
      progress: progressOf(choice.campaign, now),
      stalls: 0,
    };
    this.lastProgressAt = Date.now();
    this.addLog(kind, message);
  }

  private async checkProgress(active: Active): Promise<void> {
    const now = new Date();
    this.lastProgressAt = now.getTime();
    const fresh = (await this.deps.api.getCampaigns([active.campaign.game.id])).find(
      (c) => c.id === active.campaign.id,
    );
    if (!fresh) {
      this.addLog('info', `Campaign ended: ${active.campaign.game.name} — ${active.campaign.name}`);
      this.active = null;
      await this.select();
      return;
    }
    await this.claimReady(fresh);
    if (!isCampaignEligible(fresh, now)) {
      this.addLog('info', `Campaign complete: ${fresh.game.name} — ${fresh.name}`);
      this.active = null;
      await this.select();
      return;
    }
    active.campaign = fresh;

    const live = await this.deps.api.getStreamInfo(active.channel.login);
    if (!live) return this.switchChannel(active, 'stream went offline');
    if (live.gameId !== fresh.game.id) return this.switchChannel(active, 'streamer changed game');
    active.channel = { ...active.channel, viewers: live.viewers, broadcastId: live.broadcastId };

    const progress = progressOf(fresh, now);
    const stalled =
      !progress.allDone && progress.key === active.progress.key && progress.total <= active.progress.total;
    active.stalls = stalled ? active.stalls + 1 : 0;
    active.progress = progress;
    active.estimate = currentDrop(fresh, now)?.currentMinutes ?? 0;
    if (active.stalls >= this.iv.stallChecks) await this.switchChannel(active, 'no progress for several minutes');
  }

  private async switchChannel(active: Active, reason: string): Promise<void> {
    this.excluded.add(active.channel.id);
    this.excludedFor = active.campaign.id;
    const channel = pickChannel(await this.deps.api.getLiveChannels(active.campaign), this.excluded);
    if (channel) {
      this.setTarget(
        { campaign: active.campaign, channel },
        'switch',
        `Switched channel (${reason}): ${active.channel.login} → ${channel.login}`,
      );
      return;
    }
    this.addLog('switch', `${reason}: no other live channel for ${active.campaign.game.name}`);
    this.active = null;
    await this.select();
  }

  private async claimReady(campaign: Campaign): Promise<void> {
    for (const drop of claimableDrops(campaign)) {
      let ok = false;
      try {
        ok = await this.deps.api.claimDrop(drop.claimId as string);
      } catch (err) {
        if (err instanceof AuthError) throw err;
      }
      if (ok) {
        drop.claimed = true;
        this.addLog('claim', `Claimed: ${campaign.game.name} — ${dropLabel(drop)}`);
      } else {
        this.addLog('error', `Claim failed: ${campaign.game.name} — ${dropLabel(drop)} (will retry)`);
      }
    }
  }

  private handleError(err: unknown): void {
    if (err instanceof AuthError) {
      this.loginRequired = true;
      this.running = false;
      this.active = null;
      this.deps.watcher.reset();
      this.addLog('error', 'Login expired or revoked. Quit and run `drops login`.');
      return;
    }
    this.error = err instanceof Error ? err.message : String(err);
    this.addLog('error', this.error);
    if (err instanceof GqlOperationError) {
      this.active = null;
      this.deps.watcher.reset();
      this.lastSelectAt = Date.now();
      return;
    }
    this.retryAt = Date.now() + this.iv.errorRetryMs;
  }

  private addLog(kind: LogKind, message: string): void {
    const entry: LogEntry = { at: new Date(), kind, message };
    this.recent.unshift(entry);
    this.recent.splice(LOG_LIMIT);
    this.deps.onLog?.(entry);
  }

  private emit(): void {
    const now = new Date();
    const active = this.active;
    let target: TargetView | undefined;
    if (active) {
      const drop = currentDrop(active.campaign, now);
      target = {
        game: active.campaign.game.name,
        campaign: active.campaign.name,
        campaignEndsAt: active.campaign.endsAt,
        channel: { login: active.channel.login, viewers: active.channel.viewers },
        drop: drop
          ? {
              name: dropLabel(drop),
              current: Math.min(drop.requiredMinutes, Math.max(drop.currentMinutes, active.estimate)),
              required: drop.requiredMinutes,
            }
          : null,
        remainingDrops: upcomingDrops(active.campaign, now, drop).map((d) => ({
          name: dropLabel(d),
          required: d.requiredMinutes,
        })),
      };
    }
    const status: MinerStatus = this.loginRequired
      ? 'login_required'
      : this.error
        ? 'error'
        : active
          ? 'mining'
          : this.lastSelectAt === 0
            ? 'starting'
            : 'idle';
    const nextCheckAt =
      status === 'idle'
        ? new Date(this.lastSelectAt + this.iv.idleRecheckMs)
        : status === 'error'
          ? new Date(this.retryAt || this.lastSelectAt + this.iv.idleRecheckMs)
          : undefined;
    this.state = {
      status,
      user: this.deps.user,
      target,
      queue: buildQueue(this.campaigns, this.deps.getPriority(), now, active?.campaign.game.id),
      nextCheckAt,
      error: this.error ?? undefined,
      log: [...this.recent],
    };
    for (const listener of this.listeners) listener(this.state);
  }
}
