import type { PriorityGame } from '../config.js';
import type { GqlRequester, PersistedOp } from './gql.js';
import { parseAvailableCampaigns, parseCampaigns, parseDirectoryStream, parseStreamInfo } from './parse.js';
import type { Campaign, Game, LiveChannel, TwitchClient } from './types.js';

// Persisted query hashes, checked 2026-10-08 against DevilXD/TwitchDropsMiner (master 2026-09-26)
// and live public calls. When Twitch changes one, GqlOperationError names it. Update the hash here.
export const OPS = {
  Inventory: '8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404',
  ViewerDropsDashboard: 'c16bb890cc8ce7647a96ee69cd313d423a378a3dedadf630a1017cde18975feb',
  DropCampaignDetails: '039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1',
  DropsPage_ClaimDropRewards: 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930',
  PlaybackAccessToken: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
  DirectoryPage_Game: '86bcceb4e8b1a51256ff8eed8bd8aae4acacf80d737efe904f84f3aeadf8cafd',
  DirectoryGameRedirect: '1f0300090caceec51f33c5e20647aceff9017f740f223c3c532ba6fa59f6b6cc',
  VideoPlayerStreamInfoOverlayChannel: '198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d',
  DropsHighlightService_AvailableDrops: '782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20',
} as const;

export type OpName = keyof typeof OPS;

export function op(name: OpName, variables?: Record<string, unknown>): PersistedOp {
  return {
    operationName: name,
    ...(variables ? { variables } : {}),
    extensions: { persistedQuery: { version: 1, sha256Hash: OPS[name] } },
  };
}

const DETAILS_BATCH = 20;
const CHANNEL_LIMIT = 30;

function directoryVariables(slug: string, limit: number): Record<string, unknown> {
  return {
    limit,
    slug,
    imageWidth: 50,
    includeCostreaming: false,
    options: {
      broadcasterLanguages: [],
      freeformTags: null,
      includeRestricted: ['SUB_ONLY_LIVE'],
      recommendationsContext: { platform: 'web' },
      sort: 'VIEWER_COUNT',
      systemFilters: ['DROPS_ENABLED'],
      tags: [],
      requestID: 'JIRA-VXP-2397',
    },
    sortTypeIsRecency: false,
  };
}

export class TwitchApi implements TwitchClient {
  private readonly slugs = new Map<string, string | null>();

  constructor(private readonly gql: GqlRequester, private readonly userId: string) {}

  // Since ~2026-09-18 Twitch returns dropCampaigns: null to app clients, so campaigns come from three places:
  // the inventory (started ones, full data), the dashboard (in case it comes back), and live channels.
  async getCampaigns(games: Game[]): Promise<Campaign[]> {
    const gameIds = games.map((g) => g.id);
    const [inventoryRes, dashboardRes] = await this.gql.request([
      op('Inventory', { fetchRewardCampaigns: false }),
      op('ViewerDropsDashboard', { fetchRewardCampaigns: false }),
    ]);
    const inventory = inventoryRes?.data?.currentUser?.inventory ?? {};
    const started: any[] = (inventory.dropCampaignsInProgress ?? []).filter(
      (c: any) => c.status === 'ACTIVE' && c.game,
    );
    const summaries: any[] = (dashboardRes?.data?.currentUser?.dropCampaigns ?? []).filter(
      (c: any) => c.status === 'ACTIVE' && c.game && gameIds.includes(String(c.game.id)),
    );
    const details: any[] = [];
    for (let i = 0; i < summaries.length; i += DETAILS_BATCH) {
      const chunk = summaries.slice(i, i + DETAILS_BATCH);
      const responses: any[] = await this.gql.request(
        chunk.map((c) => op('DropCampaignDetails', { channelLogin: this.userId, dropID: c.id })),
      );
      for (const r of responses) {
        const detail = r?.data?.user?.dropCampaign;
        if (detail) details.push(detail);
      }
    }
    const byId = new Map<string, Campaign>();
    const sources = [
      await this.discover(games),
      parseCampaigns(summaries, details, inventory),
      parseCampaigns(started, [], inventory),
    ];
    for (const campaign of sources.flat()) byId.set(campaign.id, campaign); // later sources have better data
    return [...byId.values()];
  }

