import type { ConsoleLevel } from '@agentlens/shared';

import type { EventContext } from '../events';
import { buildConsoleEvent } from '../events';
import type { EventSink } from '../transport';

const LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

/**
 * Proxies console methods so agent-visible logs are captured while the
 * original console behavior stays intact. Returns a teardown function.
 */
export function installConsoleCollector(sink: EventSink, context: EventContext): () => void {
  const originals = new Map<ConsoleLevel, (typeof console)['log']>();

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    originals.set(level, original);
    console[level] = (...args: unknown[]) => {
      sink.send(buildConsoleEvent(context, level, args));
      original(...args);
    };
  }

  return () => {
    for (const [level, original] of originals) {
      console[level] = original;
    }
  };
}
