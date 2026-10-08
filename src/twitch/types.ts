export type Game = { id: string; name: string; slug: string | null };

export type Drop = {
  id: string;
  name: string;
  benefitNames: string[];
  requiredMinutes: number;
  currentMinutes: number;
  requiredSubs: number;
  claimed: boolean;
  claimId: string | null;
  startsAt: Date;
  endsAt: Date;
  preconditionIds: string[];
};

export type Campaign = {
  id: string;
  name: string;
  status: string;
  game: Game;
  linked: boolean;
  linkUrl: string;
  badgeOrEmoteOnly: boolean;
  /** Found on a live channel: Twitch did not say whether the game account is linked. */
  linkUnknown?: boolean;
  startsAt: Date;
  endsAt: Date;
  allowedChannels: { id: string; login: string }[];
  drops: Drop[];
};

export type LiveChannel = {
  id: string;
  login: string;
  displayName: string;
  viewers: number;
  broadcastId: string;
  gameId: string | null;
  gameName: string | null;
};

export type WatchTarget = {
  channelId: string;
  login: string;
  broadcastId: string;
  gameId: string;
  gameName: string;
};

export type WatchResult = { beacon: boolean; stream: boolean | null };

export interface TwitchClient {
  /** Active campaigns: started ones from the inventory plus ones found for these games. */
  getCampaigns(games: Game[]): Promise<Campaign[]>;
  getLiveChannels(campaign: Campaign): Promise<LiveChannel[]>;
  getStreamInfo(login: string): Promise<LiveChannel | null>;
  claimDrop(claimId: string): Promise<boolean>;
}

export interface Watcher {
  watch(target: WatchTarget): Promise<WatchResult>;
  reset(): void;
}
