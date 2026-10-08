# Twitch Drops Miner — Design

Date: 2026-10-08
Status: Draft for review

## Goal

A lightweight command-line tool that earns Twitch Drops for the user's own account without playing video. The user keeps an ordered list of priority games; the tool mines one campaign at a time for the highest-priority game that is available, shows progress in a live terminal dashboard, and claims drops automatically.

### Success criteria

- `drops list` shows every active drop campaign with rewards, required minutes, end date, account-link status and current progress.
- The user can add, remove, reorder and view priority games.
- `drops start` mines only priority games, and drop progress visibly increases on twitch.tv/drops/inventory.
- Completed drops are claimed without user action.
- When no priority game is available, the tool idles and resumes on its own.

### Non-goals

- Mining several campaigns or channels at once (Twitch counts progress on one channel at a time, and running several is more detectable).
- Mining non-priority games as a fallback.
- Desktop or tray UI, browser automation, multiple accounts.

### Risks

- Automated viewing is against Twitch's Terms of Service. The risk falls on the user's own account, and the user accepts it.
- The tool relies on Twitch's undocumented internal GQL API and analytics endpoints, which can change without notice. The design keeps all query definitions in one file so breakage is easy to find and fix.

## Stack

- TypeScript on Node (LTS), using Node's built-in `fetch`.
- `ink` + `react` for the dashboard, `commander` for the CLI.
- `vitest` + `ink-testing-library` for tests.
- Data directory: `~/.twitch-drops-miner/` containing `config.json` (priority games, settings), `auth.json` (OAuth token) and `log.txt`.

## Architecture

```
src/
  cli.ts            commander entry: login, list, games {add,remove,move}, start
  config.ts         load/save config.json (priority games, settings)
  auth.ts           device-code login (Twitch TV/Android client), token save + validate
  twitch/
    gql.ts          GQL client: auth headers, client-id, retries, error typing
    queries.ts      getCampaigns, getInventory, getDropsChannels, claimDrop,
                    getStreamAccess, searchGame — all operation definitions live here
    watcher.ts      watch one channel: minute-watched beacon + low-quality HLS segment fetch
  miner.ts          state machine: select target, drive watcher, track progress, claim;
                    emits MinerState snapshots
  ui/
    Dashboard.tsx   Ink root; subscribes to miner state
    Header.tsx, CurrentTarget.tsx, Queue.tsx, EventLog.tsx
```

Rules:
- `miner.ts` is the only part that makes decisions. It depends on a `TwitchClient` interface (implemented by `queries.ts`), a `Watcher` interface and a clock, so tests can swap in fakes.
- The UI only renders `MinerState` and never calls Twitch.
- `MinerState` is a plain object, roughly:

```ts
type MinerState = {
  status: "mining" | "idle" | "error" | "login_required";
  user?: string;
  target?: {
    game: string; campaign: string; campaignEndsAt: Date;
    channel: { login: string; viewers: number };
    drop: { name: string; current: number; required: number };
    remainingDrops: { name: string; required: number }[];
  };
  queue: { game: string; state: "ready" | "not_linked" | "no_campaign" | "all_claimed"; detail?: string }[];
  nextCheckAt?: Date;
  error?: string;
  log: { at: Date; kind: "claim" | "switch" | "start" | "error" | "info"; message: string }[];
};
```

## Authentication

- `drops login` runs Twitch's device-code flow with a TV/Android client ID: it shows a code, the user enters it at twitch.tv/activate, and the tool polls until the token is issued.
- The token is saved to `auth.json` and validated on startup. If it's invalid, the status becomes `login_required`.
- The user's password never touches the tool.

## Mining loop

### Target selection

Runs at startup, every 15 minutes, on `r`, and after any switch trigger.

1. Fetch active campaigns and the user's inventory (progress and claimed drops).
2. Keep a campaign only if all of these hold:
   - its game is on the priority list (matched by Twitch game ID),
   - now is between its start and end,
   - it has at least one unclaimed drop,
   - it can be earned by watching (subscription-required drops are excluded),
   - it is linked to the user's account. Unlinked campaigns are reported in the queue as `not_linked`, with the link URL.
3. Sort by priority index, then by soonest campaign end.
4. Pick a channel for the top campaign:
   - If the campaign has an allow-list, use a live channel from it.
   - Otherwise, use live streams of the game with drops enabled.
   - In both cases, take the highest viewer count.
   - If no channel is found, try the next campaign.
