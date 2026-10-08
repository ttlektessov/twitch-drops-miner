import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addGame, assertConfigReadable, ConfigError, loadConfig, moveGame, removeGame, saveConfig, type Config,
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

describe('assertConfigReadable', () => {
  it('passes for a missing or valid file', () => {
    const dir = tmp();
    expect(() => assertConfigReadable(dir)).not.toThrow();
    saveConfig(withGames(rust), dir);
    expect(() => assertConfigReadable(dir)).not.toThrow();
  });

  it('refuses a corrupt file so an edit cannot overwrite the list', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.json'), '{ "priorityGames": [1,], }');
    expect(() => assertConfigReadable(dir)).toThrow(/not valid JSON/);
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
