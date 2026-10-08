# Twitch Drops Miner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight TypeScript CLI that mines Twitch Drops for the user's priority games, one campaign at a time, with a live Ink dashboard and no video playback.

**Architecture:**
- `miner.ts` is a timer-driven state machine. It is the only component that makes decisions.
- It talks to Twitch through a `TwitchClient` interface (`queries.ts` over `gql.ts`) and a `Watcher` interface (`watcher.ts`: spade beacon plus an HLS segment HEAD).
- It publishes plain `MinerState` snapshots, and the Ink UI only renders those.
- Pure selection rules live in `selection.ts`, and every raw Twitch JSON shape is read only in `parse.ts`.

**Tech Stack:** Node ≥ 22 (machine has 24.11), TypeScript (strict, ESM/NodeNext), ink + react, commander, vitest + ink-testing-library, tsx for dev runs.

**Spec:** `docs/superpowers/specs/2026-10-08-twitch-drops-miner-design.md`

## Global Constraints

- Data directory: `~/.twitch-drops-miner/` (overridable with env `TDM_HOME`) containing `config.json`, `auth.json`, `log.txt`.
- Mine only priority games, one channel at a time, and never decode or play video.
- Intervals: watch tick 60s; inventory/progress check 3 min; re-selection 15 min; idle re-check 5 min.
- Stall rule: no progress across 2 consecutive inventory checks means switch channel.
- Network retries: 5s, 15s, 60s inside a GQL call, then the miner waits 5 min before retrying.
- Dashboard shows the last 10 log entries, and every entry is also appended to `log.txt`.
- Twitch client ID `kd1unb4b3q4t58fwlpcbzcbnm76a8fp` (Android app), user agent `Dalvik/2.1.0 (Linux; U; Android 16; SM-S911B Build/TP1A.220624.014) tv.twitch.android.app/25.3.0/2503006`.
- ESM with `.js` suffixes on relative imports in `src/` (NodeNext). Tests import `../src/x.js` too, and vitest resolves these to `.ts`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A drop whose `name` is an empty string (Twitch really returns `""`) should be labelled by its reward names, never shown blank. Test in Task 2.
2. A campaign with `game: null` (channel-specific badge campaigns) is skipped and must not crash parsing. Test in Task 2.
3. The playback token is a JSON string with quotes and must be URL-encoded in the usher URL. Test in Task 6.
4. A missing or corrupt `config.json` or `auth.json` falls back to defaults or "not logged in" instead of crashing. Tests in Task 1 and Task 4.
5. `games add` for a game already in the list, or `games move` to an out-of-range position, gives a clear error and leaves the file unchanged. Tests in Task 1.

## File Map

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, README.md
src/config.ts            data dir, config.json load/save, priority list edits (pure)
src/auth.ts              device-code login, token validation, auth.json
src/twitch/errors.ts     AuthError, GqlOperationError, NetworkError
src/twitch/types.ts      domain types + TwitchClient/Watcher interfaces
src/twitch/parse.ts      raw Twitch JSON → domain types, dropLabel
src/twitch/gql.ts        GQL HTTP client with headers, retries, error typing
src/twitch/queries.ts    persisted query hashes + TwitchApi (implements TwitchClient)
src/twitch/watcher.ts    TwitchWatcher (implements Watcher)
src/selection.ts         pure eligibility/ranking/queue rules
src/miner.ts             Miner state machine
src/ui/format.ts         duration/viewers/progress-bar/clock formatting
src/ui/Header.tsx, CurrentTarget.tsx, Queue.tsx, EventLog.tsx, Dashboard.tsx
src/commands.ts          text output for list/games, log-file lines
src/cli.tsx              commander wiring
test/…                   one test file per module, fixtures in test/fixtures/
```

---

### Task 1: Project scaffold and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `type PriorityGame = { id: string; name: string; slug: string }`
  - `type Config = { priorityGames: PriorityGame[]; settings: { fetchStream: boolean } }`
  - `class ConfigError extends Error`
  - `dataDir(): string`
  - `readJson<T>(path: string): T | null`
  - `writeJson(path: string, value: unknown): void`
  - `loadConfig(dir?: string): Config`
  - `saveConfig(config: Config, dir?: string): void`
  - `addGame(config: Config, game: PriorityGame): Config`
  - `removeGame(config: Config, name: string): Config`
  - `moveGame(config: Config, name: string, position: number): Config`

- [ ] **Step 1: Create the project files**

The repo already exists at `C:\Users\Tim\projects\twitch-drops-miner` with the spec committed. Run all commands from that folder.

`package.json`:
```json
{
  "name": "twitch-drops-miner",
  "version": "0.1.0",
  "private": true,
  "description": "Lightweight Twitch drops miner for the terminal",
  "type": "module",
  "bin": { "drops": "dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.tsx",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
```

`.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install commander ink react
npm install -D typescript tsx vitest ink-testing-library @types/react @types/node
```
Expected: installs without errors, and `package.json` gains `dependencies` and `devDependencies`.

- [ ] **Step 3: Write the failing config tests**

`test/config.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addGame, ConfigError, loadConfig, moveGame, removeGame, saveConfig, type Config,
} from '../src/config.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'tdm-config-'));
const rust = { id: '263490', name: 'Rust', slug: 'rust' };
const rivals = { id: '1264310518', name: 'Marvel Rivals', slug: 'marvel-rivals' };
const apex = { id: '511224', name: 'Apex Legends', slug: 'apex-legends' };
const withGames = (...games: Config['priorityGames']): Config => ({
  priorityGames: games, settings: { fetchStream: true },
});

describe('loadConfig / saveConfig', () => {
  it('returns defaults when the file is missing', () => {
    expect(loadConfig(tmp())).toEqual({ priorityGames: [], settings: { fetchStream: true } });
  });

  it('returns defaults when the file is corrupt', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.json'), '{ not json');
    expect(loadConfig(dir)).toEqual({ priorityGames: [], settings: { fetchStream: true } });
  });

  it('round-trips and fills missing settings', () => {
    const dir = tmp();
    saveConfig(withGames(rust), dir);
    expect(loadConfig(dir)).toEqual(withGames(rust));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ priorityGames: [rust] }));
    expect(loadConfig(dir).settings.fetchStream).toBe(true);
  });
});

describe('priority list edits', () => {
  it('adds a game to the end', () => {
    expect(addGame(withGames(rust), rivals).priorityGames).toEqual([rust, rivals]);
  });

  it('rejects a duplicate game', () => {
    expect(() => addGame(withGames(rust), rust)).toThrow(ConfigError);
  });

  it('removes a game by name, case-insensitively', () => {
    expect(removeGame(withGames(rust, rivals), 'marvel rivals').priorityGames).toEqual([rust]);
  });

  it('errors when removing an unknown game', () => {
    expect(() => removeGame(withGames(rust), 'Apex Legends')).toThrow(/not in the priority list/);
  });

  it('moves a game to a 1-based position', () => {
    expect(moveGame(withGames(rust, rivals, apex), 'Apex Legends', 1).priorityGames)
      .toEqual([apex, rust, rivals]);
  });

  it('rejects out-of-range positions and leaves the input untouched', () => {
    const config = withGames(rust, rivals);
    expect(() => moveGame(config, 'Rust', 3)).toThrow(/between 1 and 2/);
    expect(() => moveGame(config, 'Rust', 0)).toThrow(ConfigError);
    expect(config.priorityGames).toEqual([rust, rivals]);
  });
});
```

- [ ] **Step 4: Run the tests to make sure they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, because `../src/config.js` cannot be resolved.

- [ ] **Step 5: Implement `src/config.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type PriorityGame = { id: string; name: string; slug: string };
export type Settings = { fetchStream: boolean };
export type Config = { priorityGames: PriorityGame[]; settings: Settings };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_SETTINGS: Settings = { fetchStream: true };

export function dataDir(): string {
  return process.env.TDM_HOME ?? join(homedir(), '.twitch-drops-miner');
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function loadConfig(dir = dataDir()): Config {
  const raw = readJson<Partial<Config>>(join(dir, 'config.json'));
  const games = raw?.priorityGames;
  return {
    priorityGames: Array.isArray(games) ? games : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) },
  };
}

export function saveConfig(config: Config, dir = dataDir()): void {
  writeJson(join(dir, 'config.json'), config);
}

function indexOfGame(config: Config, name: string): number {
  const wanted = name.trim().toLowerCase();
  return config.priorityGames.findIndex((g) => g.name.toLowerCase() === wanted || g.slug === wanted);
}

export function addGame(config: Config, game: PriorityGame): Config {
  if (config.priorityGames.some((g) => g.id === game.id)) {
    throw new ConfigError(`${game.name} is already in the priority list`);
  }
  return { ...config, priorityGames: [...config.priorityGames, game] };
}

export function removeGame(config: Config, name: string): Config {
  const index = indexOfGame(config, name);
  if (index === -1) throw new ConfigError(`${name} is not in the priority list`);
  return { ...config, priorityGames: config.priorityGames.filter((_, i) => i !== index) };
}

export function moveGame(config: Config, name: string, position: number): Config {
  const index = indexOfGame(config, name);
  if (index === -1) throw new ConfigError(`${name} is not in the priority list`);
  const count = config.priorityGames.length;
  if (!Number.isInteger(position) || position < 1 || position > count) {
    throw new ConfigError(`Position must be between 1 and ${count}`);
  }
  const games = [...config.priorityGames];
  const [game] = games.splice(index, 1);
  games.splice(position - 1, 0, game);
  return { ...config, priorityGames: games };
}
```

- [ ] **Step 6: Run the tests to make sure they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold project and add config storage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Domain types, errors and Twitch response parsing

**Files:**
- Create: `src/twitch/types.ts`, `src/twitch/errors.ts`, `src/twitch/parse.ts`
- Create: `test/fixtures/dashboard.json`, `test/fixtures/details.json`, `test/fixtures/inventory.json`, `test/fixtures/directory.json`, `test/fixtures/streaminfo.json`
- Test: `test/parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, in `types.ts`:
  ```ts
  type Game = { id: string; name: string; slug: string | null }
  type Drop = { id: string; name: string; benefitNames: string[]; requiredMinutes: number; currentMinutes: number;
                requiredSubs: number; claimed: boolean; claimId: string | null; startsAt: Date; endsAt: Date; preconditionIds: string[] }
  type Campaign = { id: string; name: string; status: string; game: Game; linked: boolean; linkUrl: string;
                    badgeOrEmoteOnly: boolean; startsAt: Date; endsAt: Date; allowedChannels: { id: string; login: string }[]; drops: Drop[] }
  type LiveChannel = { id: string; login: string; displayName: string; viewers: number; broadcastId: string; gameId: string | null; gameName: string | null }
  type WatchTarget = { channelId: string; login: string; broadcastId: string; gameId: string; gameName: string }
  type WatchResult = { beacon: boolean; stream: boolean | null }
  interface TwitchClient { getCampaigns(gameIds?: string[]): Promise<Campaign[]>; getLiveChannels(campaign: Campaign): Promise<LiveChannel[]>;
                           getStreamInfo(login: string): Promise<LiveChannel | null>; claimDrop(claimId: string): Promise<boolean> }
  interface Watcher { watch(target: WatchTarget): Promise<WatchResult>; reset(): void }
  ```
- Produces, in `errors.ts`: `AuthError`, `GqlOperationError(operation: string, detail: string)` with a `.operation` field, and `NetworkError(detail: string)`.
- Produces, in `parse.ts`:
  - `parseCampaigns(dashboard: any[], details: any[], inventory: any): Campaign[]`
  - `parseDirectoryStream(node: any): LiveChannel`
  - `parseStreamInfo(user: any): LiveChannel | null`
  - `dropLabel(drop: Drop): string`

- [ ] **Step 1: Create the types and errors (no behaviour to test)**

