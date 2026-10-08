import { Box, Text } from 'ink';
import type { TargetView } from '../miner.js';
import { formatDuration, formatViewers, progressBar } from './format.js';

export function CurrentTarget({ target, now }: { target: TargetView; now: Date }) {
  const { drop } = target;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold color="magenta">▶ {target.game} — "{target.campaign}"</Text>
        <Text dimColor>ends in {formatDuration(target.campaignEndsAt.getTime() - now.getTime())}</Text>
      </Box>
      <Text>  channel: {target.channel.login} ({formatViewers(target.channel.viewers)} viewers)</Text>
      {drop ? (
        <Text>
          {'  '}{drop.name}  [{progressBar(drop.current, drop.required)}]  {drop.current}/{drop.required} min
          {'   '}~{formatDuration((drop.required - drop.current) * 60_000)} left
        </Text>
      ) : (
        <Text dimColor>  Waiting for the next drop to unlock</Text>
      )}
      {target.remainingDrops.length > 0 && (
        <Text dimColor>
          {'  '}Next: {target.remainingDrops.map((d) => `${d.name} (${d.required} min)`).join(' · ')}
        </Text>
      )}
    </Box>
  );
}
