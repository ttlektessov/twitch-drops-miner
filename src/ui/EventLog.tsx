import { Box, Text } from 'ink';
import type { LogEntry, LogKind } from '../miner.js';
import { formatClock } from './format.js';

const ICONS: Record<LogKind, string> = { claim: '✔', switch: '↻', start: '▶', error: '⚠', info: '·' };

export function EventLog({ log }: { log: LogEntry[] }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Log</Text>
      {log.length === 0 ? (
        <Text dimColor>  nothing yet</Text>
      ) : (
        log.map((entry, i) => (
          <Text key={i} color={entry.kind === 'error' ? 'red' : undefined}>
            {'  '}{formatClock(entry.at)}  {ICONS[entry.kind]} {entry.message}
          </Text>
        ))
      )}
    </Box>
  );
}