5. If nothing qualifies, set status to `idle` and check again in 5 minutes.

### While mining

- Every 60s: the watcher sends the minute-watched beacon and fetches one segment of the lowest-quality HLS rendition. The segment fetch is on by default and can be turned off with `settings.fetchStream`.
- Every 3 minutes: fetch the inventory to get real progress. Between fetches, the UI adds +1 minute per minute (capped at the required minutes).
- A drop that is complete and has a claim ID is claimed right away, the claim is logged, and mining continues with the next drop.

### Switch triggers

- The channel goes offline, changes game or disables drops: pick a new channel for the same campaign.
- Progress doesn't change across 2 consecutive inventory fetches: switch channel.
- A higher-priority game gains an eligible campaign with a live channel (seen at the 15-minute re-check): switch target.
- The campaign is complete or expired: re-select.

## CLI

| Command | Behaviour |
|---|---|
| `drops login` | Device-code login |
| `drops list` | Table of all active campaigns: game, campaign, rewards with minutes, ends, linked, progress |
| `drops games` | Show priority list |
| `drops games add <name>` | Look up the game by name on Twitch and append it (asks the user to choose when the search is ambiguous) |
| `drops games remove <name>` | Remove it |
| `drops games move <name> <position>` | Reorder |
| `drops start` | Live dashboard |

## Dashboard

```
 Twitch Drops Miner · logged in as <you>                        ● MINING

 ▶ Rust — "Rust Twitch Drops Round 42"                  ends in 3d 4h
   channel: hjune (12.4k viewers)
   Hoodie       [██████████████░░░░░░]  42/60 min   ~18m left
   Next: Door Skin (120 min) · AK Skin (240 min)

 Queue (by priority)
   2. Marvel Rivals   1 campaign · 2 drops left       ready
   3. Valorant        ⚠ account not linked            <link url>
   4. Apex Legends    no active campaign

 Log
   14:02  ✔ Claimed: Rust — Bandana
   13:31  ↻ Switched channel: stream went offline
   12:58  ▶ Started: Rust → hjune

 q quit · r refresh now
```

- Header statuses: ● MINING, ◌ IDLE (with the next-check countdown), ⚠ ERROR (with the reason), LOGIN REQUIRED.
- The dashboard shows the last 10 log entries. All entries are also appended to `log.txt`.
- Keys: `q` stops the watcher, flushes the log and restores the terminal; `r` re-selects the target immediately. Ctrl+C behaves like `q`.

## Error handling

| Situation | Behaviour |
|---|---|
| Network error or 5xx | Retry with backoff of 5s, 15s, 60s, then every 5 min. Status shows ⚠ and the miner keeps running. |
| 401 or invalid token | Stop the watcher and set `login_required`. No retries. |
| GQL operation error (schema or hash changed) | Log the operation name and error, show "Twitch API changed: `<op>` failed", go idle and retry later. |
| HLS fetch fails | Non-fatal; the beacon continues. Persistent failure is caught by the stall trigger. |
| Claim fails | Retry at the next inventory fetch and log it. |

## Testing

- **Miner (main focus):** fake `TwitchClient`, fake `Watcher` and fake clock. Cases:
  - selection by priority, then by soonest end
  - unlinked and subscription-only campaigns skipped
  - idle when nothing qualifies
  - channel switch when the channel goes offline
  - stall switch
  - switch to a higher-priority game
  - auto-claim
  - 401 leads to `login_required`
- **Parsing:** recorded sample Twitch responses in `test/fixtures/`, checked against the parsed domain objects.
- **UI:** `ink-testing-library` snapshots of each component for each status.
- **Live check (manual):**
  1. Run `drops login` and `drops list` against the real account.
  2. Run `drops start` for about 15 minutes.
  3. Confirm progress increases on twitch.tv/drops/inventory.
  4. Repeat with `fetchStream: false` to see whether the beacon alone is enough.

## Open item (resolved during implementation)

Before building `watcher.ts` and `queries.ts`, check the current state of Twitch's internal API: GQL operation names and persisted-query hashes, how the beacon URL is found, and the client IDs. Reference DevilXD/TwitchDropsMiner for this. Record what is found in `queries.ts` comments.
