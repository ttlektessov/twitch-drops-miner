import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PersistedOp } from '../src/twitch/gql.js';
import { parseCampaigns } from '../src/twitch/parse.js';
import { TwitchApi } from '../src/twitch/queries.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function fakeGql(handler: (op: PersistedOp) => unknown) {
  const calls: PersistedOp[][] = [];
  return {
    calls,
    async request(ops: PersistedOp | PersistedOp[]) {
      const list = Array.isArray(ops) ? ops : [ops];
      calls.push(list);
      const out = list.map(handler);
      return Array.isArray(ops) ? out : out[0];
    },
  };
}

const vars = (op: PersistedOp) => op.variables as Record<string, any>;
const RUST = { id: '263490', name: 'Rust', slug: 'rust' };

function campaignsHandler(op: PersistedOp): unknown {
  switch (op.operationName) {
    case 'Inventory':
      return { data: { currentUser: { inventory: fixture('inventory.json') } } };
    case 'ViewerDropsDashboard':
      return { data: { currentUser: { dropCampaigns: fixture('dashboard.json') } } };
    case 'DropCampaignDetails': {
      const detail = fixture('details.json').find((d: any) => d.id === vars(op).dropID);
      return { data: { user: { dropCampaign: detail ?? null } } };
    }
    case 'DirectoryPage_Game':
      return fixture('directory.json');
    case 'DropsHighlightService_AvailableDrops':
      return { data: { channel: { id: vars(op).channelID, viewerDropCampaigns: [] } } };
    case 'VideoPlayerStreamInfoOverlayChannel': {
      const info = fixture('streaminfo.json');
      return { data: { user: vars(op).channel === 'posty' ? info.live : info.offline } };
    }
    default:
      throw new Error(`unexpected ${op.operationName}`);
  }
}

describe('TwitchApi.getCampaigns', () => {
  it('fetches details for active campaigns of the requested games', async () => {
    const gql = fakeGql(campaignsHandler);
    const campaigns = await new TwitchApi(gql, '42').getCampaigns([RUST]);
    expect(campaigns.map((c) => c.id)).toEqual(['camp-rust']);
    expect(campaigns[0].drops.find((d) => d.id === 'drop-hoodie')!.currentMinutes).toBe(42);
    const detailCalls = gql.calls.flat().filter((o) => o.operationName === 'DropCampaignDetails');
    expect(detailCalls.map(vars)).toEqual([{ channelLogin: '42', dropID: 'camp-rust' }]);
  });

  it('skips the detail requests when no campaign matches', async () => {
    const gql = fakeGql(campaignsHandler);
    await expect(new TwitchApi(gql, '42').getCampaigns([{ id: '999', name: 'Other', slug: 'other' }])).resolves.toEqual([]);
    expect(gql.calls.flat().some((o) => o.operationName === 'DropCampaignDetails')).toBe(false);
  });
});

