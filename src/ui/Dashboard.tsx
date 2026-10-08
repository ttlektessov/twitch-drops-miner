import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { MinerState } from '../miner.js';
import { CurrentTarget } from './CurrentTarget.js';
import { EventLog } from './EventLog.js';
import { Header } from './Header.js';
import { Queue } from './Queue.js';

export type MinerLike = {
  subscribe(listener: (state: MinerState) => void): () => void;
  refresh(): void;
};

export function Dashboard({ miner, onQuit }: { miner: MinerLike; onQuit: () => void }) {
  const [state, setState] = useState<MinerState | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => miner.subscribe(setState), [miner]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) onQuit();
    else if (input === 'r') miner.refresh();
  });

  if (!state) return <Text>Starting…</Text>;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header state={state} now={now} />
      {state.target && <CurrentTarget target={state.target} now={now} />}
      <Queue queue={state.queue} />
      <EventLog log={state.log} />
      <Box marginTop={1}>
        <Text dimColor>q quit · r refresh now</Text>
      </Box>
    </Box>
  );
}