  private async discover(games: Game[]): Promise<Campaign[]> {
    const found = new Map<string, Campaign>();
    for (const game of games) {
      const slug = game.slug ?? (await this.slugFor(game.name));
      if (!slug) continue;
      const res = await this.gql.request(op('DirectoryPage_Game', directoryVariables(slug, CHANNEL_LIMIT)));
      const channels: LiveChannel[] = (res?.data?.game?.streams?.edges ?? [])
        .map((e: any) => e?.node)
        .filter((n: any) => n?.broadcaster)
        .map(parseDirectoryStream);
      for (let i = 0; i < channels.length; i += DETAILS_BATCH) {
        const chunk = channels.slice(i, i + DETAILS_BATCH);
        const responses: any[] = await this.gql.request(
          chunk.map((ch) => op('DropsHighlightService_AvailableDrops', { channelID: ch.id })),
        );
        responses.forEach((r, j) => {
          const raw = r?.data?.channel?.viewerDropCampaigns ?? [];
          for (const campaign of parseAvailableCampaigns(raw, chunk[j])) {
            if (campaign.game.id !== game.id) continue;
            const known = found.get(campaign.id);
            if (known) known.allowedChannels.push(...campaign.allowedChannels);
            else found.set(campaign.id, campaign);
          }
        });
      }
    }
    return [...found.values()];
  }

  async getLiveChannels(campaign: Campaign): Promise<LiveChannel[]> {
    let channels: LiveChannel[];
    if (campaign.allowedChannels.length > 0) {
      const responses: any[] = await this.gql.request(
        campaign.allowedChannels
          .slice(0, CHANNEL_LIMIT)
          .map((ch) => op('VideoPlayerStreamInfoOverlayChannel', { channel: ch.login })),
      );
      channels = responses
        .map((r) => parseStreamInfo(r?.data?.user))
        .filter((c): c is LiveChannel => c !== null && c.gameId === campaign.game.id);
    } else {
      const slug = campaign.game.slug ?? (await this.slugFor(campaign.game.name));
      if (!slug) return [];
      const res = await this.gql.request(op('DirectoryPage_Game', directoryVariables(slug, CHANNEL_LIMIT)));
      channels = (res?.data?.game?.streams?.edges ?? [])
        .map((e: any) => e?.node)
        .filter((n: any) => n?.broadcaster)
        .map(parseDirectoryStream);
    }
    return channels.sort((a, b) => b.viewers - a.viewers);
  }

  async getStreamInfo(login: string): Promise<LiveChannel | null> {
    const res = await this.gql.request(op('VideoPlayerStreamInfoOverlayChannel', { channel: login }));
    return parseStreamInfo(res?.data?.user);
  }

  async claimDrop(claimId: string): Promise<boolean> {
    const res = await this.gql.request(op('DropsPage_ClaimDropRewards', { input: { dropInstanceID: claimId } }));
    const status = res?.data?.claimDropRewards?.status;
    return status === 'ELIGIBLE_FOR_ALL' || status === 'DROP_INSTANCE_ALREADY_CLAIMED';
  }

  async resolveGame(name: string): Promise<PriorityGame | null> {
    const res = await this.gql.request(op('DirectoryGameRedirect', { name }));
    const game = res?.data?.game;
    if (!game?.slug) return null;
    const directory = await this.gql.request(op('DirectoryPage_Game', directoryVariables(game.slug, 1)));
    const displayName = directory?.data?.game?.displayName ?? directory?.data?.game?.name ?? name;
    return { id: String(game.id), name: displayName, slug: game.slug };
  }

  private async slugFor(name: string): Promise<string | null> {
    if (!this.slugs.has(name)) {
      const res = await this.gql.request(op('DirectoryGameRedirect', { name }));
      this.slugs.set(name, res?.data?.game?.slug ?? null);
    }
    return this.slugs.get(name) ?? null;
  }
}
