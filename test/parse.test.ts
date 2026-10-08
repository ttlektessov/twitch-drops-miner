import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dropLabel, parseAvailableCampaigns, parseCampaigns, parseDirectoryStream, parseStreamInfo } from '../src/twitch/parse.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('parseCampaigns', () => {
  const campaigns = parseCampaigns(fixture('dashboard.json'), fixture('details.json'), fixture('inventory.json'));
  const drop = (id: string) => campaigns[0].drops.find((d) => d.id === id)!;

  it('skips campaigns without a game', () => {
    expect(campaigns.map((c) => c.id)).toEqual(['camp-rust']);
  });

  it('reads campaign fields', () => {
    const c = campaigns[0];
    expect(c.name).toBe('Rust Drops Round 42');
    expect(c.status).toBe('ACTIVE');
    expect(c.game).toEqual({ id: '263490', name: 'Rust', slug: 'rust' });
    expect(c.linked).toBe(true);
    expect(c.linkUrl).toBe('https://example.com/link-rust');
    expect(c.endsAt.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(c.allowedChannels).toEqual([]);
    expect(c.badgeOrEmoteOnly).toBe(false);
    expect(c.drops).toHaveLength(4);
  });

  it('merges inventory progress into drops', () => {
    expect(drop('drop-hoodie')).toMatchObject({
      currentMinutes: 42, requiredMinutes: 60, claimed: false, claimId: null,
    });
    expect(drop('drop-door').currentMinutes).toBe(0);
  });

  it('marks a drop claimed when its reward was awarded inside the drop window', () => {
    expect(drop('drop-bandana')).toMatchObject({ claimed: true, currentMinutes: 30 });
  });

  it('keeps subscription requirements and preconditions', () => {
    expect(drop('drop-sub')).toMatchObject({ requiredSubs: 5, requiredMinutes: 0 });
    expect(drop('drop-door').preconditionIds).toEqual(['drop-hoodie']);
  });

  it('parses fractional-second timestamps', () => {
    expect(drop('drop-sub').startsAt.toISOString()).toBe('2026-10-08T09:32:51.500Z');
  });

  it('reads allow-listed channels unless the list is disabled', () => {
    const summary = fixture('dashboard.json')[0];
    const detail = (isEnabled: boolean) => ({
      id: 'camp-rust', timeBasedDrops: [], allow: { isEnabled, channels: [{ id: 1, name: 'hjune', displayName: 'HJune' }] },
    });
    expect(parseCampaigns([summary], [detail(true)], {})[0].allowedChannels).toEqual([{ id: '1', login: 'hjune' }]);
    expect(parseCampaigns([summary], [detail(false)], {})[0].allowedChannels).toEqual([]);
  });

  it('flags campaigns whose rewards are all badges or emotes', () => {
    const summary = fixture('dashboard.json')[0];
    const badgeDrop = fixture('details.json')[0].timeBasedDrops[3];
    expect(parseCampaigns([summary], [{ id: 'camp-rust', timeBasedDrops: [badgeDrop] }], {})[0].badgeOrEmoteOnly).toBe(true);
  });
});

describe('parseAvailableCampaigns', () => {
  const raw = fixture('availabledrops.json').data.channel.viewerDropCampaigns;
  const campaigns = parseAvailableCampaigns(raw, { id: '75738685', login: 'insym' });

  it('builds an active campaign tied to the channel it was found on', () => {
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({
      id: 'camp-phasmo', name: 'Crimson Eye 2026', status: 'ACTIVE',
      game: { id: '518184', name: 'Phasmophobia', slug: null },
      linked: true, linkUnknown: true,
      allowedChannels: [{ id: '75738685', login: 'insym' }],
    });
    expect(campaigns[0].drops.map((d) => d.requiredMinutes)).toEqual([60, 120]);
  });

  it('starts the campaign at its earliest drop', () => {
    expect(campaigns[0].startsAt.toISOString()).toBe('2026-10-06T17:00:00.000Z');
    expect(campaigns[0].endsAt.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });
});

describe('dropLabel', () => {
  const [campaign] = parseCampaigns(fixture('dashboard.json'), fixture('details.json'), fixture('inventory.json'));

  it('uses reward names, even when the drop name is empty', () => {
    expect(dropLabel(campaign.drops[0])).toBe('Hoodie');
    expect(dropLabel(campaign.drops[1])).toBe('Door Skin');
  });

  it('falls back to the drop name, then a placeholder', () => {
    expect(dropLabel({ ...campaign.drops[1], benefitNames: [] })).toBe('Door Skin Drop');
    expect(dropLabel({ ...campaign.drops[0], benefitNames: [] })).toBe('Unnamed drop');
  });
});

describe('channel parsing', () => {
  it('parses a directory stream node', () => {
    const node = fixture('directory.json').data.game.streams.edges[1].node;
    expect(parseDirectoryStream(node)).toEqual({
      id: '135377687', login: 'posty', displayName: 'Posty', viewers: 1132,
      broadcastId: '317066421972', gameId: '263490', gameName: 'Rust',
    });
  });

  it('parses stream info for live and offline users', () => {
    const info = fixture('streaminfo.json');
    expect(parseStreamInfo(info.live)).toEqual({
      id: '135377687', login: 'posty', displayName: 'Posty', viewers: 1132,
      broadcastId: '317066421972', gameId: '263490', gameName: 'Rust',
    });
    expect(parseStreamInfo(info.offline)).toBeNull();
    expect(parseStreamInfo(null)).toBeNull();
  });
});
