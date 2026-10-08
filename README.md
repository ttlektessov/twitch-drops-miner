# twitch-drops-miner

A lightweight terminal tool that earns Twitch Drops for the games you care about, without playing any video.

You give it an ordered list of priority games. It picks the best active campaign, watches one live channel in the background, shows progress in a live terminal dashboard, switches channels when a stream dies or stops counting, and claims drops as soon as they finish.

> **Warning:** automated viewing is against Twitch's Terms of Service. Use it at your own risk, on your own account.

## Status

| Area | State |
|---|---|
| Login (device code at twitch.tv/activate) | Verified on a real account |
| Finding campaigns (`drops list`) | Verified on a real account |
| Earning progress and claiming (`drops start`) | Covered by tests; not yet confirmed on a live account |

Twitch changed its internal API around 2026-09-18. See [Twitch changes](#twitch-changes) for what that means here.

## Requirements

- Node.js 22 or newer
- A Twitch account. For most rewards, your game account must also be linked; the link URL is on each campaign at twitch.tv/drops/campaigns.

## Install

```bash
git clone <this repo>
cd twitch-drops-miner
npm install
npm run build
npm link          # makes the `drops` command available everywhere
```

To run it without `npm link`, use `node dist/cli.js <command>` instead of `drops <command>`.

## Quick start

```bash
drops login                          # shows a code; enter it at twitch.tv/activate
drops games add Rainbow Six Siege    # exact game name as shown on Twitch
drops games add Phasmophobia
drops list                           # what can be mined right now
drops start                          # start mining (q to quit)
```

## Commands

| Command | What it does |
|---|---|
| `drops login` | Log in with a one-time code at twitch.tv/activate. Your password never touches this tool. |
| `drops list` | Campaigns you have already started, plus campaigns live right now on your priority games' channels, with each drop's progress. |
| `drops games` | Show your priority list. |
| `drops games add <name>` | Add a game to the end of the list. The name must match Twitch's game name; capitalisation doesn't matter. |
| `drops games remove <name>` | Remove a game. |
| `drops games move "<name>" <position>` | Move a game to a position (1 = highest). |
| `drops start` | Open the live dashboard and start mining. Keys: `q` quit, `r` re-check now. |

You can edit the priority list from another terminal while `drops start` is running. The change applies at the next check.

## The dashboard

```
 Twitch Drops Miner · logged in as you                          ● MINING

 ▶ Rainbow Six Siege — "R6S S2 2026 15"                  ends in 1d 11h
   channel: rainbow6 (12.4k viewers)
   Esports Pack  [████████████░░░░░░░░]  110/180 min   ~1h 10m left
   Next: Esports Pack (360 min) · Esports Pack (540 min)

 Queue (by priority)
   2. Phasmophobia  ready  1 campaign · 1 drop left

 Log
   14:02  ✔ Claimed: Rainbow Six Siege — Esports Pack
   13:31  ↻ Switched channel (stream went offline): a → b
```

| Status | Meaning |
|---|---|
| ● MINING | Watching a channel for the current drop. |
| ◌ IDLE | No priority game has an earnable campaign with a live channel. Checks again every 5 minutes. |
| ⚠ ERROR | Network problem or a Twitch API change. The line under it says which, and when it retries. |
| LOGIN REQUIRED | The login expired or was revoked. Quit and run `drops login`. |

Progress between checks is estimated (+1 minute per minute). Real progress is read from Twitch every 3 minutes.

## How it decides what to mine

1. Every 15 minutes, and whenever something changes, it collects active campaigns for your priority games.
2. It skips campaigns that:
   - are not linked to your account,
   - only have subscription-based drops,
   - have every drop already claimed,
   - or are not running yet.
3. It takes the highest-priority game. If that game has several campaigns, it takes the one that ends soonest.
4. It watches the most-viewed live channel that counts for that campaign: one of the allowed channels, or any drops-enabled stream of the game.
5. It switches channel when the stream goes offline, changes game, or shows no progress across two checks (about 6 minutes).
6. It switches game when a higher-priority game gets an earnable campaign.
7. It claims each drop as soon as it completes.

It mines one campaign at a time, because Twitch counts progress on one channel at a time.

"Watching" means two small requests a minute and no video:
- a "minute-watched" event, the same one Twitch's own player sends;
- a HEAD request for the newest segment of the lowest-quality stream, which downloads no video bytes.

## Files

Everything lives in `~/.twitch-drops-miner/` (on Windows `C:\Users\<you>\.twitch-drops-miner\`). Set the `TDM_HOME` environment variable to use a different folder.

| File | Contents |
|---|---|
| `config.json` | Priority games and settings |
| `auth.json` | Your Twitch login token. Keep it private, and delete it to log out. |
| `log.txt` | Every event the dashboard showed (claims, switches, errors) |
| `debug.jsonl` | Raw Twitch responses, only written when `TDM_DEBUG=1` is set |

Settings in `config.json`:

```json
{ "settings": { "fetchStream": true } }
```

`fetchStream: false` turns off the stream-segment requests and sends only the "minute-watched" event.

## Troubleshooting

| You see | What to do |
|---|---|
| `no active campaign` for a game you know has drops | The campaign is only found while one of its channels is live with drops enabled. Wait, or press `r` later. Check that the name in `drops games` is the right game. |
| `link unknown` in `drops list` | Twitch doesn't report linking for campaigns found on live channels. Make sure the game account is linked at twitch.tv/drops/campaigns. |
| `⚠ account not linked` in the queue | Open the shown link URL and link your game account. |
| `Minute-watched beacon keeps failing` in the log | Twitch probably changed its player. Drops won't progress until the tool is updated. |
| Repeated `Switched channel (no progress …)` | The channels aren't counting for you. Check that the campaign is linked and not already complete on twitch.tv/drops/inventory. |
| `Twitch API changed: <operation> failed` | Twitch changed an internal query. See [When Twitch changes something](#when-twitch-changes-something). |
| `Your Twitch login expired` | Run `drops login` again. |
| `config.json is not valid JSON` | Fix the file or delete it. The tool won't overwrite a broken config. |

## Twitch changes

Around 2026-09-18 Twitch made two changes that affect every third-party drops miner:

- **Login:** device-code login no longer accepts the Android app client. This tool uses the Android TV client instead.
- **Campaign list:** the full campaign list (`ViewerDropsDashboard`) and campaign details now come back empty for app clients. This tool builds the list from two sources instead:
  - your inventory, which holds the campaigns you have started, with full data;
  - the campaigns offered by live, drops-enabled channels of your priority games (`DropsHighlightService_AvailableDrops`).

  As a result:
  - `drops list` can't show every campaign on Twitch, only started ones and ones currently live for your priority games;
  - campaigns found this way show `link unknown` until they appear in your inventory.

## When Twitch changes something

1. Run a command with `TDM_DEBUG=1` to record raw responses to `~/.twitch-drops-miner/debug.jsonl`:
   - Windows cmd: `set TDM_DEBUG=1&& drops list`
   - bash: `TDM_DEBUG=1 drops list`
2. If an operation is reported as changed, update its hash in `src/twitch/queries.ts`. [DevilXD/TwitchDropsMiner](https://github.com/DevilXD/TwitchDropsMiner) usually has current values.
3. If the shape of a response changed, update `src/twitch/parse.ts`, which is the only file that reads raw Twitch JSON. Then refresh the matching fixture in `test/fixtures/`.

## Development

```bash
npm test            # vitest, all tests
npm run typecheck   # tsc --noEmit
npm run dev -- list # run from source with tsx
npm run build       # compile to dist/
```

| Path | Responsibility |
|---|---|
| `src/cli.tsx` | Command wiring (commander) |
| `src/miner.ts` | The only component that makes decisions: picks the target, switches, detects stalls, claims, and publishes state |
| `src/selection.ts` | Pure rules: eligibility, ranking, current drop, queue |
| `src/twitch/gql.ts` | GQL client: headers, retries, typed errors |
| `src/twitch/queries.ts` | Persisted-query hashes and the Twitch API (`TwitchApi`) |
| `src/twitch/parse.ts` | Raw Twitch JSON to domain types |
| `src/twitch/watcher.ts` | Minute-watched event and stream segment HEAD |
| `src/auth.ts`, `src/config.ts` | Login and local files |
| `src/ui/` | Ink dashboard components |
| `docs/superpowers/` | Design spec and implementation plan |
