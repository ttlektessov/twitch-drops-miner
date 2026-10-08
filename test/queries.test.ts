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
    const campaigns = await new TwitchApi(gql, '42').getCampaigns(['263490']);
    expect(campaigns.map((c) => c.id)).toEqual(['camp-rust']);
    expect(campaigns[0].drops.find((d) => d.id === 'drop-hoodie')!.currentMinutes).toBe(42);
    const detailCalls = gql.calls.flat().filter((o) => o.operationName === 'DropCampaignDetails');
    expect(detailCalls.map(vars)).toEqual([{ channelLogin: '42', dropID: 'camp-rust' }]);
  });

  it('skips the detail requests when no campaign matches', async () => {
    const gql = fakeGql(campaignsHandler);
    await expect(new TwitchApi(gql, '42').getCampaigns(['999'])).resolves.toEqual([]);
    expect(gql.calls.flat().some((o) => o.operationName === 'DropCampaignDetails')).toBe(false);
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
