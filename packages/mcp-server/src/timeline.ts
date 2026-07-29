import type { AgentLensEvent, InteractionEvent } from '@agentlensjs/shared';

export interface TimelineGroup {
  interaction: InteractionEvent;
  /** Events attributed to this interaction, oldest first. */
  effects: AgentLensEvent[];
}

export interface Timeline {
  groups: TimelineGroup[];
  /** Events that happened outside any interaction window (e.g. on page load). */
  background: AgentLensEvent[];
}

export interface TimelineOptions {
  /** Max time after an interaction during which events are attributed to it. */
  windowMs?: number;
}

const DEFAULT_WINDOW_MS = 3000;

/**
 * Folds a flat, time-ordered event stream into cause-and-effect groups:
 * each interaction collects the events that follow it within the window,
 * cut short by the next interaction. Everything else is background noise.
 *
 * Error records are folded by fingerprint in the store and carry the
 * timestamp of their latest occurrence, so a recurring error is attributed
 * to the interaction that triggered it most recently.
 */
export function buildTimeline(
  events: readonly AgentLensEvent[],
  options: TimelineOptions = {},
): Timeline {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);

  const groups: TimelineGroup[] = [];
  const background: AgentLensEvent[] = [];
  let current: TimelineGroup | null = null;

  for (const event of ordered) {
    if (event.type === 'interaction') {
      current = { interaction: event, effects: [] };
      groups.push(current);
      continue;
    }
    if (current && event.timestamp - current.interaction.timestamp <= windowMs) {
      current.effects.push(event);
    } else {
      background.push(event);
    }
  }

  return { groups, background };
}
