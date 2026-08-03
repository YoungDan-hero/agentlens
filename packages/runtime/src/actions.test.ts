// @vitest-environment jsdom
import type {
  ActionRequest,
  ActionSequenceRequest,
  ActionStep,
  ErrorEvent,
  NetworkEvent,
} from '@agentlensjs/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { ActionExecutor } from './actions';
import { createActionExecutor } from './actions';

let executor: ActionExecutor | null = null;

/** Fast settle windows so tests stay quick but deterministic. */
function makeExecutor(overrides: Partial<Parameters<typeof createActionExecutor>[0]> = {}) {
  executor = createActionExecutor({
    enabled: true,
    quietMs: 80,
    maxSettleMs: 600,
    userActivityWindowMs: 200,
    ...overrides,
  });
  return executor;
}

function request(partial: Partial<ActionRequest> & Pick<ActionRequest, 'action'>): ActionRequest {
  return { kind: 'action-request', requestId: 'r1', ...partial };
}

function sequence(steps: ActionStep[]): ActionSequenceRequest {
  return { kind: 'action-sequence-request', requestId: 'seq1', steps };
}

function makeError(): ErrorEvent {
  return {
    id: 'e1',
    type: 'error',
    subtype: 'uncaught',
    timestamp: Date.now(),
    sessionId: 's1',
    url: 'http://localhost/',
    message: 'boom',
    stack: null,
    frames: [],
    occurrences: 1,
  };
}

function makeFailedRequest(): NetworkEvent {
  return {
    id: 'n1',
    type: 'network',
    timestamp: Date.now(),
    sessionId: 's1',
    url: 'http://localhost/',
    transport: 'fetch',
    method: 'GET',
    requestUrl: 'http://localhost/api',
    status: 500,
    durationMs: 10,
    initiatorStack: null,
    initiatorFrames: [],
    requestBody: null,
    responseBody: null,
  };
}

afterEach(() => {
  executor?.dispose();
  executor = null;
  document.body.innerHTML = '';
});

