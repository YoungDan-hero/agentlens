import type { InteractionTarget } from '@agentlensjs/shared';
import { SOURCE_ATTRIBUTE } from '@agentlensjs/shared';

import type { EventContext } from '../events';
import { buildInteractionEvent } from '../events';
import type { EventSink } from '../transport';

const MAX_TEXT_LENGTH = 40;
const INPUT_DEBOUNCE_MS = 500;

/** Describes the interacted element for the timeline. */
export function describeTarget(element: Element): InteractionTarget {
  const text = element.textContent.replace(/\s+/g, ' ').trim();
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id === '' ? null : element.id,
    text:
      text.length === 0
        ? null
        : text.length > MAX_TEXT_LENGTH
          ? `${text.slice(0, MAX_TEXT_LENGTH)}…`
          : text,
    // Clicks often land on an untagged child (e.g. a span inside a button);
    // the nearest tagged ancestor is the meaningful attribution.
    source: element.closest(`[${SOURCE_ATTRIBUTE}]`)?.getAttribute(SOURCE_ATTRIBUTE) ?? null,
  };
}

/**
 * Records user interactions (clicks, debounced input, form submits) so the
 * daemon can group subsequent errors, requests and logs under the
 * interaction that triggered them — turning a flat event stream into a
 * cause-and-effect timeline.
 */
export function installInteractionCollector(sink: EventSink, context: EventContext): () => void {
  const lastInputAt = new WeakMap<EventTarget, number>();

  // `!isTrusted` marks interactions synthesized by the action channel (or
  // application code), giving the daemon an audit trail of agent activity.
  const onClick = (event: MouseEvent): void => {
    if (event.target instanceof Element) {
      sink.send(
        buildInteractionEvent(context, 'click', describeTarget(event.target), !event.isTrusted),
      );
    }
  };

  const onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    // Typing bursts collapse into one event per debounce window and target.
    const now = Date.now();
    const last = lastInputAt.get(target) ?? 0;
    if (now - last < INPUT_DEBOUNCE_MS) {
      return;
    }
    lastInputAt.set(target, now);
    sink.send(buildInteractionEvent(context, 'input', describeTarget(target), !event.isTrusted));
  };

  const onSubmit = (event: Event): void => {
    if (event.target instanceof Element) {
      sink.send(
        buildInteractionEvent(context, 'submit', describeTarget(event.target), !event.isTrusted),
      );
    }
  };

  document.addEventListener('click', onClick, { capture: true });
  document.addEventListener('input', onInput, { capture: true });
  document.addEventListener('submit', onSubmit, { capture: true });

  return () => {
    document.removeEventListener('click', onClick, { capture: true });
    document.removeEventListener('input', onInput, { capture: true });
    document.removeEventListener('submit', onSubmit, { capture: true });
  };
}