describe('TwitchApi.getCampaigns when Twitch hides the campaign dashboard', () => {
  const R6 = { id: '460630', name: 'Rainbow Six Siege', slug: 'tom-clancys-rainbow-six-siege' };
  const PHASMO = { id: '518184', name: 'Phasmophobia', slug: 'phasmophobia' };
  const phasmoChannels = [
    { id: '75738685', login: 'insym', viewers: 5331 },
    { id: '199584859', login: 'casson', viewers: 1182 },
  ];
  function handler(op: PersistedOp): unknown {
    switch (op.operationName) {
      case 'Inventory':
        return fixture('inventory-live.json');
      case 'ViewerDropsDashboard':
        return { data: { currentUser: { id: '1', login: 'me', dropCampaigns: null } } };
      case 'DirectoryPage_Game': {
        const live = vars(op).slug === 'phasmophobia' ? phasmoChannels : [];
        return { data: { game: { streams: { edges: live.map((ch, i) => ({ node: {
          id: `b${i}`, viewersCount: ch.viewers,
          broadcaster: { id: ch.id, login: ch.login, displayName: ch.login },
          game: { id: '518184', name: 'Phasmophobia' },
        } })) } } } };
      }
      case 'DropsHighlightService_AvailableDrops': {
        const found = phasmoChannels.some((ch) => ch.id === vars(op).channelID);
        return found ? fixture('availabledrops.json') : { data: { channel: { viewerDropCampaigns: [] } } };
      }
      default:
        throw new Error(`unexpected ${op.operationName}`);
    }
  }

  it('reads started campaigns from the inventory', async () => {
    const campaigns = await new TwitchApi(fakeGql(handler), '42').getCampaigns([R6]);
    const r6 = campaigns.find((c) => c.id === 'camp-r6')!;
    expect(r6).toMatchObject({ status: 'ACTIVE', linked: true, game: { id: '460630', slug: 'tom-clancys-rainbow-six-siege' } });
    expect(r6.allowedChannels.map((c) => c.login)).toEqual(['rainbow6', 'rainbow6es']);
    expect(r6.drops.map((d) => [d.currentMinutes, d.claimed])).toEqual([[60, true], [110, false]]);
    expect(campaigns.some((c) => c.id === 'camp-old')).toBe(false);
  });

  it('finds new campaigns on live drops-enabled channels of the requested games', async () => {
    const gql = fakeGql(handler);
    const campaigns = await new TwitchApi(gql, '42').getCampaigns([R6, PHASMO]);
    const phasmo = campaigns.find((c) => c.id === 'camp-phasmo')!;
    expect(phasmo.linkUnknown).toBe(true);
    expect(phasmo.allowedChannels).toEqual([{ id: '75738685', login: 'insym' }, { id: '199584859', login: 'casson' }]);
    expect(campaigns.some((c) => c.id === 'camp-channel-badge')).toBe(false);
    const availableCalls = gql.calls.flat().filter((o) => o.operationName === 'DropsHighlightService_AvailableDrops');
    expect(availableCalls.map((o) => vars(o).channelID)).toEqual(['75738685', '199584859']);
  });
});

describe('TwitchApi.getLiveChannels', () => {
  const [campaign] = parseCampaigns(fixture('dashboard.json'), fixture('details.json'), fixture('inventory.json'));

  it('uses the drops-enabled game directory for open campaigns, most viewers first', async () => {
    const gql = fakeGql(campaignsHandler);
    const channels = await new TwitchApi(gql, '42').getLiveChannels(campaign);
    expect(channels.map((c) => c.login)).toEqual(['posty', 'hope22_']);
    const v = vars(gql.calls[0][0]);
    expect(v.slug).toBe('rust');
    expect(v.options.systemFilters).toEqual(['DROPS_ENABLED']);
  });

  it('checks allow-listed channels and keeps live ones playing the game', async () => {
    const gql = fakeGql(campaignsHandler);
    const restricted = {
      ...campaign,
      allowedChannels: [{ id: '135377687', login: 'posty' }, { id: '37402112', login: 'shroud' }],
    };
    const channels = await new TwitchApi(gql, '42').getLiveChannels(restricted);
    expect(channels.map((c) => c.login)).toEqual(['posty']);
  });
});

describe('TwitchApi other calls', () => {
  it('claims a drop by instance id', async () => {
    const gql = fakeGql(() => ({ data: { claimDropRewards: { status: 'ELIGIBLE_FOR_ALL' } } }));
    await expect(new TwitchApi(gql, '42').claimDrop('inst-1')).resolves.toBe(true);
    expect(vars(gql.calls[0][0])).toEqual({ input: { dropInstanceID: 'inst-1' } });
    const failing = fakeGql(() => ({ data: { claimDropRewards: null } }));
    await expect(new TwitchApi(failing, '42').claimDrop('inst-1')).resolves.toBe(false);
  });

  it('resolves a game name to id, display name and slug', async () => {
    const gql = fakeGql((op) =>
      op.operationName === 'DirectoryGameRedirect'
        ? { data: { game: { id: '263490', slug: 'rust' } } }
        : fixture('directory.json'));
    await expect(new TwitchApi(gql, '42').resolveGame('rust')).resolves.toEqual({
      id: '263490', name: 'Rust', slug: 'rust',
    });
    const missing = fakeGql(() => ({ data: { game: null } }));
    await expect(new TwitchApi(missing, '42').resolveGame('nope')).resolves.toBeNull();
  });

  it('reads stream info for one channel', async () => {
    const api = new TwitchApi(fakeGql(campaignsHandler), '42');
    await expect(api.getStreamInfo('posty')).resolves.toMatchObject({ login: 'posty', viewers: 1132 });
    await expect(api.getStreamInfo('shroud')).resolves.toBeNull();
  });
});
