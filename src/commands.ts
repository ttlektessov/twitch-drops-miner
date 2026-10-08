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
