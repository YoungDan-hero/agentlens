import type { ActionStep, ActionTarget, InteractionEvent } from '@agentlensjs/shared';

import type { ErrorContextOptions, ErrorContextRef } from './error-context';
import { buildErrorContext } from './error-context';
import type { EventStore } from './store';

/**
 * An executable reproduction script derived from the interactions that
 * preceded an error, ready to feed into the action sequence channel.
 */
export interface ReplayScript {
  /** Identity of the error the script reproduces. */
  errorId: string;
  fingerprint: string | null;
  errorMessage: string;
  /** Where the error happened — navigate here first if the page moved on. */
  errorUrl: string;
  /** Session the interactions were recorded in (may have ended since). */
  recordedSessionId: string;
  /** Steps in replay order, derived from the preceding interactions. */
  steps: ActionStep[];
  /**
   * Indices of input steps whose typed value was not captured (values are
   * never recorded). Supply them via `values` before executing.
   */
  needsValue: number[];
  /** Anything that reduces replay fidelity — read before trusting a run. */
  warnings: string[];
  /** True when every step can run as-is once `needsValue` is satisfied. */
  executable: boolean;
}

export interface ReplayScriptFailure {
  error: string;
}

/**
 * Prefers the stable source attribution, falls back to an id selector, then
 * to visible text. Null when the recorded target had none of the three.
 */
function locatorFor(interaction: InteractionEvent): ActionTarget | null {
  const { target } = interaction;
  if (target.source !== null) {
    return { source: target.source };
  }
  if (target.id !== null) {
    // Attribute-selector form with JSON quoting: valid CSS for any id
    // without needing the browser-only CSS.escape here in Node.
    return { selector: `[id=${JSON.stringify(target.id)}]` };
  }
  if (target.text !== null) {
    // The collector truncates long text and appends an ellipsis; the text
    // locator matches by substring, so the ellipsis must go — it does not
    // exist in the real DOM text.
    const text = target.text.replace(/…$/, '').trim();
    if (text !== '') {
      return { text };
    }
  }
  return null;
}

/**
 * Turns the interactions preceding an error into an action sequence script.
 * Pure derivation — executing it is the caller's decision (dry run first).
 */
export function buildReplayScript(
  store: EventStore,
  ref: ErrorContextRef = {},
  options: ErrorContextOptions = {},
): ReplayScript | ReplayScriptFailure {
  const context = buildErrorContext(store, ref, options);
  // Presence of the interactions field is what separates a context from a
  // failure — both shapes have an `error` property (record vs message).
  if (!('precedingInteractions' in context)) {
    return { error: context.error };
  }

  const warnings: string[] = [];
  const steps: ActionStep[] = [];
  const needsValue: number[] = [];
  let executable = true;

  // Synthetic interactions are leftovers of previous agent runs, not the
  // human reproduction path — replaying them would compound artifacts.
  const humanInteractions = context.precedingInteractions.filter(
    (interaction) => interaction.synthetic !== true,
  );
  if (humanInteractions.length < context.precedingInteractions.length) {
    warnings.push('skipped agent-driven (synthetic) interactions from a previous run');
  }
  if (humanInteractions.length === 0) {
    return {
      error:
        'No human interactions preceded this error, so there is no path to replay. ' +
        'If the error happens on load, reload the page (perform_action navigate) instead.',
    };
  }

  for (const interaction of humanInteractions) {
    if (interaction.subtype === 'submit') {
      // The click/Enter that caused the submit is its own interaction event;
      // replaying the submit as well would fire the handler twice.
      warnings.push('dropped a submit event (covered by the click that triggered it)');
      continue;
    }
    const target = locatorFor(interaction);
    if (target === null) {
      warnings.push(
        `step for <${interaction.target.tag}> has no usable locator (no source/id/text); ` +
          'the script cannot run as-is — locate it manually and use perform_actions',
      );
      executable = false;
      continue;
    }
    if (interaction.subtype === 'input') {
      needsValue.push(steps.length);
      steps.push({ action: 'input', target });
    } else {
      steps.push({ action: 'click', target });
    }
  }

  if (steps.length === 0) {
    return {
      error:
        'None of the preceding interactions could be turned into replayable steps ' +
        '(see get_error_context for the raw interaction list).',
    };
  }

  return {
    errorId: context.error.id,
    fingerprint: context.error.fingerprint ?? null,
    errorMessage: context.error.message,
    errorUrl: context.error.url,
    recordedSessionId: context.error.sessionId,
    steps,
    needsValue,
    warnings,
    executable,
  };
}