describe('safety gates', () => {
  it('refuses everything when actions are not enabled', async () => {
    const exec = makeExecutor({ enabled: false });
    const result = await exec.handle(request({ action: 'click', target: { selector: 'body' } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('allowActions: true');
  });

  it('refuses while the user is actively interacting, then recovers', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const exec = makeExecutor();

    exec.noteUserActivity();
    const refused = await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('human input wins');

    // Past the activity window the same action goes through.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const allowed = await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    expect(allowed.ok).toBe(true);
  });

  it('refuses action kinds it does not know (daemon/runtime version skew)', async () => {
    const exec = makeExecutor();
    const result = await exec.handle({
      kind: 'action-request',
      requestId: 'r1',
      action: 'hover' as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unsupported action "hover"');
  });

  it('runs one action at a time', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const exec = makeExecutor();

    const first = exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    const second = await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    expect(second.ok).toBe(false);
    expect(second.error).toContain('one at a time');
    expect((await first).ok).toBe(true);
  });
});

describe('target resolution', () => {
  it('locates by source attribute, selector and visible text (deepest match)', async () => {
    document.body.innerHTML = `
      <div>
        <button id="a" data-agentlens-source="src/App.vue:3"><span>Save draft</span></button>
      </div>`;
    const exec = makeExecutor();

    for (const target of [
      { source: 'src/App.vue:3' },
      { selector: '#a' },
      // Deepest-match: the wrapping div and button match too; the span wins.
      { text: 'Save draft' },
    ]) {
      const result = await exec.handle(request({ action: 'click', target }));
      expect(result.ok).toBe(true);
    }
  });

  it('reports missing targets, ambiguity and nth handling', async () => {
    document.body.innerHTML = '<button class="x">One</button><button class="x">Two</button>';
    const exec = makeExecutor();

    const missing = await exec.handle(request({ action: 'click', target: { selector: '#nope' } }));
    expect(missing.error).toContain('no element matches');

    const ambiguous = await exec.handle(request({ action: 'click', target: { selector: '.x' } }));
    expect(ambiguous.error).toContain('pass nth');

    const outOfRange = await exec.handle(
      request({ action: 'click', target: { selector: '.x', nth: 5 } }),
    );
    expect(outOfRange.error).toContain('out of range');

    const picked = await exec.handle(
      request({ action: 'click', target: { selector: '.x', nth: 1 } }),
    );
    expect(picked.ok).toBe(true);
    expect(picked.target?.text).toBe('Two');
  });

  it('rejects invalid selectors and empty locators without throwing', async () => {
    const exec = makeExecutor();
    const invalid = await exec.handle(request({ action: 'click', target: { selector: ':::' } }));
    expect(invalid.error).toContain('invalid CSS selector');

    const empty = await exec.handle(request({ action: 'click', target: {} }));
    expect(empty.error).toContain('needs a target');

    const noTarget = await exec.handle(request({ action: 'click' }));
    expect(noTarget.error).toContain('needs a target');

    // A blank text needle would otherwise match every element on the page.
    const blankText = await exec.handle(request({ action: 'click', target: { text: '   ' } }));
    expect(blankText.error).toContain('text locator is empty');
  });

  it('refuses hidden and disabled elements', async () => {
    document.body.innerHTML = `
      <button id="hidden" style="display:none">A</button>
      <div hidden><button id="nested">B</button></div>
      <button id="off" disabled>C</button>`;
    const exec = makeExecutor();

    expect(
      (await exec.handle(request({ action: 'click', target: { selector: '#hidden' } }))).error,
    ).toContain('hidden');
    expect(
      (await exec.handle(request({ action: 'click', target: { selector: '#nested' } }))).error,
    ).toContain('[hidden]');
    expect(
      (await exec.handle(request({ action: 'click', target: { selector: '#off' } }))).error,
    ).toContain('disabled');
  });

  it('refuses elements inside a display:none ancestor', async () => {
    // display does not inherit: the button's own computed style is fine,
    // only a walk up the ancestor chain reveals it is not rendered.
    document.body.innerHTML = '<div style="display:none"><button id="collapsed">A</button></div>';
    const exec = makeExecutor();

    const result = await exec.handle(
      request({ action: 'click', target: { selector: '#collapsed' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('hidden');
  });
});

describe('click', () => {
  it('fires activation behavior and reports the acted-on element', async () => {
    document.body.innerHTML =
      '<button id="go" data-agentlens-source="src/App.vue:9">Go</button>' +
      '<input id="check" type="checkbox" />';
    let clicks = 0;
    document.getElementById('go')?.addEventListener('click', () => (clicks += 1));
    const exec = makeExecutor();

    const result = await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    expect(clicks).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.target?.source).toBe('src/App.vue:9');

    // HTMLElement.click() runs real activation: the checkbox must toggle.
    await exec.handle(request({ action: 'click', target: { selector: '#check' } }));
    expect((document.getElementById('check') as HTMLInputElement).checked).toBe(true);
  });

  it('emits the real-browser event order when PointerEvent is available', async () => {
    // jsdom has no PointerEvent constructor; install a minimal stand-in so
    // the guarded pointer dispatch path runs like in a real browser.
    const globalWithPointer = globalThis as { PointerEvent?: unknown };
    const hadPointerEvent = typeof globalWithPointer.PointerEvent === 'function';
    if (!hadPointerEvent) {
      globalWithPointer.PointerEvent = class extends MouseEvent {};
    }
    try {
      document.body.innerHTML = '<button id="go">Go</button>';
      const button = document.getElementById('go') as HTMLButtonElement;
      const order: string[] = [];
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        button.addEventListener(type, () => {
          order.push(type);
        });
      }
      const exec = makeExecutor();

      const result = await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
      expect(result.ok).toBe(true);
      expect(order).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    } finally {
      if (!hadPointerEvent) {
        delete globalWithPointer.PointerEvent;
      }
    }
  });

  it('focuses the target like a real interaction would', async () => {
    document.body.innerHTML = '<button id="go">Go</button><input id="name" type="text" />';
    const exec = makeExecutor();

    await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    expect(document.activeElement?.id).toBe('go');

    await exec.handle(request({ action: 'input', target: { selector: '#name' }, value: 'Ada' }));
    expect(document.activeElement?.id).toBe('name');
  });

  it('restores the original outline after overlapping highlights', async () => {
    document.body.innerHTML = '<button id="go" style="outline: 1px dotted red">Go</button>';
    const button = document.getElementById('go') as HTMLButtonElement;
    // Fast settle so the second action starts while the first action's
    // highlight timer (600ms) is still pending.
    const exec = makeExecutor({ quietMs: 30, maxSettleMs: 100 });

    await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    await exec.handle(request({ action: 'click', target: { selector: '#go' } }));

    // After every highlight timer has fired, the element must carry its own
    // outline again — not a leftover of the first highlight.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(button.style.outline).toBe('1px dotted red');
  });

  it('survives a handler that throws synchronously', async () => {
    document.body.innerHTML = '<button id="boom">Boom</button>';
    document.getElementById('boom')?.addEventListener('click', () => {
      throw new Error('render crash');
    });
    // In production the error collector observes this via window.onerror;
    // here we absorb it so the runner does not flag an unhandled error.
    // (Typed as Event: the DOM ErrorEvent name is shadowed by the shared
    // protocol import, and preventDefault is all we need.)
    const absorb = (event: Event): void => {
      event.preventDefault();
    };
    window.addEventListener('error', absorb);
    const exec = makeExecutor();

    const result = await exec.handle(request({ action: 'click', target: { selector: '#boom' } }));
    window.removeEventListener('error', absorb);
    // The click itself succeeded; the thrown error reaches window.onerror
    // and is captured as an error event, not an action failure.
    expect(result.ok).toBe(true);
  });
});

describe('input and select', () => {
  it('writes through the prototype setter so framework value trackers see it', async () => {
    document.body.innerHTML = '<input id="name" type="text" />';
    const input = document.getElementById('name') as HTMLInputElement;
    // Simulate a framework-installed own-property tracker: a naive
    // `element.value = ...` would hit this and never reach the internals.
    Object.defineProperty(input, 'value', {
      configurable: true,
      set: () => {
        throw new Error('own-property setter must be bypassed');
      },
      get: () => '',
    });
    let inputEvents = 0;
    input.addEventListener('input', () => (inputEvents += 1));
    const exec = makeExecutor();

    const result = await exec.handle(
      request({ action: 'input', target: { selector: '#name' }, value: 'Ada' }),
    );
    expect(result.ok).toBe(true);
    expect(inputEvents).toBe(1);
  });

  it('refuses readonly fields a real user could not type into', async () => {
    document.body.innerHTML = '<input id="ro" type="text" readonly />';
    const exec = makeExecutor();

    const result = await exec.handle(
      request({ action: 'input', target: { selector: '#ro' }, value: 'x' }),
    );
    expect(result.error).toContain('readonly');
    expect((document.getElementById('ro') as HTMLInputElement).value).toBe('');
  });

  it('rejects unsupported input targets with actionable messages', async () => {
    document.body.innerHTML =
      '<input id="check" type="checkbox" /><div id="div">x</div><input id="t" type="text" />';
    const exec = makeExecutor();

    expect(
      (await exec.handle(request({ action: 'input', target: { selector: '#check' }, value: 'x' })))
        .error,
    ).toContain('use a click action');
    expect(
      (await exec.handle(request({ action: 'input', target: { selector: '#div' }, value: 'x' })))
        .error,
    ).toContain('not a text input');
    expect(
      (await exec.handle(request({ action: 'input', target: { selector: '#t' } }))).error,
    ).toContain('needs a value');
  });

  it('selects options by value or label and lists alternatives on a miss', async () => {
    document.body.innerHTML = `
      <select id="lang">
        <option value="vue">Vue</option>
        <option value="react">React</option>
      </select>`;
    const select = document.getElementById('lang') as HTMLSelectElement;
    let changes = 0;
    select.addEventListener('change', () => (changes += 1));
    const exec = makeExecutor();

    const byValue = await exec.handle(
      request({ action: 'select', target: { selector: '#lang' }, value: 'react' }),
    );
    expect(byValue.ok).toBe(true);
    expect(select.value).toBe('react');

    const byLabel = await exec.handle(
      request({ action: 'select', target: { selector: '#lang' }, value: 'Vue' }),
    );
    expect(byLabel.ok).toBe(true);
    expect(select.value).toBe('vue');
    expect(changes).toBe(2);

    const miss = await exec.handle(
      request({ action: 'select', target: { selector: '#lang' }, value: 'svelte' }),
    );
    expect(miss.error).toContain('available values: vue, react');

    const wrongTag = await exec.handle(
      request({ action: 'select', target: { selector: 'body' }, value: 'x' }),
    );
    expect(wrongTag.error).toContain('not a <select>');
  });
});

describe('scroll and navigate', () => {
  it('scrolls to coordinates and rejects a scroll with neither target nor coords', async () => {
    const exec = makeExecutor();
    const toCoords = await exec.handle(request({ action: 'scroll', x: 0, y: 400 }));
    expect(toCoords.ok).toBe(true);

    const nothing = await exec.handle(request({ action: 'scroll' }));
    expect(nothing.error).toContain('either a target or both x and y');
  });

  it('allows same-origin hash navigation and refuses cross-origin', async () => {
    const exec = makeExecutor();

    const hash = await exec.handle(request({ action: 'navigate', url: '#/settings' }));
    expect(hash.ok).toBe(true);
    expect(window.location.hash).toBe('#/settings');

    const crossOrigin = await exec.handle(
      request({ action: 'navigate', url: 'https://evil.example/steal' }),
    );
    expect(crossOrigin.ok).toBe(false);
    expect(crossOrigin.error).toContain('cross-origin');

    const invalid = await exec.handle(request({ action: 'navigate', url: 'http://' }));
    expect(invalid.error).toContain('invalid url');

    const missing = await exec.handle(request({ action: 'navigate' }));
    expect(missing.error).toContain('needs a url');
  });
});

describe('settle and effects', () => {
  it('counts errors, failed requests and console errors triggered by the action', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const exec = makeExecutor();
    document.getElementById('go')?.addEventListener('click', () => {
      // Simulate collectors reporting the fallout of the click.
      exec.noteLocalEvent(makeError());
      exec.noteLocalEvent(makeFailedRequest());
    });

    const result = await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    expect(result.ok).toBe(true);
    expect(result.effects).toEqual({ errors: 1, failedRequests: 1, consoleErrors: 0 });
    expect(result.settleTimedOut).toBe(false);
    expect(result.settledAfterMs).toBeGreaterThanOrEqual(80);
  });

  it('reports a settle timeout when the page never goes quiet', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const exec = makeExecutor({ quietMs: 100, maxSettleMs: 300 });

    // A steady stream of events (e.g. a polling loop) keeps the page loud.
    const noisy = setInterval(() => {
      exec.noteLocalEvent(makeError());
    }, 40);
    const result = await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    clearInterval(noisy);

    expect(result.ok).toBe(true);
    expect(result.settleTimedOut).toBe(true);
    expect(result.settledAfterMs).toBeGreaterThanOrEqual(300);
  });
});

describe('action sequences', () => {
  it('runs steps in order and aggregates effects across them', async () => {
    document.body.innerHTML =
      '<input id="name" type="text" /><button id="submit">Submit</button><p id="out"></p>';
    const exec = makeExecutor();
    const order: string[] = [];
    document.getElementById('name')?.addEventListener('input', () => order.push('input'));
    document.getElementById('submit')?.addEventListener('click', () => {
      order.push('click');
      exec.noteLocalEvent(makeError());
    });

    const result = await exec.handleSequence(
      sequence([
        { action: 'input', target: { selector: '#name' }, value: 'Ada' },
        { action: 'click', target: { selector: '#submit' } },
      ]),
    );

    expect(result.ok).toBe(true);
    expect(result.stoppedAt).toBeNull();
    expect(result.stopReason).toBeNull();
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults.every((step) => step.ok)).toBe(true);
    expect(result.totalEffects).toEqual({ errors: 1, failedRequests: 0, consoleErrors: 0 });
    expect(order).toEqual(['input', 'click']);
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('Ada');
    expect(result.finalUrl).toContain('localhost');
  });

  it('stops at the first failing step and reports the break point', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const exec = makeExecutor();

    const result = await exec.handleSequence(
      sequence([
        { action: 'click', target: { selector: '#go' } },
        { action: 'click', target: { selector: '#missing' } },
        { action: 'click', target: { selector: '#go' } },
      ]),
    );

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe(1);
    expect(result.stopReason).toContain('no element matches');
    // The failing step's outcome is included; the third step never ran.
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]?.ok).toBe(true);
    expect(result.stepResults[1]?.ok).toBe(false);
  });

  it('waitFor rides out async UI: waits for an element to appear', async () => {
    document.body.innerHTML = '<div id="host"></div>';
    const exec = makeExecutor();
    // The button appears 150ms later, as if rendered after a fetch.
    setTimeout(() => {
      const button = document.createElement('button');
      button.id = 'late';
      button.textContent = 'Late';
      document.getElementById('host')?.append(button);
    }, 150);

    const result = await exec.handleSequence(
      sequence([
        { action: 'click', target: { selector: '#late' }, waitFor: { selector: '#late' } },
      ]),
    );

    expect(result.ok).toBe(true);
    expect(result.stepResults[0]?.target?.id).toBe('late');
  });

  it('waitFor timeout stops the sequence with an actionable reason', async () => {
    const exec = makeExecutor();

    const result = await exec.handleSequence(
      sequence([
        {
          action: 'click',
          target: { selector: '#never' },
          waitFor: { selector: '#never', timeoutMs: 150 },
        },
      ]),
    );

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe(0);
    expect(result.stopReason).toContain('waitFor timed out');
    expect(result.stepResults[0]?.error).toContain('never became visible');
  });

  it('waitFor hidden resolves once the element disappears', async () => {
    document.body.innerHTML = '<div id="spinner">loading…</div><button id="go">Go</button>';
    const exec = makeExecutor();
    setTimeout(() => {
      document.getElementById('spinner')?.remove();
    }, 120);

    const result = await exec.handleSequence(
      sequence([
        {
          action: 'click',
          target: { selector: '#go' },
          waitFor: { selector: '#spinner', state: 'hidden' },
        },
      ]),
    );

    expect(result.ok).toBe(true);
  });

  it('refuses navigate anywhere but the final step', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const exec = makeExecutor();

    const result = await exec.handleSequence(
      sequence([
        { action: 'navigate', url: '/#/somewhere' },
        { action: 'click', target: { selector: '#go' } },
      ]),
    );

    expect(result.ok).toBe(false);
    expect(result.stopReason).toContain('only allowed as the final step');
    expect(result.stepResults).toHaveLength(0);
  });

  it('refuses oversized and empty sequences outright', async () => {
    const exec = makeExecutor();

    const oversized = await exec.handleSequence(
      sequence(Array.from({ length: 21 }, (): ActionStep => ({ action: 'scroll', x: 0, y: 0 }))),
    );
    expect(oversized.ok).toBe(false);
    expect(oversized.stopReason).toContain('too many steps');

    const empty = await exec.handleSequence(sequence([]));
    expect(empty.ok).toBe(false);
    expect(empty.stopReason).toContain('no steps');
  });

  it('aborts between steps when the user takes over', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const exec = makeExecutor({ userActivityWindowMs: 5000 });
    // The user grabs the mouse while step 0 is settling.
    document.getElementById('go')?.addEventListener('click', () => {
      exec.noteUserActivity();
    });

    const result = await exec.handleSequence(
      sequence([
        { action: 'click', target: { selector: '#go' } },
        { action: 'click', target: { selector: '#go' } },
      ]),
    );

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe(1);
    expect(result.stopReason).toContain('human input wins');
    // Step 0 completed and is reported; step 1 was never attempted.
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]?.ok).toBe(true);
  });

  it('aborts when the user grabs the page during a waitFor poll', async () => {
    document.body.innerHTML = '<div id="host"></div>';
    const exec = makeExecutor({ userActivityWindowMs: 5000 });
    // The user starts typing while the sequence is still waiting for the
    // late element; the element then appears, but the step must not run.
    setTimeout(() => {
      exec.noteUserActivity();
    }, 50);
    setTimeout(() => {
      const button = document.createElement('button');
      button.id = 'late';
      document.getElementById('host')?.append(button);
    }, 150);

    const result = await exec.handleSequence(
      sequence([
        { action: 'click', target: { selector: '#late' }, waitFor: { selector: '#late' } },
      ]),
    );

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe(0);
    expect(result.stopReason).toContain('human input wins');
    expect(result.stepResults).toHaveLength(0);
    expect(document.getElementById('late')).not.toBeNull();
  });

  it('shares the single-action concurrency lock', async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const exec = makeExecutor();

    const first = exec.handleSequence(sequence([{ action: 'click', target: { selector: '#go' } }]));
    const second = await exec.handle(request({ action: 'click', target: { selector: '#go' } }));
    expect(second.ok).toBe(false);
    expect(second.error).toContain('one at a time');
    await first;
  });
});
