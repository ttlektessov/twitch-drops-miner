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
