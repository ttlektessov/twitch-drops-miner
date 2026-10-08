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
