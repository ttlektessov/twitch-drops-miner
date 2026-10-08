import type { PriorityGame } from './config.js';
import type { Campaign, Drop, LiveChannel } from './twitch/types.js';

export type QueueEntry = {
  position: number;
  game: string;
  state: 'ready' | 'not_linked' | 'no_campaign' | 'all_claimed';
  detail?: string;
};

const isWatchable = (d: Drop) => d.requiredMinutes > 0 && d.requiredSubs === 0;

export function isCampaignActive(c: Campaign, now: Date): boolean {
  return c.status === 'ACTIVE' && c.startsAt <= now && now < c.endsAt;
}

// Badge/emote rewards go to the Twitch account itself, so they need no game-account link.
export function canAccountEarn(c: Campaign): boolean {
  return c.linked || c.badgeOrEmoteOnly;
}

export function earnableDrops(c: Campaign, now: Date): Drop[] {
  if (!isCampaignActive(c, now)) return [];
  const claimed = new Set(c.drops.filter((d) => d.claimed).map((d) => d.id));
  return c.drops.filter(
    (d) =>
      !d.claimed &&
      isWatchable(d) &&
      d.startsAt <= now &&
      now < d.endsAt &&
      d.preconditionIds.every((id) => claimed.has(id)),
  );
}

export function isCampaignEligible(c: Campaign, now: Date): boolean {
  return canAccountEarn(c) && earnableDrops(c, now).length > 0;
}

export function priorityIndex(priority: PriorityGame[], gameId: string): number {
  const index = priority.findIndex((g) => g.id === gameId);
  return index === -1 ? Infinity : index;
}

export function rankCampaigns(campaigns: Campaign[], priority: PriorityGame[], now: Date): Campaign[] {
  return campaigns
    .filter((c) => priorityIndex(priority, c.game.id) !== Infinity && isCampaignEligible(c, now))
    .sort(
      (a, b) =>
        priorityIndex(priority, a.game.id) - priorityIndex(priority, b.game.id) ||
        a.endsAt.getTime() - b.endsAt.getTime(),
    );
}

const remaining = (d: Drop) => d.requiredMinutes - d.currentMinutes;

export function currentDrop(c: Campaign, now: Date): Drop | null {
  return earnableDrops(c, now).sort((a, b) => remaining(a) - remaining(b))[0] ?? null;
}

export function upcomingDrops(c: Campaign, now: Date, current: Drop | null): Drop[] {
  return c.drops
    .filter((d) => !d.claimed && isWatchable(d) && d.endsAt > now && d.id !== current?.id)
    .sort((a, b) => a.requiredMinutes - b.requiredMinutes);
}

export function claimableDrops(c: Campaign): Drop[] {
  return c.drops.filter(
    (d) => !d.claimed && d.claimId !== null && d.requiredMinutes > 0 && d.currentMinutes >= d.requiredMinutes,
  );
}

export function pickChannel(channels: LiveChannel[], exclude: Set<string>): LiveChannel | null {
  return [...channels].filter((c) => !exclude.has(c.id)).sort((a, b) => b.viewers - a.viewers)[0] ?? null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function buildQueue(
  campaigns: Campaign[],
  priority: PriorityGame[],
  now: Date,
  skipGameId?: string,
): QueueEntry[] {
  return priority.flatMap((g, i): QueueEntry[] => {
    if (g.id === skipGameId) return [];
    const position = i + 1;
    const active = campaigns.filter((c) => c.game.id === g.id && isCampaignActive(c, now));
    if (active.length === 0) return [{ position, game: g.name, state: 'no_campaign' }];
    const eligible = active.filter((c) => isCampaignEligible(c, now));
    if (eligible.length > 0) {
      const left = eligible.reduce((n, c) => n + earnableDrops(c, now).length, 0);
      const detail = `${plural(eligible.length, 'campaign')} · ${plural(left, 'drop')} left`;
      return [{ position, game: g.name, state: 'ready', detail }];
    }
    const unlinked = active.find((c) => !canAccountEarn(c) && earnableDrops(c, now).length > 0);
    if (unlinked) return [{ position, game: g.name, state: 'not_linked', detail: unlinked.linkUrl }];
    return [{ position, game: g.name, state: 'all_claimed' }];
  });
}
