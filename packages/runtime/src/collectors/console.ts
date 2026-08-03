import type { ConsoleLevel } from '@agentlensjs/shared';

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
    // Keep the unbound original so teardown restores the exact function
    // identity — a bound copy would drift it forever and stack a wrapper
    // per HMR install/teardown cycle.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored as-is and invoked via .apply(console)
    const original = console[level];
    originals.set(level, original);
    console[level] = (...args: unknown[]) => {
      // Isolated: a serialization bug must not turn console.log into a
      // throwing function — observing must never break the observed.
      try {
        sink.send(buildConsoleEvent(context, level, args));
      } catch {
        // Swallowed by design; the app's own logging always proceeds.
      }
      original.apply(console, args);
    };
  }

  return () => {
    for (const [level, original] of originals) {
      console[level] = original;
    }
  };
}
