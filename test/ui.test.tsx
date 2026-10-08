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
