import type { PriorityGame } from '../src/config.js';
import type { Campaign, Drop, LiveChannel } from '../src/twitch/types.js';

export const NOW = new Date('2026-10-08T12:00:00Z');

export const PRIORITY: PriorityGame[] = [
  { id: 'g1', name: 'Game One', slug: 'game-one' },
  { id: 'g2', name: 'Game Two', slug: 'game-two' },
  { id: 'g3', name: 'Game Three', slug: 'game-three' },
];

let seq = 0;

export function makeDrop(overrides: Partial<Drop> = {}): Drop {
  seq++;
  return {
    id: `drop-${seq}`,
    name: `Drop ${seq}`,
    benefitNames: [`Reward ${seq}`],
    requiredMinutes: 60,
    currentMinutes: 0,
    requiredSubs: 0,
    claimed: false,
    claimId: null,
    startsAt: new Date('2026-10-01T00:00:00Z'),
    endsAt: new Date('2026-10-20T00:00:00Z'),
    preconditionIds: [],
    ...overrides,
  };
}

export function makeCampaign(
  overrides: Partial<Campaign> & { gameId?: string; gameName?: string } = {},
): Campaign {
  seq++;
  const { gameId = 'g1', gameName = 'Game One', ...rest } = overrides;
  return {
    id: `camp-${seq}`,
    name: `Campaign ${seq}`,
    status: 'ACTIVE',
    game: { id: gameId, name: gameName, slug: gameName.toLowerCase().replace(/ /g, '-') },
    linked: true,
    linkUrl: `https://link/${gameId}`,
    badgeOrEmoteOnly: false,
    startsAt: new Date('2026-10-01T00:00:00Z'),
    endsAt: new Date('2026-10-20T00:00:00Z'),
    allowedChannels: [],
    drops: [makeDrop()],
    ...rest,
  };
}

export function makeChannel(overrides: Partial<LiveChannel> = {}): LiveChannel {
  seq++;
  return {
    id: `ch-${seq}`,
    login: `streamer${seq}`,
    displayName: `Streamer${seq}`,
    viewers: 100,
    broadcastId: `b-${seq}`,
    gameId: 'g1',
    gameName: 'Game One',
    ...overrides,
  };
}
