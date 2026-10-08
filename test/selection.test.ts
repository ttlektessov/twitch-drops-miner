import { describe, expect, it } from 'vitest';
import {
  buildQueue, claimableDrops, currentDrop, pickChannel, rankCampaigns, upcomingDrops,
} from '../src/selection.js';
import { makeCampaign, makeChannel, makeDrop, NOW, PRIORITY } from './helpers.js';

describe('rankCampaigns', () => {
  it('orders by priority, then soonest end', () => {
    const late = makeCampaign({ endsAt: new Date('2026-10-15T00:00:00Z') });
    const soon = makeCampaign({ endsAt: new Date('2026-10-10T00:00:00Z') });
    const second = makeCampaign({ gameId: 'g2', gameName: 'Game Two', endsAt: new Date('2026-10-09T00:00:00Z') });
    expect(rankCampaigns([second, late, soon], PRIORITY, NOW).map((c) => c.id)).toEqual([soon.id, late.id, second.id]);
  });

  it('leaves out campaigns that cannot be earned', () => {
    const campaigns = [
      makeCampaign({ gameId: 'other' }),
      makeCampaign({ linked: false }),
      makeCampaign({ drops: [makeDrop({ requiredMinutes: 0, requiredSubs: 5 })] }),
      makeCampaign({ endsAt: new Date('2026-10-02T00:00:00Z') }),
      makeCampaign({ status: 'UPCOMING' }),
      makeCampaign({ drops: [makeDrop({ claimed: true })] }),
    ];
    expect(rankCampaigns(campaigns, PRIORITY, NOW)).toEqual([]);
  });

  it('allows unlinked campaigns that only give badges or emotes', () => {
    const badge = makeCampaign({ linked: false, badgeOrEmoteOnly: true });
    expect(rankCampaigns([badge], PRIORITY, NOW)).toEqual([badge]);
  });
});

describe('drops', () => {
  it('currentDrop picks the earnable drop closest to completion', () => {
    const far = makeDrop({ requiredMinutes: 60, currentMinutes: 10 });
    const near = makeDrop({ requiredMinutes: 30, currentMinutes: 0 });
    expect(currentDrop(makeCampaign({ drops: [far, near] }), NOW)?.id).toBe(near.id);
  });

  it('currentDrop prefers drops that still need minutes over finished, unclaimed ones', () => {
    const finished = makeDrop({ requiredMinutes: 60, currentMinutes: 60 });
    const running = makeDrop({ requiredMinutes: 120, currentMinutes: 10 });
    expect(currentDrop(makeCampaign({ drops: [finished, running] }), NOW)?.id).toBe(running.id);
    expect(currentDrop(makeCampaign({ drops: [finished] }), NOW)?.id).toBe(finished.id);
  });

  it('currentDrop skips drops whose preconditions are unclaimed', () => {
    const first = makeDrop({ id: 'first', requiredMinutes: 60 });
    const second = makeDrop({ id: 'second', requiredMinutes: 10, preconditionIds: ['first'] });
    expect(currentDrop(makeCampaign({ drops: [first, second] }), NOW)?.id).toBe('first');
  });

  it('upcomingDrops lists unclaimed watchable drops other than the current one, shortest first', () => {
    const current = makeDrop({ requiredMinutes: 60 });
    const big = makeDrop({ requiredMinutes: 240 });
    const small = makeDrop({ requiredMinutes: 120, preconditionIds: [current.id] });
    const claimed = makeDrop({ claimed: true });
    const sub = makeDrop({ requiredMinutes: 0, requiredSubs: 1 });
    const c = makeCampaign({ drops: [current, big, small, claimed, sub] });
    expect(upcomingDrops(c, NOW, current).map((d) => d.id)).toEqual([small.id, big.id]);
  });

  it('claimableDrops returns finished, unclaimed drops that have a claim id', () => {
    const ready = makeDrop({ currentMinutes: 60, claimId: 'c1' });
    const noId = makeDrop({ currentMinutes: 60 });
    const done = makeDrop({ currentMinutes: 60, claimId: 'c2', claimed: true });
    const partial = makeDrop({ currentMinutes: 59, claimId: 'c3' });
    expect(claimableDrops(makeCampaign({ drops: [ready, noId, done, partial] }))).toEqual([ready]);
  });
});

describe('pickChannel', () => {
  it('picks the most-watched channel that is not excluded', () => {
    const a = makeChannel({ viewers: 10 });
    const b = makeChannel({ viewers: 500 });
    const c = makeChannel({ viewers: 900 });
    expect(pickChannel([a, b, c], new Set([c.id]))).toEqual(b);
    expect(pickChannel([], new Set())).toBeNull();
  });
});

describe('buildQueue', () => {
  it('describes every priority game except the one being mined', () => {
    const campaigns = [
      makeCampaign(),
      makeCampaign({ gameId: 'g2', gameName: 'Game Two', drops: [makeDrop(), makeDrop()] }),
      makeCampaign({ gameId: 'g2', gameName: 'Game Two' }),
      makeCampaign({ gameId: 'g3', gameName: 'Game Three', linked: false }),
    ];
    expect(buildQueue(campaigns, PRIORITY, NOW, 'g1')).toEqual([
      { position: 2, game: 'Game Two', state: 'ready', detail: '2 campaigns · 3 drops left' },
      { position: 3, game: 'Game Three', state: 'not_linked', detail: 'https://link/g3' },
    ]);
  });

  it('reports missing and fully claimed campaigns', () => {
    const campaigns = [makeCampaign({ gameId: 'g2', gameName: 'Game Two', drops: [makeDrop({ claimed: true })] })];
    expect(buildQueue(campaigns, PRIORITY, NOW)).toEqual([
      { position: 1, game: 'Game One', state: 'no_campaign' },
      { position: 2, game: 'Game Two', state: 'all_claimed' },
      { position: 3, game: 'Game Three', state: 'no_campaign' },
    ]);
  });
});
