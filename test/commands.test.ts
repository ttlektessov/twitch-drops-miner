import { describe, expect, it } from 'vitest';
import { formatCampaignList, formatGames, formatLogLine } from '../src/commands.js';
import { makeCampaign, makeDrop, NOW, PRIORITY } from './helpers.js';

describe('formatCampaignList', () => {
  it('lists priority games first with drop statuses', () => {
    const other = makeCampaign({ gameId: 'zzz', gameName: 'Another Game', name: 'Other Camp', endsAt: new Date('2026-10-09T12:00:00Z') });
    const two = makeCampaign({
      gameId: 'g2', gameName: 'Game Two', name: 'Two Camp', linked: false,
      drops: [
        makeDrop({ benefitNames: ['Hoodie'], currentMinutes: 42, requiredMinutes: 60 }),
        makeDrop({ benefitNames: ['Bandana'], claimed: true, currentMinutes: 30, requiredMinutes: 30 }),
        makeDrop({ benefitNames: ['Sub Badge'], requiredMinutes: 0, requiredSubs: 5 }),
      ],
    });
    const text = formatCampaignList([other, two], PRIORITY, NOW);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Game Two ★2 · Two Camp · ends in 11d 12h · NOT LINKED → https://link/g2');
    expect(text).toMatch(/Hoodie\s+42\/60 min/);
    expect(text).toMatch(/Bandana\s+claimed/);
    expect(text).toMatch(/Sub Badge\s+subscription only/);
    expect(text).toContain('Another Game · Other Camp · ends in 1d 0h · linked');
    expect(text.indexOf('Game Two')).toBeLessThan(text.indexOf('Another Game'));
  });

  it('marks campaigns whose account link Twitch did not report', () => {
    const found = makeCampaign({ gameId: 'g1', gameName: 'Game One', name: 'Found Camp', linkUnknown: true });
    expect(formatCampaignList([found], PRIORITY, NOW)).toContain('Game One ★1 · Found Camp · ends in 11d 12h · link unknown');
  });

  it('says when there are no campaigns', () => {
    expect(formatCampaignList([], PRIORITY, NOW)).toBe('No active drop campaigns.');
  });
});

describe('formatGames', () => {
  it('numbers the priority list', () => {
    expect(formatGames(PRIORITY)).toBe('1. Game One\n2. Game Two\n3. Game Three');
    expect(formatGames([])).toContain('drops games add');
  });
});

describe('formatLogLine', () => {
  it('writes ISO time, kind and message', () => {
    expect(formatLogLine({ at: NOW, kind: 'claim', message: 'Claimed: Rust — Hoodie' }))
      .toBe('2026-10-08T12:00:00.000Z [claim] Claimed: Rust — Hoodie\n');
  });
});
