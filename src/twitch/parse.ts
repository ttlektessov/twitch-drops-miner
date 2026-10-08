import type { Campaign, Drop, Game, LiveChannel } from './types.js';

// Twitch responses are untyped. This file is the only place that reads their raw shape.
type Json = any;

const BADGE_OR_EMOTE = new Set(['BADGE', 'EMOTE']);

function parseGame(raw: Json): Game {
  return { id: String(raw.id), name: raw.displayName ?? raw.name, slug: raw.slug ?? null };
}

function parseDrop(raw: Json, progress: Json | undefined, awarded: Map<string, Date>): Drop {
  const self = progress?.self ?? raw.self ?? null;
  const benefits: Json[] = (raw.benefitEdges ?? []).map((e: Json) => e?.benefit).filter(Boolean);
  const startsAt = new Date(raw.startAt);
  const endsAt = new Date(raw.endAt);
  const requiredMinutes: number = raw.requiredMinutesWatched ?? 0;
  let claimed = Boolean(self?.isClaimed);
  if (!self) {
    // No progress entry: infer "claimed" from rewards awarded during this drop's window.
    const times = benefits
      .map((b: Json) => awarded.get(b.id))
      .filter((t: Date | undefined): t is Date => t !== undefined);
    claimed = times.length > 0 && times.every((t: Date) => t >= startsAt && t < endsAt);
  }
  return {
    id: raw.id,
    name: raw.name ?? '',
    benefitNames: benefits.map((b: Json) => b.name).filter(Boolean),
    requiredMinutes,
    currentMinutes: claimed ? requiredMinutes : (self?.currentMinutesWatched ?? 0),
    requiredSubs: raw.requiredSubs ?? 0,
    claimed,
    claimId: self?.dropInstanceID ?? null,
    startsAt,
    endsAt,
    preconditionIds: (raw.preconditionDrops ?? []).map((p: Json) => p.id),
  };
}

export function parseCampaigns(dashboard: Json[], details: Json[], inventory: Json): Campaign[] {
  const detailById = new Map<string, Json>(details.filter(Boolean).map((d: Json) => [d.id, d]));
  const progressByDrop = new Map<string, Json>();
  for (const c of inventory?.dropCampaignsInProgress ?? []) {
    for (const d of c.timeBasedDrops ?? []) progressByDrop.set(d.id, d);
  }
  const awarded = new Map<string, Date>(
    (inventory?.gameEventDrops ?? []).map((b: Json) => [b.id, new Date(b.lastAwardedAt)]),
  );

  const campaigns: Campaign[] = [];
  for (const summary of dashboard) {
    const detail = detailById.get(summary.id) ?? {};
    const pick = (key: string) => detail[key] ?? summary[key];
    const game = pick('game');
    const rawDrops = pick('timeBasedDrops');
    if (!game || !Array.isArray(rawDrops)) continue;
    const benefitTypes: string[] = rawDrops.flatMap((d: Json) =>
      (d.benefitEdges ?? []).map((e: Json) => e?.benefit?.distributionType),
    );
    const allow = pick('allow');
    campaigns.push({
      id: summary.id,
      name: pick('name'),
      status: summary.status ?? detail.status ?? 'ACTIVE',
      game: parseGame(game),
      linked: Boolean(detail.self?.isAccountConnected ?? summary.self?.isAccountConnected),
      linkUrl: pick('accountLinkURL') ?? '',
      badgeOrEmoteOnly: benefitTypes.length > 0 && benefitTypes.every((t) => BADGE_OR_EMOTE.has(t)),
      startsAt: new Date(pick('startAt')),
      endsAt: new Date(pick('endAt')),
      allowedChannels:
        allow && allow.isEnabled !== false && Array.isArray(allow.channels)
          ? allow.channels.map((ch: Json) => ({ id: String(ch.id), login: ch.name }))
          : [],
      drops: rawDrops.map((d: Json) => parseDrop(d, progressByDrop.get(d.id), awarded)),
    });
  }
  return campaigns;
}

// DropsHighlightService_AvailableDrops lists the campaigns a live channel offers. It has no status,
// start date or account-link info, so the campaign is treated as active, linked, and tied to that channel.
export function parseAvailableCampaigns(raw: Json[], channel: { id: string; login: string }): Campaign[] {
  const summaries = raw
    .filter((c: Json) => c?.game && Array.isArray(c.timeBasedDrops) && c.timeBasedDrops.length > 0)
    .map((c: Json) => ({
      ...c,
      status: 'ACTIVE',
      startAt: c.timeBasedDrops
        .map((d: Json) => d.startAt)
        .reduce((a: string, b: string) => (new Date(a) <= new Date(b) ? a : b)),
      self: { isAccountConnected: true },
      allow: { channels: [{ id: channel.id, name: channel.login }] },
    }));
  return parseCampaigns(summaries, [], {}).map((c) => ({ ...c, linkUnknown: true }));
}

export function parseDirectoryStream(node: Json): LiveChannel {
  return {
    id: String(node.broadcaster.id),
    login: node.broadcaster.login,
    displayName: node.broadcaster.displayName ?? node.broadcaster.login,
    viewers: node.viewersCount ?? 0,
    broadcastId: String(node.id),
    gameId: node.game ? String(node.game.id) : null,
    gameName: node.game ? (node.game.displayName ?? node.game.name) : null,
  };
}

export function parseStreamInfo(user: Json): LiveChannel | null {
  if (!user?.stream) return null;
  const game = user.broadcastSettings?.game;
  return {
    id: String(user.id),
    login: user.login,
    displayName: user.displayName ?? user.login,
    viewers: user.stream.viewersCount ?? 0,
    broadcastId: String(user.stream.id),
    gameId: game ? String(game.id) : null,
    gameName: game ? (game.displayName ?? game.name) : null,
  };
}

export function dropLabel(drop: Drop): string {
  return drop.benefitNames.join(', ') || drop.name || 'Unnamed drop';
}
