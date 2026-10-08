#!/usr/bin/env node
import { Command } from 'commander';
import { render } from 'ink';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_ID, CLIENT_URL, loadSession, pollForToken, saveSession, startDeviceLogin, USER_AGENT, validateToken, type Session,
} from './auth.js';
import { appendLog, formatCampaignList, formatGames } from './commands.js';
import { addGame, assertConfigReadable, dataDir, loadConfig, moveGame, removeGame, saveConfig } from './config.js';
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
    new GqlClient({ token: session.token, clientId: CLIENT_ID, deviceId: session.deviceId, userAgent: USER_AGENT, clientUrl: CLIENT_URL }),
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
    assertConfigReadable();
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
    assertConfigReadable();
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
    assertConfigReadable();
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
  // process.exit() right after a fetch crashes Node 24 on Windows (libuv UV_HANDLE_CLOSING assertion).
  process.exitCode = 1;
});
