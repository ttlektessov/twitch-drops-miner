import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Call before editing the list: a corrupt file would otherwise load as empty and be overwritten.
export function assertConfigReadable(dir = dataDir()): void {
  const path = join(dir, 'config.json');
  if (existsSync(path) && readJson(path) === null) {
    throw new ConfigError(`${path} is not valid JSON. Fix or delete it, then try again.`);
  }
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