`src/twitch/types.ts`:
```ts
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
  getCampaigns(gameIds?: string[]): Promise<Campaign[]>;
  getLiveChannels(campaign: Campaign): Promise<LiveChannel[]>;
  getStreamInfo(login: string): Promise<LiveChannel | null>;
  claimDrop(claimId: string): Promise<boolean>;
}

export interface Watcher {
  watch(target: WatchTarget): Promise<WatchResult>;
  reset(): void;
}
```

`src/twitch/errors.ts`:
```ts
export class AuthError extends Error {
  constructor(message = 'Twitch login is invalid or expired') {
    super(message);
    this.name = 'AuthError';
  }
}

export class GqlOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`Twitch API changed: ${operation} failed (${detail})`);
    this.name = 'GqlOperationError';
    this.operation = operation;
  }
}

export class NetworkError extends Error {
  constructor(detail: string) {
    super(`Network error: ${detail}`);
    this.name = 'NetworkError';
  }
}
```

- [ ] **Step 2: Create the fixtures**

These match the shapes Twitch returns. They are taken from TwitchDropsMiner's parser and a live public response from 2026-10-08. Task 11 checks them against real logged-in responses.

`test/fixtures/dashboard.json` (contents of `data.currentUser.dropCampaigns`):
```json
[
  {
    "id": "camp-rust",
    "name": "Rust Drops Round 42",
    "status": "ACTIVE",
    "startAt": "2026-10-01T00:00:00Z",
    "endAt": "2026-10-12T00:00:00Z",
    "accountLinkURL": "https://example.com/link-rust",
    "self": { "isAccountConnected": true },
    "game": { "id": "263490", "name": "Rust", "displayName": "Rust", "slug": "rust", "boxArtURL": "" }
  },
  {
    "id": "camp-channel-badge",
    "name": "SPOOKY SEASON",
    "status": "ACTIVE",
    "startAt": "2026-10-08T09:32:51.5Z",
    "endAt": "2026-10-30T23:00:00Z",
    "accountLinkURL": "",
    "self": { "isAccountConnected": false },
    "game": null
  }
]
```

`test/fixtures/details.json` (a list of `data.user.dropCampaign` objects):
```json
[
  {
    "id": "camp-rust",
    "allow": { "isEnabled": true, "channels": null },
    "self": { "isAccountConnected": true },
    "timeBasedDrops": [
      {
        "id": "drop-hoodie", "name": "",
        "startAt": "2026-10-01T00:00:00Z", "endAt": "2026-10-12T00:00:00Z",
        "requiredMinutesWatched": 60, "requiredSubs": 0, "preconditionDrops": null,
        "benefitEdges": [{ "benefit": { "id": "ben-hoodie", "name": "Hoodie", "distributionType": "DIRECT_ENTITLEMENT", "imageAssetURL": "" } }]
      },
      {
        "id": "drop-door", "name": "Door Skin Drop",
        "startAt": "2026-10-01T00:00:00Z", "endAt": "2026-10-12T00:00:00Z",
        "requiredMinutesWatched": 120, "requiredSubs": 0, "preconditionDrops": [{ "id": "drop-hoodie" }],
        "benefitEdges": [{ "benefit": { "id": "ben-door", "name": "Door Skin", "distributionType": "DIRECT_ENTITLEMENT", "imageAssetURL": "" } }]
      },
      {
        "id": "drop-bandana", "name": "Bandana Drop",
        "startAt": "2026-10-01T00:00:00Z", "endAt": "2026-10-12T00:00:00Z",
        "requiredMinutesWatched": 30, "requiredSubs": 0, "preconditionDrops": null,
        "benefitEdges": [{ "benefit": { "id": "ben-bandana", "name": "Bandana", "distributionType": "DIRECT_ENTITLEMENT", "imageAssetURL": "" } }]
      },
      {
        "id": "drop-sub", "name": "Sub Badge",
        "startAt": "2026-10-08T09:32:51.5Z", "endAt": "2026-10-12T00:00:00Z",
        "requiredMinutesWatched": 0, "requiredSubs": 5, "preconditionDrops": null,
        "benefitEdges": [{ "benefit": { "id": "ben-sub", "name": "Sub Badge", "distributionType": "BADGE", "imageAssetURL": "" } }]
      }
    ]
  }
]
```

`test/fixtures/inventory.json` (contents of `data.currentUser.inventory`):
```json
{
  "dropCampaignsInProgress": [
    {
      "id": "camp-rust",
      "timeBasedDrops": [
        { "id": "drop-hoodie", "self": { "currentMinutesWatched": 42, "dropInstanceID": null, "isClaimed": false } }
      ]
    }
  ],
  "gameEventDrops": [
    { "id": "ben-bandana", "lastAwardedAt": "2026-10-05T10:00:00.5Z" }
  ]
}
```

`test/fixtures/directory.json` (the full `DirectoryPage_Game` response):
```json
{
  "data": {
    "game": {
      "id": "263490", "name": "Rust", "displayName": "Rust",
      "streams": {
        "edges": [
          { "node": { "id": "321716771929", "title": "COWS TODAY???", "viewersCount": 18,
            "broadcaster": { "id": "615893742", "login": "hope22_", "displayName": "Hope22_" },
            "game": { "id": "263490", "name": "Rust", "displayName": "Rust", "slug": "rust" } } },
          { "node": { "id": "317066421972", "title": "SOLO", "viewersCount": 1132,
            "broadcaster": { "id": "135377687", "login": "posty", "displayName": "Posty" },
            "game": { "id": "263490", "name": "Rust", "displayName": "Rust", "slug": "rust" } } },
          { "node": { "id": "1", "title": "ghost", "viewersCount": 5000, "broadcaster": null,
            "game": { "id": "263490", "name": "Rust", "displayName": "Rust", "slug": "rust" } } }
        ]
      }
    }
  }
}
```

`test/fixtures/streaminfo.json` (two `data.user` objects from `VideoPlayerStreamInfoOverlayChannel`):
```json
{
  "live": {
    "id": "135377687", "login": "posty", "displayName": "Posty",
    "broadcastSettings": { "id": "135377687", "title": "SOLO", "game": { "id": "263490", "name": "Rust", "displayName": "Rust", "slug": "rust" } },
    "stream": { "id": "317066421972", "viewersCount": 1132, "tags": [] }
  },
  "offline": {
    "id": "37402112", "login": "shroud", "displayName": "shroud",
    "broadcastSettings": { "id": "37402112", "title": "", "game": { "id": "771448419", "name": "AION 2", "displayName": "AION 2", "slug": "aion-2" } },
    "stream": null
  }
}
```

- [ ] **Step 3: Write the failing parse tests**

`test/parse.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dropLabel, parseCampaigns, parseDirectoryStream, parseStreamInfo } from '../src/twitch/parse.js';

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
```

- [ ] **Step 4: Run the tests to make sure they fail**

Run: `npx vitest run test/parse.test.ts`
Expected: FAIL, because `../src/twitch/parse.js` cannot be resolved.

- [ ] **Step 5: Implement `src/twitch/parse.ts`**

```ts
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
```

- [ ] **Step 6: Run the tests to make sure they pass**

Run: `npx vitest run test/parse.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add domain types and Twitch response parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: GQL client

**Files:**
- Create: `src/twitch/gql.ts`
- Test: `test/gql.test.ts`

**Interfaces:**
- Consumes: `AuthError`, `GqlOperationError`, `NetworkError` from `src/twitch/errors.ts`.
- Produces:
  - `type PersistedOp = { operationName: string; variables?: Record<string, unknown>; extensions: { persistedQuery: { version: 1; sha256Hash: string } } }`
  - `interface GqlRequester { request(ops: PersistedOp | PersistedOp[]): Promise<any> }`
  - `type GqlOptions = { token: string; clientId: string; deviceId: string; userAgent: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; retryDelaysMs?: number[] }`
  - `class GqlClient implements GqlRequester` (constructor takes `GqlOptions`)
  - `randomHex(length: number): string`
  - `DEFAULT_RETRY_DELAYS_MS = [5000, 15000, 60000]`

- [ ] **Step 1: Write the failing tests**

`test/gql.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { AuthError, GqlOperationError, NetworkError } from '../src/twitch/errors.js';
import { GqlClient, randomHex, type PersistedOp } from '../src/twitch/gql.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const op: PersistedOp = {
  operationName: 'Inventory',
  extensions: { persistedQuery: { version: 1, sha256Hash: 'hash' } },
};

function setup(responses: Array<Response | Error>) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const gql = new GqlClient({
    token: 'tok', clientId: 'cid', deviceId: 'dev', userAgent: 'ua',
    fetch: fetch as unknown as typeof globalThis.fetch, sleep,
  });
  return { gql, fetch, sleep };
}

