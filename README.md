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