describe('GqlClient', () => {
  it('posts the operation with auth headers and returns the body', async () => {
    const { gql, fetch } = setup([json({ data: { ok: 1 } })]);
    await expect(gql.request(op)).resolves.toEqual({ data: { ok: 1 } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://gql.twitch.tv/gql');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('OAuth tok');
    expect(headers['Client-Id']).toBe('cid');
    expect(headers['X-Device-Id']).toBe('dev');
    expect(headers['User-Agent']).toBe('ua');
    expect(JSON.parse(init!.body as string)).toEqual(op);
  });

  it('returns batched responses as an array', async () => {
    const { gql } = setup([json([{ data: { a: 1 } }, { data: { b: 2 } }])]);
    await expect(gql.request([op, op])).resolves.toEqual([{ data: { a: 1 } }, { data: { b: 2 } }]);
  });

  it('throws AuthError on HTTP 401', async () => {
    const { gql } = setup([json({ error: 'Unauthorized', status: 401, message: 'bad token' }, 401)]);
    await expect(gql.request(op)).rejects.toBeInstanceOf(AuthError);
  });

  it('retries network failures and 5xx with backoff', async () => {
    const { gql, sleep } = setup([new Error('ECONNRESET'), json({}, 503), json({ data: { ok: 1 } })]);
    await expect(gql.request(op)).resolves.toEqual({ data: { ok: 1 } });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 15000]);
  });

  it('gives up with NetworkError after all retries', async () => {
    const { gql, sleep } = setup([new Error('a'), new Error('b'), new Error('c'), new Error('d')]);
    await expect(gql.request(op)).rejects.toBeInstanceOf(NetworkError);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('retries transient GQL errors', async () => {
    const { gql } = setup([json({ errors: [{ message: 'service timeout' }] }), json({ data: { ok: 1 } })]);
    await expect(gql.request(op)).resolves.toEqual({ data: { ok: 1 } });
  });

  it('retries PersistedQueryNotFound once, then reports the operation as changed', async () => {
    const notFound = () => json({
      errors: [{ message: 'PersistedQueryNotFound' }], extensions: { operationName: 'Inventory' },
    });
    const { gql, sleep } = setup([notFound(), notFound()]);
    const error = await gql.request(op).catch((e) => e);
    expect(error).toBeInstanceOf(GqlOperationError);
    expect(error.operation).toBe('Inventory');
    expect(error.message).toContain('Twitch API changed: Inventory');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('turns other error bodies into GqlOperationError', async () => {
    const { gql } = setup([json({ error: 'Bad Request', status: 400, message: 'nope' }, 400)]);
    await expect(gql.request(op)).rejects.toBeInstanceOf(GqlOperationError);
  });

  it('tolerates partial "server error" responses', async () => {
    const { gql } = setup([json({ data: { x: null }, errors: [{ message: 'server error', path: ['x'] }] })]);
    await expect(gql.request(op)).resolves.toEqual({
      data: { x: null }, errors: [{ message: 'server error', path: ['x'] }],
    });
  });
});

describe('randomHex', () => {
  it('returns lowercase hex of the requested length', () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(15)).toMatch(/^[0-9a-f]{15}$/);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run test/gql.test.ts`
Expected: FAIL, because `../src/twitch/gql.js` cannot be resolved.

- [ ] **Step 3: Implement `src/twitch/gql.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { AuthError, GqlOperationError, NetworkError } from './errors.js';

export type PersistedOp = {
  operationName: string;
  variables?: Record<string, unknown>;
  extensions: { persistedQuery: { version: 1; sha256Hash: string } };
};

export interface GqlRequester {
  request(ops: PersistedOp | PersistedOp[]): Promise<any>;
}

export type GqlOptions = {
  token: string;
  clientId: string;
  deviceId: string;
  userAgent: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
};

const GQL_URL = 'https://gql.twitch.tv/gql';
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

// Messages Twitch returns for hiccups that succeed on retry.
const TRANSIENT = new Set([
  'service error',
  'service timeout',
  'service unavailable',
  'context deadline exceeded',
  'request cancelled',
]);

export function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

export class GqlClient implements GqlRequester {
  private readonly sessionId = randomHex(16);

  constructor(private readonly opts: GqlOptions) {}

  async request(ops: PersistedOp | PersistedOp[]): Promise<any> {
    const http = this.opts.fetch ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const delays = this.opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const names = (Array.isArray(ops) ? ops : [ops]).map((o) => o.operationName).join(', ');
    let problem = 'unknown error';

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1]);
      let res: Response;
      try {
        res = await http(GQL_URL, { method: 'POST', headers: this.headers(), body: JSON.stringify(ops) });
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (res.status === 401) throw new AuthError();
      if (res.status >= 500) {
        problem = `HTTP ${res.status}`;
        continue;
      }
      let body: any;
      try {
        body = await res.json();
      } catch {
        problem = `HTTP ${res.status} with a non-JSON body`;
        continue;
      }
      const retryReason = this.check(Array.isArray(body) ? body : [body], names, attempt);
      if (retryReason) {
        problem = retryReason;
        continue;
      }
      return body;
    }
    throw new NetworkError(`${names}: ${problem}`);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'Accept-Language': 'en-US',
      Authorization: `OAuth ${this.opts.token}`,
      'Client-Id': this.opts.clientId,
      'Client-Session-Id': this.sessionId,
      'X-Device-Id': this.opts.deviceId,
      'User-Agent': this.opts.userAgent,
      Origin: 'https://www.twitch.tv',
      Referer: 'https://www.twitch.tv/',
    };
  }

  /** Throws on fatal errors, returns a reason when the request should be retried, null when OK. */
  private check(items: any[], names: string, attempt: number): string | null {
    for (const item of items) {
      const operation: string = item?.extensions?.operationName ?? names;
      if (item?.error) {
        if (item.status === 401) throw new AuthError();
        throw new GqlOperationError(operation, `${item.error}: ${item.message ?? ''}`);
      }
      for (const e of item?.errors ?? []) {
        const message = String(e?.message ?? 'unknown error');
        if (TRANSIENT.has(message)) return message;
        if (message === 'PersistedQueryNotFound' && attempt === 0) return message;
        if (message === 'server error') continue; // partial data; parse.ts tolerates nulls
        throw new GqlOperationError(operation, message);
      }
    }
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run test/gql.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Twitch GQL client with retries and typed errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Device-code login and session storage

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `dataDir`, `readJson`, `writeJson` from `src/config.ts`.
- Produces:
  - `CLIENT_ID: string`, `USER_AGENT: string`
  - `type Session = { token: string; userId: string; login: string; deviceId: string }`
  - `type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; intervalSec: number; expiresAt: number }`
  - `startDeviceLogin(deviceId: string, http?: typeof fetch): Promise<DeviceCode>`
  - `pollForToken(code: DeviceCode, deviceId: string, http?: typeof fetch, sleep?: (ms: number) => Promise<void>): Promise<string>`
  - `validateToken(token: string, http?: typeof fetch): Promise<{ userId: string; login: string } | null>`
  - `loadSession(dir?: string): Session | null`
  - `saveSession(session: Session, dir?: string): void`

- [ ] **Step 1: Write the failing tests**

`test/auth.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID, loadSession, pollForToken, saveSession, startDeviceLogin, validateToken, type DeviceCode,
} from '../src/auth.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mockFetch = (...responses: Response[]) => {
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => responses.shift()!);
  return { fn, http: fn as unknown as typeof fetch };
};
const tmp = () => mkdtempSync(join(tmpdir(), 'tdm-auth-'));

describe('device login', () => {
  it('requests a device code with our client id', async () => {
    const { fn, http } = mockFetch(json({
      device_code: 'dc', user_code: 'ABCDEFGH', interval: 5, expires_in: 1800,
      verification_uri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH',
    }));
    const code = await startDeviceLogin('dev', http);
    expect(code).toMatchObject({
      deviceCode: 'dc', userCode: 'ABCDEFGH', intervalSec: 5,
      verificationUri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH',
    });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('https://id.twitch.tv/oauth2/device');
    expect(new URLSearchParams(String(init!.body)).get('client_id')).toBe(CLIENT_ID);
    expect((init!.headers as Record<string, string>)['X-Device-Id']).toBe('dev');
  });

  it('polls until the user approves', async () => {
    const { http } = mockFetch(
      json({ status: 400, message: 'authorization_pending' }, 400),
      json({ access_token: 'tok', token_type: 'bearer' }),
    );
    const sleep = vi.fn(async (_ms: number) => {});
    const code: DeviceCode = {
      deviceCode: 'dc', userCode: 'X', verificationUri: 'u', intervalSec: 5, expiresAt: Date.now() + 60_000,
    };
    await expect(pollForToken(code, 'dev', http, sleep)).resolves.toBe('tok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 5000]);
  });

  it('gives up when the code expires', async () => {
    const { http } = mockFetch();
    const code: DeviceCode = {
      deviceCode: 'dc', userCode: 'X', verificationUri: 'u', intervalSec: 5, expiresAt: Date.now() - 1,
    };
    await expect(pollForToken(code, 'dev', http, async () => {})).rejects.toThrow(/expired/);
  });
});

describe('validateToken', () => {
  it('returns the user for a valid token from our client', async () => {
    const { fn, http } = mockFetch(json({ client_id: CLIENT_ID, login: 'me', user_id: '123' }));
    await expect(validateToken('tok', http)).resolves.toEqual({ userId: '123', login: 'me' });
    expect((fn.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('OAuth tok');
  });

  it('returns null for an invalid token', async () => {
    const { http } = mockFetch(json({ status: 401, message: 'invalid access token' }, 401));
    await expect(validateToken('tok', http)).resolves.toBeNull();
  });

  it('returns null for a token issued to another client', async () => {
    const { http } = mockFetch(json({ client_id: 'other', login: 'me', user_id: '123' }));
    await expect(validateToken('tok', http)).resolves.toBeNull();
  });
});

describe('session storage', () => {
  it('round-trips a session', () => {
    const dir = tmp();
    const session = { token: 'tok', userId: '123', login: 'me', deviceId: 'dev' };
    saveSession(session, dir);
    expect(loadSession(dir)).toEqual(session);
  });

  it('returns null when auth.json is missing, corrupt or incomplete', () => {
    const dir = tmp();
    expect(loadSession(dir)).toBeNull();
    writeFileSync(join(dir, 'auth.json'), 'garbage');
    expect(loadSession(dir)).toBeNull();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ token: 'tok' }));
    expect(loadSession(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL, because `../src/auth.js` cannot be resolved.

- [ ] **Step 3: Implement `src/auth.ts`**

```ts
import { join } from 'node:path';
import { dataDir, readJson, writeJson } from './config.js';

// Twitch Android app client. The device-code login and every GQL call must use the same ID.
export const CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';
export const USER_AGENT =
  'Dalvik/2.1.0 (Linux; U; Android 16; SM-S911B Build/TP1A.220624.014) tv.twitch.android.app/25.3.0/2503006';

export type Session = { token: string; userId: string; login: string; deviceId: string };

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  expiresAt: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function idHeaders(deviceId: string): Record<string, string> {
  return {
    'Client-Id': CLIENT_ID,
    'User-Agent': USER_AGENT,
    'X-Device-Id': deviceId,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://www.twitch.tv',
    Referer: 'https://www.twitch.tv/',
  };
}

export async function startDeviceLogin(deviceId: string, http: typeof fetch = fetch): Promise<DeviceCode> {
  const res = await http('https://id.twitch.tv/oauth2/device', {
    method: 'POST',
    headers: idHeaders(deviceId),
    body: new URLSearchParams({ client_id: CLIENT_ID, scopes: '' }).toString(),
  });
  if (!res.ok) throw new Error(`Twitch login could not start (HTTP ${res.status})`);
  const body = await res.json();
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    intervalSec: body.interval,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

export async function pollForToken(
  code: DeviceCode,
  deviceId: string,
  http: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<string> {
  while (Date.now() < code.expiresAt) {
    await sleep(code.intervalSec * 1000);
    const res = await http('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: idHeaders(deviceId),
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    // 400 means the user hasn't entered the code yet.
    if (res.status === 200) return (await res.json()).access_token;
  }
  throw new Error('The login code expired. Run `drops login` again.');
}

export async function validateToken(
  token: string,
  http: typeof fetch = fetch,
): Promise<{ userId: string; login: string } | null> {
  const res = await http('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not check the Twitch login (HTTP ${res.status})`);
  const body = await res.json();
  if (body.client_id !== CLIENT_ID) return null;
  return { userId: String(body.user_id), login: body.login };
}

export function loadSession(dir = dataDir()): Session | null {
  const raw = readJson<Partial<Session>>(join(dir, 'auth.json'));
  if (!raw) return null;
  const { token, userId, login, deviceId } = raw;
  if ([token, userId, login, deviceId].some((v) => typeof v !== 'string' || v === '')) return null;
  return { token, userId, login, deviceId } as Session;
}

export function saveSession(session: Session, dir = dataDir()): void {
  writeJson(join(dir, 'auth.json'), session);
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run test/auth.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Twitch device-code login and session storage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Twitch queries (TwitchApi)

**Files:**
- Create: `src/twitch/queries.ts`
- Test: `test/queries.test.ts`

**Interfaces:**
- Consumes:
  - `PersistedOp`, `GqlRequester` from `gql.ts`
  - `parseCampaigns`, `parseDirectoryStream`, `parseStreamInfo` from `parse.ts`
  - `Campaign`, `LiveChannel`, `TwitchClient` from `types.ts`
  - `PriorityGame` from `config.ts`
- Produces:
  - `OPS: Record<OpName, string>` (operation name → sha256)
  - `type OpName`
  - `op(name: OpName, variables?: Record<string, unknown>): PersistedOp`
  - `class TwitchApi implements TwitchClient`, built with `new TwitchApi(gql: GqlRequester, userId: string)`. Besides the `TwitchClient` methods, it has `resolveGame(name: string): Promise<PriorityGame | null>`.

- [ ] **Step 1: Write the failing tests**

`test/queries.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run test/queries.test.ts`
Expected: FAIL, because `../src/twitch/queries.js` cannot be resolved.

- [ ] **Step 3: Implement `src/twitch/queries.ts`**

```ts
import type { PriorityGame } from '../config.js';
import type { GqlRequester, PersistedOp } from './gql.js';
import { parseCampaigns, parseDirectoryStream, parseStreamInfo } from './parse.js';
import type { Campaign, LiveChannel, TwitchClient } from './types.js';

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

  async getCampaigns(gameIds?: string[]): Promise<Campaign[]> {
    const [inventoryRes, dashboardRes] = await this.gql.request([
      op('Inventory', { fetchRewardCampaigns: false }),
      op('ViewerDropsDashboard', { fetchRewardCampaigns: false }),
    ]);
    const inventory = inventoryRes?.data?.currentUser?.inventory ?? {};
    const summaries: any[] = (dashboardRes?.data?.currentUser?.dropCampaigns ?? []).filter(
      (c: any) => c.status === 'ACTIVE' && c.game && (!gameIds || gameIds.includes(String(c.game.id))),
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
    return parseCampaigns(summaries, details, inventory);
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
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run test/queries.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Twitch API queries for campaigns, channels and claims

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Watcher (minute-watched beacon and stream segment HEAD)

**Files:**
- Create: `src/twitch/watcher.ts`
- Test: `test/watcher.test.ts`

**Interfaces:**
- Consumes:
  - `GqlRequester` from `gql.ts`
  - `op` from `queries.ts`
  - `Watcher`, `WatchTarget`, `WatchResult` from `types.ts`
- Produces:
  - `buildSpadeBody(target: WatchTarget, userId: string): string` (form-encoded `data=<base64>`)
  - `usherUrl(login: string, signature: string, token: string): string`
  - `lastMediaLine(playlist: string): string | null`
  - `class TwitchWatcher implements Watcher`, built with `new TwitchWatcher({ userId, gql, userAgent, fetchStream: () => boolean, fetch? })`

- [ ] **Step 1: Write the failing tests**

`test/watcher.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { PersistedOp } from '../src/twitch/gql.js';
import type { WatchTarget } from '../src/twitch/types.js';
import { buildSpadeBody, lastMediaLine, TwitchWatcher, usherUrl } from '../src/twitch/watcher.js';

const target: WatchTarget = {
  channelId: '135377687', login: 'posty', broadcastId: '317066421972', gameId: '263490', gameName: 'Rust',
};

function routes(map: Record<string, () => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(map).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected request ${url}`);
    return map[key]();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const spadeRoutes = {
  'https://www.twitch.tv/posty': () =>
    new Response('<script src="https://assets.twitch.tv/config/settings.0123456789abcdef0123456789abcdef.js"></script>'),
  'https://assets.twitch.tv/config/settings.': () => new Response('{"spade_url":"https://spade.example/track"}'),
  'https://spade.example/track': () => new Response(null, { status: 204 }),
};

const noGql = { request: async () => { throw new Error('gql not expected'); } };

describe('buildSpadeBody', () => {
  it('encodes a minute-watched event as base64 form data', () => {
    const data = new URLSearchParams(buildSpadeBody(target, '42')).get('data')!;
    const [event] = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    expect(event.event).toBe('minute-watched');
    expect(event.properties).toMatchObject({
      broadcast_id: '317066421972', channel_id: '135377687', channel: 'posty',
      game: 'Rust', game_id: '263490', user_id: 42, minutes_logged: 1, live: true, logged_in: true,
    });
  });
});

describe('usherUrl', () => {
  it('URL-encodes the JSON playback token', () => {
    const token = '{"channel":"posty","expires":1 }';
    const url = usherUrl('posty', 'sig123', token);
    expect(url.startsWith('https://usher.ttvnw.net/api/channel/hls/posty.m3u8?')).toBe(true);
    expect(url).not.toContain('"');
    expect(new URL(url).searchParams.get('token')).toBe(token);
    expect(new URL(url).searchParams.get('sig')).toBe('sig123');
  });
});

describe('lastMediaLine', () => {
  it('returns the last non-comment line', () => {
    expect(lastMediaLine('#EXTM3U\n#EXTINF:2,\nhttps://a/1.ts\n#EXTINF:2,\nhttps://a/2.ts\n')).toBe('https://a/2.ts');
    expect(lastMediaLine('#EXTM3U\n')).toBeNull();
  });
});

describe('TwitchWatcher', () => {
  it('finds the spade URL once and sends the beacon', async () => {
    const { fetch, calls } = routes(spadeRoutes);
    const watcher = new TwitchWatcher({ userId: '42', gql: noGql, userAgent: 'ua', fetchStream: () => false, fetch });
    await expect(watcher.watch(target)).resolves.toEqual({ beacon: true, stream: null });
    await watcher.watch(target);
    expect(calls.filter((c) => c.url.startsWith('https://www.twitch.tv/')).length).toBe(1);
    const posts = calls.filter((c) => c.url === 'https://spade.example/track');
    expect(posts).toHaveLength(2);
    expect(posts[0].init!.method).toBe('POST');
    expect((posts[0].init!.headers as Record<string, string>)['User-Agent']).toBe('ua');
  });

  it('reports a failed beacon without throwing', async () => {
    const { fetch } = routes({ ...spadeRoutes, 'https://spade.example/track': () => new Response('no', { status: 400 }) });
    const watcher = new TwitchWatcher({ userId: '42', gql: noGql, userAgent: 'ua', fetchStream: () => false, fetch });
    await expect(watcher.watch(target)).resolves.toEqual({ beacon: false, stream: null });
  });

  it('HEADs the newest segment of the lowest-quality stream', async () => {
    const { fetch, calls } = routes({
      ...spadeRoutes,
      'https://usher.ttvnw.net/': () => new Response(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000\nhttps://video.example/720p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nhttps://video.example/160p.m3u8\n'),
      'https://video.example/160p.m3u8': () => new Response(
        '#EXTM3U\n#EXTINF:2.0,\nhttps://video.example/seg1.ts\n#EXTINF:2.0,\nhttps://video.example/seg2.ts\n'),
      'https://video.example/seg2.ts': () => new Response(null, { status: 200 }),
    });
    const gqlCalls: PersistedOp[] = [];
    const gql = {
      request: async (o: PersistedOp | PersistedOp[]) => {
        gqlCalls.push(o as PersistedOp);
        return { data: { streamPlaybackAccessToken: { value: '{"channel":"posty"}', signature: 'sig123' } } };
      },
    };
    const watcher = new TwitchWatcher({ userId: '42', gql, userAgent: 'ua', fetchStream: () => true, fetch });
    await expect(watcher.watch(target)).resolves.toEqual({ beacon: true, stream: true });
    expect(gqlCalls[0].operationName).toBe('PlaybackAccessToken');
    expect(calls.find((c) => c.url === 'https://video.example/seg2.ts')!.init!.method).toBe('HEAD');

    await watcher.watch(target);
    expect(gqlCalls).toHaveLength(1); // the variant playlist URL is cached per channel
    watcher.reset();
    await watcher.watch(target);
    expect(gqlCalls).toHaveLength(2);
  });

  it('reports stream failure when the playlist answer is an error', async () => {
    const { fetch } = routes({
      ...spadeRoutes,
      'https://usher.ttvnw.net/': () => new Response('[{"error":"Can not find channel"}]', { status: 404 }),
    });
    const gql = { request: async () => ({ data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } } }) };
    const watcher = new TwitchWatcher({ userId: '42', gql, userAgent: 'ua', fetchStream: () => true, fetch });
    await expect(watcher.watch(target)).resolves.toEqual({ beacon: true, stream: false });
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run test/watcher.test.ts`
Expected: FAIL, because `../src/twitch/watcher.js` cannot be resolved.

- [ ] **Step 3: Implement `src/twitch/watcher.ts`**

```ts
import type { GqlRequester } from './gql.js';
import { op } from './queries.js';
import type { Watcher, WatchResult, WatchTarget } from './types.js';

const SPADE_PATTERN = /"spade_?url": ?"(https:\/\/[.\w\-/]+)"/i;
const SETTINGS_PATTERN = /src="(https:\/\/[\w.]+\/config\/settings\.[0-9a-f]{32}\.js)"/i;

export function buildSpadeBody(target: WatchTarget, userId: string): string {
  const events = [
    {
      event: 'minute-watched',
      properties: {
        broadcast_id: target.broadcastId,
        channel_id: target.channelId,
        channel: target.login,
        client_time: new Date().toISOString(),
        game: target.gameName,
        game_id: target.gameId,
        hidden: false,
        is_live: true,
        live: true,
        logged_in: true,
        minutes_logged: 1,
        muted: false,
        user_id: Number(userId),
      },
    },
  ];
  const data = Buffer.from(JSON.stringify(events), 'utf8').toString('base64');
  return new URLSearchParams({ data }).toString();
}

export function usherUrl(login: string, signature: string, token: string): string {
  const params = new URLSearchParams({ sig: signature, token });
  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(login)}.m3u8?${params}`;
}

export function lastMediaLine(playlist: string): string | null {
  const lines = playlist
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.at(-1) ?? null;
}

export type WatcherDeps = {
  userId: string;
  gql: GqlRequester;
  userAgent: string;
  fetchStream: () => boolean;
  fetch?: typeof fetch;
};

export class TwitchWatcher implements Watcher {
  private spadeUrl: string | null = null;
  private variant: { login: string; url: string } | null = null;

  constructor(private readonly deps: WatcherDeps) {}

  async watch(target: WatchTarget): Promise<WatchResult> {
    const beacon = await this.sendBeacon(target).catch(() => false);
    const stream = this.deps.fetchStream() ? await this.headSegment(target).catch(() => false) : null;
    return { beacon, stream };
  }

  reset(): void {
    this.variant = null;
  }

  private async sendBeacon(target: WatchTarget): Promise<boolean> {
    this.spadeUrl ??= await this.findSpadeUrl(target.login);
    const res = await this.http(this.spadeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildSpadeBody(target, this.deps.userId),
    });
    if (res.status !== 204) {
      this.spadeUrl = null; // look it up again next minute
      return false;
    }
    return true;
  }

  // Channel page HTML → settings script → spade URL (the same path the web player takes).
  private async findSpadeUrl(login: string): Promise<string> {
    const html = await (await this.http(`https://www.twitch.tv/${encodeURIComponent(login)}`)).text();
    let match = SPADE_PATTERN.exec(html);
    if (!match) {
      const settings = SETTINGS_PATTERN.exec(html);
      if (!settings) throw new Error('spade URL: settings script not found');
      match = SPADE_PATTERN.exec(await (await this.http(settings[1])).text());
    }
    if (!match) throw new Error('spade URL not found');
    return match[1];
  }

  // A HEAD on the newest segment looks like playback without downloading video.
  private async headSegment(target: WatchTarget): Promise<boolean> {
    if (this.variant?.login !== target.login) {
      const res = await this.deps.gql.request(
        op('PlaybackAccessToken', {
          isLive: true, isVod: false, login: target.login, platform: 'web', playerType: 'site', vodID: '',
        }),
      );
      const token = res?.data?.streamPlaybackAccessToken;
      if (!token) return false;
      const master = await (await this.http(usherUrl(target.login, token.signature, token.value))).text();
      const variantUrl = lastMediaLine(master); // the last variant is the lowest quality
      if (!variantUrl?.startsWith('http')) return false;
      this.variant = { login: target.login, url: variantUrl };
    }
    const media = await this.http(this.variant.url);
    if (media.status >= 400) {
      this.variant = null;
      return false;
    }
    const segment = lastMediaLine(await media.text());
    if (!segment) return false;
    const head = await this.http(segment, { method: 'HEAD' });
    return head.status === 200;
  }

  private http(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = { 'User-Agent': this.deps.userAgent, ...((init.headers as Record<string, string>) ?? {}) };
    return (this.deps.fetch ?? fetch)(url, { ...init, headers });
  }
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run test/watcher.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add watcher sending minute-watched beacons and segment HEADs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Selection rules

**Files:**
- Create: `src/selection.ts`, `test/helpers.ts`
- Test: `test/selection.test.ts`

**Interfaces:**
- Consumes: `Campaign`, `Drop`, `LiveChannel` from `types.ts`; `PriorityGame` from `config.ts`.
- Produces:
  - `type QueueEntry = { position: number; game: string; state: 'ready' | 'not_linked' | 'no_campaign' | 'all_claimed'; detail?: string }`
  - `isCampaignActive(c: Campaign, now: Date): boolean`
  - `canAccountEarn(c: Campaign): boolean`
  - `earnableDrops(c: Campaign, now: Date): Drop[]`
  - `isCampaignEligible(c: Campaign, now: Date): boolean`
  - `priorityIndex(priority: PriorityGame[], gameId: string): number` (returns `Infinity` when the game isn't listed)
  - `rankCampaigns(campaigns: Campaign[], priority: PriorityGame[], now: Date): Campaign[]`
  - `currentDrop(c: Campaign, now: Date): Drop | null`
  - `upcomingDrops(c: Campaign, now: Date, current: Drop | null): Drop[]`
  - `claimableDrops(c: Campaign): Drop[]`
  - `pickChannel(channels: LiveChannel[], exclude: Set<string>): LiveChannel | null`
  - `buildQueue(campaigns: Campaign[], priority: PriorityGame[], now: Date, skipGameId?: string): QueueEntry[]`
- Produces, in `test/helpers.ts` (also used by Task 8): `NOW`, `PRIORITY`, `makeDrop(overrides?)`, `makeCampaign(overrides?)`, `makeChannel(overrides?)`

- [ ] **Step 1: Create the test helpers**

`test/helpers.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing tests**

`test/selection.test.ts`:
```ts
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
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `npx vitest run test/selection.test.ts`
Expected: FAIL, because `../src/selection.js` cannot be resolved.

- [ ] **Step 4: Implement `src/selection.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npx vitest run test/selection.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add campaign eligibility, ranking and queue rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Miner state machine

**Files:**
- Create: `src/miner.ts`
- Test: `test/miner.test.ts`

**Interfaces:**
- Consumes:
  - from `selection.ts`: `buildQueue`, `claimableDrops`, `currentDrop`, `isCampaignEligible`, `pickChannel`, `priorityIndex`, `rankCampaigns`, `upcomingDrops`, `QueueEntry`
  - from `parse.ts`: `dropLabel`
  - from `errors.ts`: `AuthError`, `GqlOperationError`
  - from `types.ts`: `Campaign`, `LiveChannel`, `TwitchClient`, `Watcher`
  - from `config.ts`: `PriorityGame`
- Produces:
  ```ts
  type MinerStatus = 'starting' | 'mining' | 'idle' | 'error' | 'login_required'
  type LogKind = 'claim' | 'switch' | 'start' | 'error' | 'info'
  type LogEntry = { at: Date; kind: LogKind; message: string }
  type TargetView = { game: string; campaign: string; campaignEndsAt: Date; channel: { login: string; viewers: number };
                      drop: { name: string; current: number; required: number } | null; remainingDrops: { name: string; required: number }[] }
  type MinerState = { status: MinerStatus; user: string; target?: TargetView; queue: QueueEntry[]; nextCheckAt?: Date; error?: string; log: LogEntry[] }
  type Intervals = { tickMs; progressMs; reselectMs; idleRecheckMs; errorRetryMs; stallChecks }   // all numbers
  DEFAULT_INTERVALS
  type MinerDeps = { api: TwitchClient; watcher: Watcher; getPriority: () => PriorityGame[]; user: string;
                     intervals?: Partial<Intervals>; onLog?: (e: LogEntry) => void }
  class Miner { constructor(deps: MinerDeps); getState(): MinerState; subscribe(fn: (s: MinerState) => void): () => void;
                start(): void; stop(): void; refresh(): void }
  ```

- [ ] **Step 1: Write the failing tests**

`test/miner.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miner, type Intervals, type LogEntry } from '../src/miner.js';
import { AuthError, GqlOperationError, NetworkError } from '../src/twitch/errors.js';
import type { Campaign, LiveChannel, TwitchClient, Watcher, WatchTarget } from '../src/twitch/types.js';
import { makeCampaign, makeChannel, makeDrop, NOW, PRIORITY } from './helpers.js';

class FakeApi implements TwitchClient {
  campaigns: Campaign[] = [];
  channels: Record<string, LiveChannel[]> = {};
  offline = new Set<string>();
  claims: string[] = [];
  error: Error | null = null;
  getCampaignsCalls = 0;

  async getCampaigns(gameIds?: string[]) {
    this.getCampaignsCalls++;
    if (this.error) throw this.error;
    return structuredClone(this.campaigns.filter((c) => !gameIds || gameIds.includes(c.game.id)));
  }
  async getLiveChannels(c: Campaign) {
    if (this.error) throw this.error;
    return structuredClone((this.channels[c.id] ?? []).filter((ch) => !this.offline.has(ch.login)));
  }
  async getStreamInfo(login: string) {
    if (this.error) throw this.error;
    if (this.offline.has(login)) return null;
    return Object.values(this.channels).flat().find((ch) => ch.login === login) ?? null;
  }
  async claimDrop(id: string) {
    this.claims.push(id);
    for (const c of this.campaigns) for (const d of c.drops) if (d.claimId === id) d.claimed = true;
    return true;
  }
}

class FakeWatcher implements Watcher {
  watched: string[] = [];
  async watch(t: WatchTarget) {
    this.watched.push(t.login);
    return { beacon: true, stream: null };
  }
  reset() {}
}

function setup(intervals: Partial<Intervals> = {}) {
  const api = new FakeApi();
  const watcher = new FakeWatcher();
  const logs: LogEntry[] = [];
  const miner = new Miner({ api, watcher, user: 'me', getPriority: () => PRIORITY, intervals, onLog: (e) => logs.push(e) });
  return { api, watcher, miner, logs };
}

const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('Miner', () => {
  it('mines the highest-priority game on its most-watched channel', async () => {
    const { api, watcher, miner } = setup();
    const one = makeCampaign();
    const two = makeCampaign({ gameId: 'g2', gameName: 'Game Two' });
    api.campaigns = [two, one];
    api.channels = {
      [one.id]: [makeChannel({ login: 'small', viewers: 5 }), makeChannel({ login: 'big', viewers: 900 })],
      [two.id]: [makeChannel({ gameId: 'g2' })],
    };
    miner.start();
    await run(0);
    const state = miner.getState();
    expect(state.status).toBe('mining');
    expect(state.target?.game).toBe('Game One');
    expect(state.target?.channel.login).toBe('big');
    expect(watcher.watched).toEqual(['big']);
    expect(state.queue).toEqual([
      { position: 2, game: 'Game Two', state: 'ready', detail: '1 campaign · 1 drop left' },
      { position: 3, game: 'Game Three', state: 'no_campaign' },
    ]);
    miner.stop();
  });

  it('falls through to the next game when no channel is live', async () => {
    const { api, miner } = setup();
    const one = makeCampaign();
    const two = makeCampaign({ gameId: 'g2', gameName: 'Game Two' });
    api.campaigns = [one, two];
    api.channels = { [two.id]: [makeChannel({ gameId: 'g2', login: 'two' })] };
    miner.start();
    await run(0);
    expect(miner.getState().target?.channel.login).toBe('two');
    miner.stop();
  });

  it('idles when nothing is eligible and re-checks every 5 minutes', async () => {
    const { api, miner } = setup();
    api.campaigns = [makeCampaign({ linked: false })];
    miner.start();
    await run(0);
    const state = miner.getState();
    expect(state.status).toBe('idle');
    expect(state.nextCheckAt).toEqual(new Date(NOW.getTime() + 300_000));
    expect(state.queue[0]).toEqual({ position: 1, game: 'Game One', state: 'not_linked', detail: 'https://link/g1' });
    expect(api.getCampaignsCalls).toBe(1);
    await run(240_000);
    expect(api.getCampaignsCalls).toBe(1);
    await run(60_000);
    expect(api.getCampaignsCalls).toBe(2);
    miner.stop();
  });

  it('switches channel when the stream goes offline', async () => {
    const { api, miner, logs } = setup();
    const one = makeCampaign();
    const a = makeChannel({ login: 'a', viewers: 900 });
    const b = makeChannel({ login: 'b', viewers: 100 });
    api.campaigns = [one];
    api.channels = { [one.id]: [a, b] };
    miner.start();
    await run(0);
    api.offline.add('a');
    await run(180_000);
    expect(miner.getState().target?.channel.login).toBe('b');
    expect(logs.some((l) => l.kind === 'switch' && l.message.includes('stream went offline'))).toBe(true);
    miner.stop();
  });

  it('switches channel when progress stalls for two checks', async () => {
    const { api, miner, logs } = setup();
    const one = makeCampaign({ drops: [makeDrop({ currentMinutes: 10 })] });
    api.campaigns = [one];
    api.channels = { [one.id]: [makeChannel({ login: 'a', viewers: 900 }), makeChannel({ login: 'b', viewers: 100 })] };
    miner.start();
    await run(0);
    await run(180_000);
    expect(miner.getState().target?.channel.login).toBe('a');
    await run(180_000);
    expect(miner.getState().target?.channel.login).toBe('b');
    expect(logs.some((l) => l.message.includes('no progress'))).toBe(true);
    miner.stop();
  });

  it('switches to a higher-priority game at the 15-minute re-check', async () => {
    const { api, miner, logs } = setup({ stallChecks: 99 });
    const two = makeCampaign({ gameId: 'g2', gameName: 'Game Two' });
    api.campaigns = [two];
    api.channels = { [two.id]: [makeChannel({ gameId: 'g2', login: 'two' })] };
    miner.start();
    await run(0);
    expect(miner.getState().target?.game).toBe('Game Two');
    const one = makeCampaign();
    api.campaigns.push(one);
    api.channels[one.id] = [makeChannel({ login: 'one' })];
    await run(840_000);
    expect(miner.getState().target?.game).toBe('Game Two');
    await run(60_000);
    expect(miner.getState().target?.game).toBe('Game One');
    expect(logs.some((l) => l.kind === 'switch' && l.message.includes('higher-priority'))).toBe(true);
    miner.stop();
  });

  it('estimates progress between checks and claims finished drops', async () => {
    const { api, miner, logs } = setup({ stallChecks: 99 });
    const first = makeDrop({ benefitNames: ['Hoodie'], requiredMinutes: 60, currentMinutes: 58, claimId: 'claim-1' });
    const second = makeDrop({ benefitNames: ['Door Skin'], requiredMinutes: 120 });
    const one = makeCampaign({ drops: [first, second] });
    api.campaigns = [one];
    api.channels = { [one.id]: [makeChannel({ login: 'a' })] };
    miner.start();
    await run(0);
    expect(miner.getState().target?.drop).toEqual({ name: 'Hoodie', current: 58, required: 60 });
    expect(miner.getState().target?.remainingDrops).toEqual([{ name: 'Door Skin', required: 120 }]);
    await run(60_000);
    expect(miner.getState().target?.drop?.current).toBe(59);
    api.campaigns[0].drops[0].currentMinutes = 60;
    await run(120_000);
    expect(api.claims).toEqual(['claim-1']);
    expect(logs.some((l) => l.kind === 'claim' && l.message.includes('Hoodie'))).toBe(true);
    expect(miner.getState().status).toBe('mining');
    expect(miner.getState().target?.drop?.name).toBe('Door Skin');
    miner.stop();
  });

  it('stops and asks for login on AuthError', async () => {
    const { api, miner } = setup();
    api.error = new AuthError();
    miner.start();
    await run(0);
    expect(miner.getState().status).toBe('login_required');
    await run(600_000);
    expect(api.getCampaignsCalls).toBe(1);
  });

  it('goes idle on a changed Twitch API and recovers later', async () => {
    const { api, miner } = setup();
    api.error = new GqlOperationError('Inventory', 'PersistedQueryNotFound');
    miner.start();
    await run(0);
    expect(miner.getState().status).toBe('error');
    expect(miner.getState().error).toContain('Twitch API changed: Inventory');
    api.error = null;
    const one = makeCampaign();
    api.campaigns = [one];
    api.channels = { [one.id]: [makeChannel()] };
    await run(300_000);
    expect(miner.getState().status).toBe('mining');
    miner.stop();
  });

  it('keeps its target through network errors and retries after 5 minutes', async () => {
    const { api, miner } = setup({ stallChecks: 99 });
    const one = makeCampaign();
    api.campaigns = [one];
    api.channels = { [one.id]: [makeChannel({ login: 'a' })] };
    miner.start();
    await run(0);
    api.error = new NetworkError('Inventory: ECONNRESET');
    await run(180_000);
    expect(miner.getState().status).toBe('error');
    expect(miner.getState().target?.channel.login).toBe('a');
    api.error = null;
    await run(300_000);
    expect(miner.getState().status).toBe('mining');
    miner.stop();
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run test/miner.test.ts`
Expected: FAIL, because `../src/miner.js` cannot be resolved.

- [ ] **Step 3: Implement `src/miner.ts`**

```ts
import type { PriorityGame } from './config.js';
import {
  buildQueue, claimableDrops, currentDrop, isCampaignEligible, pickChannel, priorityIndex, rankCampaigns,
  upcomingDrops, type QueueEntry,
} from './selection.js';
import { AuthError, GqlOperationError } from './twitch/errors.js';
import { dropLabel } from './twitch/parse.js';
import type { Campaign, LiveChannel, TwitchClient, Watcher } from './twitch/types.js';

export type MinerStatus = 'starting' | 'mining' | 'idle' | 'error' | 'login_required';
export type LogKind = 'claim' | 'switch' | 'start' | 'error' | 'info';
export type LogEntry = { at: Date; kind: LogKind; message: string };

export type TargetView = {
  game: string;
  campaign: string;
  campaignEndsAt: Date;
  channel: { login: string; viewers: number };
  drop: { name: string; current: number; required: number } | null;
  remainingDrops: { name: string; required: number }[];
};

export type MinerState = {
  status: MinerStatus;
  user: string;
  target?: TargetView;
  queue: QueueEntry[];
  nextCheckAt?: Date;
  error?: string;
  log: LogEntry[];
};

export type Intervals = {
  tickMs: number;
  progressMs: number;
  reselectMs: number;
  idleRecheckMs: number;
  errorRetryMs: number;
  stallChecks: number;
};

export const DEFAULT_INTERVALS: Intervals = {
  tickMs: 60_000,
  progressMs: 180_000,
  reselectMs: 900_000,
  idleRecheckMs: 300_000,
  errorRetryMs: 300_000,
  stallChecks: 2,
};

export type MinerDeps = {
  api: TwitchClient;
  watcher: Watcher;
  getPriority: () => PriorityGame[];
  user: string;
  intervals?: Partial<Intervals>;
  onLog?: (entry: LogEntry) => void;
};

const LOG_LIMIT = 10;

type Active = {
  campaign: Campaign;
  channel: LiveChannel;
  estimate: number;
  lastReal: number | null;
  lastDropId: string | null;
  stalls: number;
};

type Choice = { campaign: Campaign; channel: LiveChannel };

export class Miner {
  private readonly iv: Intervals;
  private readonly listeners = new Set<(state: MinerState) => void>();
  private readonly recent: LogEntry[] = [];
  private readonly excluded = new Set<string>();
  private excludedFor: string | null = null;
  private state: MinerState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;
  private active: Active | null = null;
  private campaigns: Campaign[] = [];
  private forceSelect = true;
  private lastSelectAt = 0;
  private lastProgressAt = 0;
  private retryAt = 0;
  private error: string | null = null;
  private loginRequired = false;

  constructor(private readonly deps: MinerDeps) {
    this.iv = { ...DEFAULT_INTERVALS, ...deps.intervals };
    this.state = { status: 'starting', user: deps.user, queue: [], log: [] };
  }

  getState(): MinerState {
    return this.state;
  }

  subscribe(listener: (state: MinerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    this.deps.watcher.reset();
  }

  refresh(): void {
    this.forceSelect = true;
    this.retryAt = 0;
    if (this.running && !this.busy) {
      if (this.timer) clearTimeout(this.timer);
      this.schedule(0);
    }
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.busy = true;
    try {
      await this.step();
    } catch (err) {
      this.handleError(err);
    } finally {
      this.busy = false;
      this.emit();
      if (this.running) this.schedule(this.iv.tickMs);
    }
  }

  private async step(): Promise<void> {
    const now = Date.now();
    if (now < this.retryAt) return;
    const sinceSelect = now - this.lastSelectAt;
    const selectDue = this.active ? sinceSelect >= this.iv.reselectMs : sinceSelect >= this.iv.idleRecheckMs;
    // Only a successful Twitch call clears an error; quiet ticks leave it showing.
    let talkedToTwitch = true;
    if (this.forceSelect || selectDue) await this.select();
    else if (this.active && now - this.lastProgressAt >= this.iv.progressMs) await this.checkProgress(this.active);
    else {
      talkedToTwitch = false;
      if (this.active) this.active.estimate += 1;
    }

    const active = this.active;
    if (active) {
      await this.deps.watcher.watch({
        channelId: active.channel.id,
        login: active.channel.login,
        broadcastId: active.channel.broadcastId,
        gameId: active.campaign.game.id,
        gameName: active.campaign.game.name,
      });
    }
    if (talkedToTwitch) {
      this.error = null;
      this.retryAt = 0;
    }
  }

  private async select(): Promise<void> {
    const now = new Date();
    const priority = this.deps.getPriority();
    this.forceSelect = false;
    this.lastSelectAt = now.getTime();
    this.campaigns = await this.deps.api.getCampaigns(priority.map((g) => g.id));
    for (const campaign of this.campaigns) await this.claimReady(campaign);
    const ranked = rankCampaigns(this.campaigns, priority, now);

    const active = this.active;
    const current = active ? ranked.find((c) => c.id === active.campaign.id) : undefined;
    if (active && current) {
      const currentRank = priorityIndex(priority, current.game.id);
      const better = await this.findChoice(ranked.filter((c) => priorityIndex(priority, c.game.id) < currentRank));
      if (better) {
        this.setTarget(better, 'switch', `Switched to higher-priority game: ${better.campaign.game.name} → ${better.channel.login}`);
      } else {
        active.campaign = current;
      }
      return;
    }
    if (active) this.addLog('info', `Stopped: ${active.campaign.game.name} — ${active.campaign.name} is no longer available`);

    const choice = await this.findChoice(ranked);
    if (choice) {
      this.setTarget(choice, 'start', `Started: ${choice.campaign.game.name} → ${choice.channel.login}`);
    } else {
      this.active = null;
      this.excluded.clear();
      this.excludedFor = null;
      this.deps.watcher.reset();
    }
  }

  private async findChoice(candidates: Campaign[]): Promise<Choice | null> {
    for (const campaign of candidates) {
      const channel = pickChannel(await this.deps.api.getLiveChannels(campaign), this.excluded);
      if (channel) return { campaign, channel };
    }
    return null;
  }

  private setTarget(choice: Choice, kind: LogKind, message: string): void {
    if (this.excludedFor !== choice.campaign.id) {
      this.excluded.clear();
      this.excludedFor = null;
    }
    this.deps.watcher.reset();
    const drop = currentDrop(choice.campaign, new Date());
    this.active = {
      campaign: choice.campaign,
      channel: choice.channel,
      estimate: drop?.currentMinutes ?? 0,
      lastReal: drop?.currentMinutes ?? null,
      lastDropId: drop?.id ?? null,
      stalls: 0,
    };
    this.lastProgressAt = Date.now();
    this.addLog(kind, message);
  }

  private async checkProgress(active: Active): Promise<void> {
    const now = new Date();
    this.lastProgressAt = now.getTime();
    const fresh = (await this.deps.api.getCampaigns([active.campaign.game.id])).find(
      (c) => c.id === active.campaign.id,
    );
    if (!fresh) {
      this.addLog('info', `Campaign ended: ${active.campaign.game.name} — ${active.campaign.name}`);
      this.active = null;
      await this.select();
      return;
    }
    await this.claimReady(fresh);
    if (!isCampaignEligible(fresh, now)) {
      this.addLog('info', `Campaign complete: ${fresh.game.name} — ${fresh.name}`);
      this.active = null;
      await this.select();
      return;
    }
    active.campaign = fresh;

    const live = await this.deps.api.getStreamInfo(active.channel.login);
    if (!live) return this.switchChannel(active, 'stream went offline');
    if (live.gameId !== fresh.game.id) return this.switchChannel(active, 'streamer changed game');
    active.channel = { ...active.channel, viewers: live.viewers, broadcastId: live.broadcastId };

    const drop = currentDrop(fresh, now);
    const real = drop?.currentMinutes ?? 0;
    const sameDrop = drop !== null && drop.id === active.lastDropId;
    active.stalls = sameDrop && active.lastReal !== null && real <= active.lastReal ? active.stalls + 1 : 0;
    active.lastReal = real;
    active.lastDropId = drop?.id ?? null;
    active.estimate = real;
    if (active.stalls >= this.iv.stallChecks) await this.switchChannel(active, 'no progress for several minutes');
  }

  private async switchChannel(active: Active, reason: string): Promise<void> {
    this.excluded.add(active.channel.id);
    this.excludedFor = active.campaign.id;
    const channel = pickChannel(await this.deps.api.getLiveChannels(active.campaign), this.excluded);
    if (channel) {
      this.setTarget(
        { campaign: active.campaign, channel },
        'switch',
        `Switched channel (${reason}): ${active.channel.login} → ${channel.login}`,
      );
      return;
    }
    this.addLog('switch', `${reason}: no other live channel for ${active.campaign.game.name}`);
    this.active = null;
    await this.select();
  }

  private async claimReady(campaign: Campaign): Promise<void> {
    for (const drop of claimableDrops(campaign)) {
      let ok = false;
      try {
        ok = await this.deps.api.claimDrop(drop.claimId as string);
      } catch (err) {
        if (err instanceof AuthError) throw err;
      }
      if (ok) {
        drop.claimed = true;
        this.addLog('claim', `Claimed: ${campaign.game.name} — ${dropLabel(drop)}`);
      } else {
        this.addLog('error', `Claim failed: ${campaign.game.name} — ${dropLabel(drop)} (will retry)`);
      }
    }
  }

  private handleError(err: unknown): void {
    if (err instanceof AuthError) {
      this.loginRequired = true;
      this.running = false;
      this.active = null;
      this.deps.watcher.reset();
      this.addLog('error', 'Login expired or revoked. Quit and run `drops login`.');
      return;
    }
    this.error = err instanceof Error ? err.message : String(err);
    this.addLog('error', this.error);
    if (err instanceof GqlOperationError) {
      this.active = null;
      this.deps.watcher.reset();
      this.lastSelectAt = Date.now();
      return;
    }
    this.retryAt = Date.now() + this.iv.errorRetryMs;
  }

  private addLog(kind: LogKind, message: string): void {
    const entry: LogEntry = { at: new Date(), kind, message };
    this.recent.unshift(entry);
    this.recent.splice(LOG_LIMIT);
    this.deps.onLog?.(entry);
  }

  private emit(): void {
    const now = new Date();
    const active = this.active;
    let target: TargetView | undefined;
    if (active) {
      const drop = currentDrop(active.campaign, now);
      target = {
        game: active.campaign.game.name,
        campaign: active.campaign.name,
        campaignEndsAt: active.campaign.endsAt,
        channel: { login: active.channel.login, viewers: active.channel.viewers },
        drop: drop
          ? {
              name: dropLabel(drop),
              current: Math.min(drop.requiredMinutes, Math.max(drop.currentMinutes, active.estimate)),
              required: drop.requiredMinutes,
            }
          : null,
        remainingDrops: upcomingDrops(active.campaign, now, drop).map((d) => ({
          name: dropLabel(d),
          required: d.requiredMinutes,
        })),
      };
    }
    const status: MinerStatus = this.loginRequired
      ? 'login_required'
      : this.error
        ? 'error'
        : active
          ? 'mining'
          : this.lastSelectAt === 0
            ? 'starting'
            : 'idle';
    const nextCheckAt =
      status === 'idle'
        ? new Date(this.lastSelectAt + this.iv.idleRecheckMs)
        : status === 'error'
          ? new Date(this.retryAt || this.lastSelectAt + this.iv.idleRecheckMs)
          : undefined;
    this.state = {
      status,
      user: this.deps.user,
      target,
      queue: buildQueue(this.campaigns, this.deps.getPriority(), now, active?.campaign.game.id),
      nextCheckAt,
      error: this.error ?? undefined,
      log: [...this.recent],
    };
    for (const listener of this.listeners) listener(this.state);
  }
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run test/miner.test.ts`
Expected: PASS (10 tests). If a timing test fails, print `logs` and `miner.getState()` in that test before changing any interval values. The timeline the tests assume is: first tick at t=0, then one tick every 60s; progress checks at 180s and 360s; re-selection at 900s.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add miner state machine with switching, stalls and claims

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Dashboard UI

**Files:**
- Create: `src/ui/format.ts`, `src/ui/Header.tsx`, `src/ui/CurrentTarget.tsx`, `src/ui/Queue.tsx`, `src/ui/EventLog.tsx`, `src/ui/Dashboard.tsx`
- Test: `test/ui.test.tsx`

**Interfaces:**
- Consumes: `MinerState`, `MinerStatus`, `TargetView`, `LogEntry`, `LogKind` from `miner.ts`; `QueueEntry` from `selection.ts`.
- Produces:
  - `formatDuration(ms: number): string`
  - `formatViewers(n: number): string`
  - `progressBar(current: number, required: number, width?: number): string`
  - `formatClock(d: Date): string`
  - `type MinerLike = { subscribe(listener: (s: MinerState) => void): () => void; refresh(): void }`
  - `Dashboard({ miner, onQuit }: { miner: MinerLike; onQuit: () => void })`

- [ ] **Step 1: Write the failing tests**

`test/ui.test.tsx`:
```tsx
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { MinerState } from '../src/miner.js';
import { CurrentTarget } from '../src/ui/CurrentTarget.js';
import { Dashboard } from '../src/ui/Dashboard.js';
import { formatDuration, formatViewers, progressBar } from '../src/ui/format.js';
import { Header } from '../src/ui/Header.js';
import { Queue } from '../src/ui/Queue.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const wait = () => new Promise((r) => setTimeout(r, 30));

const mining: MinerState = {
  status: 'mining',
  user: 'me',
  target: {
    game: 'Rust',
    campaign: 'Round 42',
    campaignEndsAt: later((3 * 24 + 4) * 3_600_000),
    channel: { login: 'hjune', viewers: 12_400 },
    drop: { name: 'Hoodie', current: 42, required: 60 },
    remainingDrops: [{ name: 'Door Skin', required: 120 }, { name: 'AK Skin', required: 240 }],
  },
  queue: [
    { position: 2, game: 'Marvel Rivals', state: 'ready', detail: '1 campaign · 2 drops left' },
    { position: 3, game: 'Valorant', state: 'not_linked', detail: 'https://link/valorant' },
  ],
  log: [{ at: NOW, kind: 'claim', message: 'Claimed: Rust — Bandana' }],
};

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(18 * 60_000)).toBe('18m');
    expect(formatDuration(125 * 60_000)).toBe('2h 5m');
    expect(formatDuration((3 * 24 + 4) * 3_600_000)).toBe('3d 4h');
  });

  it('formats viewers and progress bars', () => {
    expect(formatViewers(950)).toBe('950');
    expect(formatViewers(12_400)).toBe('12.4k');
    expect(formatViewers(3_000)).toBe('3k');
    expect(progressBar(42, 60, 10)).toBe('███████░░░');
    expect(progressBar(90, 60, 4)).toBe('████');
    expect(progressBar(0, 0, 4)).toBe('░░░░');
  });
});

describe('components', () => {
  it('Header shows status and idle countdown', () => {
    const idle: MinerState = { ...mining, status: 'idle', target: undefined, nextCheckAt: later(4 * 60_000) };
    const frame = render(<Header state={idle} now={NOW} />).lastFrame()!;
    expect(frame).toContain('logged in as me');
    expect(frame).toContain('◌ IDLE');
    expect(frame).toContain('next check in 4m');
  });

  it('Header shows login required', () => {
    const frame = render(<Header state={{ ...mining, status: 'login_required' }} now={NOW} />).lastFrame()!;
    expect(frame).toContain('LOGIN REQUIRED');
    expect(frame).toContain('drops login');
  });

  it('CurrentTarget shows game, channel, progress and next drops', () => {
    const frame = render(<CurrentTarget target={mining.target!} now={NOW} />).lastFrame()!;
    expect(frame).toContain('Rust — "Round 42"');
    expect(frame).toContain('ends in 3d 4h');
    expect(frame).toContain('hjune (12.4k viewers)');
    expect(frame).toContain('42/60 min');
    expect(frame).toContain('~18m left');
    expect(frame).toContain('Next: Door Skin (120 min) · AK Skin (240 min)');
  });

  it('Queue shows states and link for unlinked games', () => {
    const frame = render(<Queue queue={mining.queue} />).lastFrame()!;
    expect(frame).toContain('2. Marvel Rivals');
    expect(frame).toContain('ready');
    expect(frame).toContain('account not linked');
    expect(frame).toContain('https://link/valorant');
  });
});

describe('Dashboard', () => {
  it('renders miner state and handles keys', async () => {
    const miner = { subscribe: (fn: (s: MinerState) => void) => { fn(mining); return () => {}; }, refresh: vi.fn() };
    const onQuit = vi.fn();
    const { lastFrame, stdin, unmount } = render(<Dashboard miner={miner} onQuit={onQuit} />);
    await wait();
    const frame = lastFrame()!;
    expect(frame).toContain('● MINING');
    expect(frame).toContain('Claimed: Rust — Bandana');
    expect(frame).toContain('q quit · r refresh now');
    stdin.write('r');
    await wait();
    expect(miner.refresh).toHaveBeenCalledTimes(1);
    stdin.write('\u0003'); // Ctrl+C
    await wait();
    expect(onQuit).toHaveBeenCalledTimes(1);
    stdin.write('q');
    await wait();
    expect(onQuit).toHaveBeenCalledTimes(2);
    unmount();
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run test/ui.test.tsx`
Expected: FAIL, because `../src/ui/...` modules cannot be resolved.

- [ ] **Step 3: Implement the formatting helpers**

`src/ui/format.ts`:
```ts
export function formatDuration(ms: number): string {
  if (ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatViewers(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

export function progressBar(current: number, required: number, width = 20): string {
  const ratio = required > 0 ? Math.min(1, current / required) : 0;
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Implement the components**

`src/ui/Header.tsx`:
```tsx
import { Box, Text } from 'ink';
import type { MinerState, MinerStatus } from '../miner.js';
import { formatDuration } from './format.js';

const BADGES: Record<MinerStatus, { label: string; color: string }> = {
  starting: { label: '… STARTING', color: 'gray' },
  mining: { label: '● MINING', color: 'green' },
  idle: { label: '◌ IDLE', color: 'yellow' },
  error: { label: '⚠ ERROR', color: 'red' },
  login_required: { label: 'LOGIN REQUIRED', color: 'red' },
};

export function Header({ state, now }: { state: MinerState; now: Date }) {
  const badge = BADGES[state.status];
  const wait = state.nextCheckAt ? formatDuration(state.nextCheckAt.getTime() - now.getTime()) : null;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>Twitch Drops Miner · logged in as {state.user}</Text>
        <Text bold color={badge.color}>{badge.label}</Text>
      </Box>
      {state.status === 'idle' && (
        <Text dimColor>No priority drops available{wait ? ` · next check in ${wait}` : ''}</Text>
      )}
      {state.status === 'error' && (
        <Text color="red">{state.error}{wait ? ` · retrying in ${wait}` : ''}</Text>
      )}
      {state.status === 'login_required' && (
        <Text color="red">Login expired. Press q, then run `drops login`.</Text>
      )}
    </Box>
  );
}
```

`src/ui/CurrentTarget.tsx`:
```tsx
import { Box, Text } from 'ink';
import type { TargetView } from '../miner.js';
import { formatDuration, formatViewers, progressBar } from './format.js';

export function CurrentTarget({ target, now }: { target: TargetView; now: Date }) {
  const { drop } = target;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold color="magenta">▶ {target.game} — "{target.campaign}"</Text>
        <Text dimColor>ends in {formatDuration(target.campaignEndsAt.getTime() - now.getTime())}</Text>
      </Box>
      <Text>  channel: {target.channel.login} ({formatViewers(target.channel.viewers)} viewers)</Text>
      {drop ? (
        <Text>
          {'  '}{drop.name}  [{progressBar(drop.current, drop.required)}]  {drop.current}/{drop.required} min
          {'   '}~{formatDuration((drop.required - drop.current) * 60_000)} left
        </Text>
      ) : (
        <Text dimColor>  Waiting for the next drop to unlock</Text>
      )}
      {target.remainingDrops.length > 0 && (
        <Text dimColor>
          {'  '}Next: {target.remainingDrops.map((d) => `${d.name} (${d.required} min)`).join(' · ')}
        </Text>
      )}
    </Box>
  );
}
```

`src/ui/Queue.tsx`:
```tsx
import { Box, Text } from 'ink';
import type { QueueEntry } from '../selection.js';

const STATE_TEXT: Record<QueueEntry['state'], { text: string; color?: string }> = {
  ready: { text: 'ready', color: 'green' },
  not_linked: { text: '⚠ account not linked', color: 'yellow' },
  no_campaign: { text: 'no active campaign' },
  all_claimed: { text: 'all drops claimed' },
};

export function Queue({ queue }: { queue: QueueEntry[] }) {
  if (queue.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Queue (by priority)</Text>
      {queue.map((entry) => {
        const s = STATE_TEXT[entry.state];
        return (
          <Text key={entry.position}>
            {'  '}{entry.position}. {entry.game}  <Text color={s.color} dimColor={!s.color}>{s.text}</Text>
            {entry.detail ? `  ${entry.detail}` : ''}
          </Text>
        );
      })}
    </Box>
  );
}
```

`src/ui/EventLog.tsx`:
```tsx
import { Box, Text } from 'ink';
import type { LogEntry, LogKind } from '../miner.js';
import { formatClock } from './format.js';

const ICONS: Record<LogKind, string> = { claim: '✔', switch: '↻', start: '▶', error: '⚠', info: '·' };

export function EventLog({ log }: { log: LogEntry[] }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Log</Text>
      {log.length === 0 ? (
        <Text dimColor>  nothing yet</Text>
      ) : (
        log.map((entry, i) => (
          <Text key={i} color={entry.kind === 'error' ? 'red' : undefined}>
            {'  '}{formatClock(entry.at)}  {ICONS[entry.kind]} {entry.message}
          </Text>
        ))
      )}
    </Box>
  );
}
```

`src/ui/Dashboard.tsx`:
```tsx
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { MinerState } from '../miner.js';
import { CurrentTarget } from './CurrentTarget.js';
import { EventLog } from './EventLog.js';
import { Header } from './Header.js';
import { Queue } from './Queue.js';

export type MinerLike = {
  subscribe(listener: (state: MinerState) => void): () => void;
  refresh(): void;
};

export function Dashboard({ miner, onQuit }: { miner: MinerLike; onQuit: () => void }) {
  const [state, setState] = useState<MinerState | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => miner.subscribe(setState), [miner]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) onQuit();
    else if (input === 'r') miner.refresh();
  });

  if (!state) return <Text>Starting…</Text>;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header state={state} now={now} />
      {state.target && <CurrentTarget target={state.target} now={now} />}
      <Queue queue={state.queue} />
      <EventLog log={state.log} />
      <Box marginTop={1}>
        <Text dimColor>q quit · r refresh now</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npx vitest run test/ui.test.tsx`
Expected: PASS (7 tests). If a `toContain` fails only because Ink wrapped a line, check `lastFrame()` and widen the check (for example, assert the two halves separately) instead of changing the layout.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Ink dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: CLI commands

**Files:**
- Create: `src/commands.ts`, `src/cli.tsx`, `README.md`
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `formatCampaignList(campaigns: Campaign[], priority: PriorityGame[], now: Date): string`
  - `formatGames(games: PriorityGame[]): string`
  - `formatLogLine(entry: LogEntry): string`
  - `appendLog(path: string, entry: LogEntry): void`
  - the `drops` binary (`dist/cli.js`)

- [ ] **Step 1: Write the failing tests**

`test/commands.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL, because `../src/commands.js` cannot be resolved.

- [ ] **Step 3: Implement `src/commands.ts`**

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PriorityGame } from './config.js';
import type { LogEntry } from './miner.js';
import { canAccountEarn, priorityIndex } from './selection.js';
import { dropLabel } from './twitch/parse.js';
import type { Campaign, Drop } from './twitch/types.js';
import { formatDuration } from './ui/format.js';

function dropStatus(d: Drop): string {
  if (d.claimed) return 'claimed';
  if (d.requiredSubs > 0 || d.requiredMinutes <= 0) return 'subscription only';
  return `${d.currentMinutes}/${d.requiredMinutes} min`;
}

export function formatCampaignList(campaigns: Campaign[], priority: PriorityGame[], now: Date): string {
  if (campaigns.length === 0) return 'No active drop campaigns.';
  const rank = (c: Campaign) => priorityIndex(priority, c.game.id);
  const sorted = [...campaigns].sort(
    (a, b) =>
      (rank(a) === rank(b) ? 0 : rank(a) - rank(b)) ||
      a.game.name.localeCompare(b.game.name) ||
      a.endsAt.getTime() - b.endsAt.getTime(),
  );
  const lines: string[] = [];
  for (const c of sorted) {
    const star = rank(c) === Infinity ? '' : ` ★${rank(c) + 1}`;
    const link = canAccountEarn(c) ? 'linked' : `NOT LINKED → ${c.linkUrl}`;
    lines.push(`${c.game.name}${star} · ${c.name} · ends in ${formatDuration(c.endsAt.getTime() - now.getTime())} · ${link}`);
    for (const d of c.drops) lines.push(`    ${dropLabel(d).padEnd(32)} ${dropStatus(d)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatGames(games: PriorityGame[]): string {
  if (games.length === 0) return 'No priority games yet. Add one with `drops games add <name>`.';
  return games.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
}

export function formatLogLine(entry: LogEntry): string {
  return `${entry.at.toISOString()} [${entry.kind}] ${entry.message}\n`;
}

export function appendLog(path: string, entry: LogEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, formatLogLine(entry), 'utf8');
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement `src/cli.tsx`**

```tsx
#!/usr/bin/env node
import { Command } from 'commander';
import { render } from 'ink';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_ID, loadSession, pollForToken, saveSession, startDeviceLogin, USER_AGENT, validateToken, type Session,
} from './auth.js';
import { appendLog, formatCampaignList, formatGames } from './commands.js';
import { addGame, dataDir, loadConfig, moveGame, removeGame, saveConfig } from './config.js';
import { Miner } from './miner.js';
import { GqlClient, randomHex, type GqlRequester } from './twitch/gql.js';
import { TwitchApi } from './twitch/queries.js';
import { TwitchWatcher } from './twitch/watcher.js';
import { Dashboard } from './ui/Dashboard.js';

async function requireSession(): Promise<Session> {
  const session = loadSession();
  if (!session) throw new Error('Not logged in. Run `drops login` first.');
  const who = await validateToken(session.token);
  if (!who) throw new Error('Your Twitch login expired. Run `drops login` again.');
  return { ...session, login: who.login };
}

// TDM_DEBUG=1 appends raw GQL traffic to debug.jsonl. Use it to update fixtures when Twitch changes.
function withDebug(gql: GqlRequester): GqlRequester {
  if (!process.env.TDM_DEBUG) return gql;
  const path = join(dataDir(), 'debug.jsonl');
  return {
    async request(ops) {
      const res = await gql.request(ops);
      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ops, res }) + '\n');
      return res;
    },
  };
}

function makeClients(session: Session) {
  const gql = withDebug(
    new GqlClient({ token: session.token, clientId: CLIENT_ID, deviceId: session.deviceId, userAgent: USER_AGENT }),
  );
  return { gql, api: new TwitchApi(gql, session.userId) };
}

const program = new Command('drops').description('Lightweight Twitch drops miner');

program
  .command('login')
  .description('Log in with a code at twitch.tv/activate')
  .action(async () => {
    const deviceId = loadSession()?.deviceId ?? randomHex(32);
    const code = await startDeviceLogin(deviceId);
    console.log(`Open ${code.verificationUri}\nand enter the code: ${code.userCode}\n\nWaiting for approval…`);
    const token = await pollForToken(code, deviceId);
    const who = await validateToken(token);
    if (!who) throw new Error('Twitch rejected the new login. Please try again.');
    saveSession({ token, deviceId, ...who });
    console.log(`Logged in as ${who.login}.`);
  });

program
  .command('list')
  .description('Show all active drop campaigns and your progress')
  .action(async () => {
    const { api } = makeClients(await requireSession());
    console.log(formatCampaignList(await api.getCampaigns(), loadConfig().priorityGames, new Date()));
  });

const games = program
  .command('games')
  .description('Show or edit the priority games list')
  .action(() => console.log(formatGames(loadConfig().priorityGames)));

games
  .command('add')
  .argument('<name...>', 'game name as shown on Twitch')
  .description('Add a game to the end of the priority list')
  .action(async (parts: string[]) => {
    const name = parts.join(' ');
    const { api } = makeClients(await requireSession());
    const game = await api.resolveGame(name);
    if (!game) throw new Error(`No Twitch game named "${name}". Use the exact name shown on Twitch.`);
    const config = addGame(loadConfig(), game);
    saveConfig(config);
    console.log(`Added ${game.name}.\n${formatGames(config.priorityGames)}`);
  });

games
  .command('remove')
  .argument('<name...>', 'game name')
  .description('Remove a game from the priority list')
  .action((parts: string[]) => {
    const config = removeGame(loadConfig(), parts.join(' '));
    saveConfig(config);
    console.log(formatGames(config.priorityGames));
  });

games
  .command('move')
  .argument('<name>', 'game name (quote it if it has spaces)')
  .argument('<position>', 'new 1-based position')
  .description('Move a game to a new position')
  .action((name: string, position: string) => {
    const config = moveGame(loadConfig(), name, Number(position));
    saveConfig(config);
    console.log(formatGames(config.priorityGames));
  });

program
  .command('start')
  .description('Start mining with the live dashboard')
  .action(async () => {
    const session = await requireSession();
    const config = loadConfig();
    if (config.priorityGames.length === 0) {
      throw new Error('No priority games yet. Add one with `drops games add <name>`.');
    }
    const { gql, api } = makeClients(session);
    const watcher = new TwitchWatcher({
      userId: session.userId,
      gql,
      userAgent: USER_AGENT,
      fetchStream: () => loadConfig().settings.fetchStream,
    });
    const logPath = join(dataDir(), 'log.txt');
    const miner = new Miner({
      api,
      watcher,
      user: session.login,
      // Re-read each time so `drops games …` in another terminal applies at the next check.
      getPriority: () => loadConfig().priorityGames,
      onLog: (entry) => appendLog(logPath, entry),
    });
    const app = render(
      <Dashboard
        miner={miner}
        onQuit={() => {
          miner.stop();
          app.unmount();
        }}
      />,
      { exitOnCtrlC: false },
    );
    miner.start();
    await app.waitUntilExit();
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 6: Write `README.md`**

````markdown
# twitch-drops-miner

A lightweight terminal tool that earns Twitch Drops for your priority games without playing video.
It mines one campaign at a time, switches channels when a stream dies or stops counting, and claims drops automatically.

> Automated viewing is against Twitch's Terms of Service. Use at your own risk on your own account.

## Setup

```bash
npm install
npm run build
npm link        # makes the `drops` command available
```

## Usage

```bash
drops login                       # enter the shown code at twitch.tv/activate
drops list                        # all active campaigns, rewards and your progress
drops games add Rust              # add priority games (exact Twitch name)
drops games add Marvel Rivals
drops games move "Marvel Rivals" 1
drops games                       # show the priority list
drops start                       # live dashboard (q quit, r refresh)
```

Data lives in `~/.twitch-drops-miner/` (`config.json`, `auth.json`, `log.txt`).
To turn off the stream-segment requests and send only the "minute watched" beacon, set `"fetchStream": false` in `config.json`.

## When Twitch changes something

The dashboard shows `Twitch API changed: <operation> failed`. Run with `TDM_DEBUG=1` to write raw responses to
`~/.twitch-drops-miner/debug.jsonl`, then update the hash in `src/twitch/queries.ts` or the parser in `src/twitch/parse.ts`.
````

- [ ] **Step 7: Full check**

Run: `npm test`
Expected: all test files pass.

Run: `npm run typecheck`
Expected: no errors. Fix any type errors in `src/` without changing behaviour.

Run: `npm run build`, then `node dist/cli.js --help`
Expected: help output listing `login`, `list`, `games`, `start`.

Run: `node dist/cli.js list`
Expected (not logged in yet): `Not logged in. Run \`drops login\` first.` and exit code 1.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add drops CLI with login, list, games and start commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Live verification with the real account (needs the user)

The account owner has to do the login and watch the results. Coordinate each step with them.

**Files:**
- Modify (only if live data differs): `src/twitch/parse.ts`, `src/twitch/queries.ts`, `test/fixtures/*.json`

- [ ] **Step 1: Link the binary and log in**

Run: `npm link`, then ask the user to run `! drops login` and approve the code at twitch.tv/activate.
Expected: `Logged in as <login>.` and `~/.twitch-drops-miner/auth.json` exists.

- [ ] **Step 2: Check `list` against twitch.tv/drops/campaigns**

Ask the user to run `! TDM_DEBUG=1 drops list`.
Expected: the campaigns match what twitch.tv/drops/campaigns shows. Linked status and progress match twitch.tv/drops/inventory.
If something is missing or wrong, read `~/.twitch-drops-miner/debug.jsonl`. Compare the real `Inventory`, `ViewerDropsDashboard` and `DropCampaignDetails` shapes with `test/fixtures/`. Update the fixtures to the real shape (replacing personal IDs with placeholders), confirm the parse tests fail, fix `parse.ts`, and confirm `npm test` passes again.

- [ ] **Step 3: Add a priority game and mine for 15 minutes**

The user picks a game with an active, linked campaign. Ask them to run `! drops games add <name>`, then `drops start` in their own terminal.
Expected:
- Within a minute the dashboard shows ● MINING with a channel.
- After about 15 minutes, progress on twitch.tv/drops/inventory has gone up by roughly the time watched.
- No stall-triggered channel switches appear in the log.

- [ ] **Step 4: Test the beacon on its own**

Set `"fetchStream": false` in `~/.twitch-drops-miner/config.json`, run `drops start` for another 15 minutes, and compare progress again.
Record the result in the README's usage section: either "beacon alone is enough" or "keep fetchStream on".

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: align parsing with live Twitch responses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(Skip this step if nothing changed.)
