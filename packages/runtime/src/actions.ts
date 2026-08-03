import type {
  ActionEffects,
  ActionRequest,
  ActionResult,
  ActionTarget,
  AgentLensEvent,
} from '@agentlensjs/shared';
import { SOURCE_ATTRIBUTE } from '@agentlensjs/shared';

import { describeTarget } from './collectors/interactions';

/** Everything of an ActionResult the executor owns (envelope added by init). */
export type ActionOutcome = Omit<ActionResult, 'kind' | 'requestId' | 'sessionId'>;

export interface ActionExecutorOptions {
  /** Master switch — actions are refused entirely unless explicitly enabled. */
  enabled: boolean;
  /** Refuse actions when a trusted user input happened within this window. */
  userActivityWindowMs?: number;
  /** The page counts as settled after this long without new local events. */
  quietMs?: number;
  /** Ceiling on the settle wait. */
  maxSettleMs?: number;
}

export interface ActionExecutor {
  handle: (request: ActionRequest) => Promise<ActionOutcome>;
  /** Feed of locally captured events; drives settle detection and effects. */
  noteLocalEvent: (event: AgentLensEvent) => void;
  /**
   * Records a moment of real user activity. Called by the built-in trusted
   * input listeners; exposed so the conflict window is testable (jsdom
   * cannot synthesize `isTrusted` events).
   */
  noteUserActivity: () => void;
  dispose: () => void;
}

const KNOWN_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'input',
  'select',
  'scroll',
  'navigate',
]);
const DEFAULT_USER_ACTIVITY_WINDOW_MS = 1500;
const DEFAULT_QUIET_MS = 500;
const DEFAULT_MAX_SETTLE_MS = 5000;
const SETTLE_POLL_MS = 50;
const HIGHLIGHT_MS = 600;
/** More text matches than this means the locator is too ambiguous to trust. */
const MAX_TEXT_MATCHES = 50;
/** Input types where typing a value makes sense. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'color',
  'range',
]);

function zeroEffects(): ActionEffects {
  return { errors: 0, failedRequests: 0, consoleErrors: 0 };
}

function failure(error: string): ActionOutcome {
  return {
    ok: false,
    error,
    target: null,
    effects: zeroEffects(),
    settledAfterMs: 0,
    settleTimedOut: false,
  };
}

function describeLocator(target: ActionTarget): string {
  if (target.source !== undefined) {
    return `source "${target.source}"`;
  }
  if (target.selector !== undefined) {
    return `selector "${target.selector}"`;
  }
  if (target.text !== undefined) {
    return `text "${target.text}"`;
  }
  return 'an empty locator';
}

/**
 * Finds the elements whose visible text contains `text`, keeping only the
 * deepest matches — every ancestor of a matching element matches too, and
 * the deepest one is what a human would say they clicked.
 */
function findByText(text: string): Element[] | string {
  const needle = text.trim();
  // An empty needle would match every element on the page.
  if (needle === '') {
    return 'the text locator is empty';
  }
  const all = [...document.body.querySelectorAll('*')];
  const matches = all.filter((element) => element.textContent.trim().includes(needle));
  if (matches.length > MAX_TEXT_MATCHES) {
    return `text "${needle}" matches too many elements (${String(matches.length)}); use a longer text or a selector`;
  }
  return matches.filter(
    (element) => !matches.some((other) => other !== element && element.contains(other)),
  );
}

/** Resolves a locator to exactly one element, or returns an error message. */
function resolveTarget(target: ActionTarget | undefined): Element | string {
  if (
    !target ||
    (target.source === undefined && target.selector === undefined && target.text === undefined)
  ) {
    return 'this action needs a target: pass source, selector or text';
  }

  let matches: Element[];
  if (target.source !== undefined) {
    matches = [
      ...document.querySelectorAll(`[${SOURCE_ATTRIBUTE}="${CSS.escape(target.source)}"]`),
    ];
  } else if (target.selector !== undefined) {
    try {
      matches = [...document.querySelectorAll(target.selector)];
    } catch {
      return `invalid CSS selector "${target.selector}"`;
    }
  } else {
    const found = findByText(target.text ?? '');
    if (typeof found === 'string') {
      return found;
    }
    matches = found;
  }

  const first = matches[0];
  if (first === undefined) {
    return `no element matches ${describeLocator(target)}`;
  }
  if (target.nth !== undefined) {
    const picked = matches[target.nth];
    return (
      picked ??
      `nth=${String(target.nth)} is out of range: ${describeLocator(target)} matches ${String(matches.length)} element(s)`
    );
  }
  if (matches.length > 1) {
    return `${describeLocator(target)} matches ${String(matches.length)} elements; pass nth to disambiguate`;
  }
  return first;
}

/**
 * Interactable = attached and not hidden via CSS. Deliberately no
 * bounding-rect check: synthetic dispatch needs no hit-testing, zero-sized
 * inline wrappers are legitimate targets, and jsdom reports all rects as
 * zero which would make the executor untestable.
 */
function checkInteractable(element: Element): string | null {
  if (!element.isConnected) {
    return 'the element is no longer attached to the document';
  }
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return 'the element is hidden (display:none / visibility:hidden)';
  }
  if (element.closest('[hidden]')) {
    return 'the element is inside a [hidden] subtree';
  }
  if ('disabled' in element && (element as { disabled: unknown }).disabled === true) {
    return 'the element is disabled';
  }
  return null;
}

/**
 * Tracks in-flight highlights so overlapping actions on the same element
 * restore the element's own outline, not the highlight of a previous
 * action (which would leave the element permanently outlined).
 */
const activeHighlights = new WeakMap<
  Element,
  { outline: string; outlineOffset: string; timer: ReturnType<typeof setTimeout> }
>();

/** Briefly outlines the element so the user can see what the agent touched. */
function highlight(element: Element): void {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
    return;
  }
  const style = (element as HTMLElement).style;
  const existing = activeHighlights.get(element);
  if (existing) {
    clearTimeout(existing.timer);
  }
  // The pre-highlight values live in the WeakMap entry, never re-read from
  // a style that may currently hold our own highlight.
  const outline = existing?.outline ?? style.outline;
  const outlineOffset = existing?.outlineOffset ?? style.outlineOffset;
  style.outline = '2px solid #7c3aed';
  style.outlineOffset = '2px';
  const timer = setTimeout(() => {
    activeHighlights.delete(element);
    style.outline = outline;
    style.outlineOffset = outlineOffset;
  }, HIGHLIGHT_MS);
  activeHighlights.set(element, { outline, outlineOffset, timer });
}

/**
 * Focuses the element the way a real interaction would. `focus()` is a
 * no-op on non-focusable elements, so this is safe to call unconditionally.
 */
function focusTarget(element: Element): void {
  if (element instanceof HTMLElement || element instanceof SVGElement) {
    element.focus();
  }
}

function dispatchPointerEvent(element: Element, type: 'pointerdown' | 'pointerup'): void {
  // Guarded: jsdom has no PointerEvent constructor. Modern component
  // libraries (Radix, Headless UI) trigger on pointerdown rather than
  // mousedown/click, so skipping these would make their widgets unreachable.
  if (typeof PointerEvent !== 'function') {
    return;
  }
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  );
}

/** Real-browser order: pointerdown → mousedown → focus → pointerup → mouseup → click. */
function dispatchClick(element: Element): void {
  const eventInit = { bubbles: true, cancelable: true };
  dispatchPointerEvent(element, 'pointerdown');
  element.dispatchEvent(new MouseEvent('mousedown', eventInit));
  focusTarget(element);
  dispatchPointerEvent(element, 'pointerup');
  element.dispatchEvent(new MouseEvent('mouseup', eventInit));
  // HTMLElement.click() runs the real activation behavior (checkbox toggle,
  // form submission, label forwarding) — a plain click event does not.
  if (element instanceof HTMLElement) {
    element.click();
  } else {
    element.dispatchEvent(new MouseEvent('click', eventInit));
  }
}

/**
 * Writes the value through the prototype setter: React replaces the value
 * property with its own tracked accessor, and only a prototype-level write
 * followed by an `input` event makes React register the change.
 */
function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype = Object.getPrototypeOf(element) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via .call with an explicit receiver
  const setter = descriptor?.set;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
}

function dispatchValueEvents(element: Element): void {
  // `input` drives React and Vue v-model on text fields; `change` drives
  // v-model on selects and blur-style listeners. Both are harmless extras.
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function performInput(element: Element, value: string): string | null {
  if (element instanceof HTMLInputElement) {
    if (!TEXT_INPUT_TYPES.has(element.type)) {
      return `input type "${element.type}" cannot be typed into — use a click action instead`;
    }
  } else if (!(element instanceof HTMLTextAreaElement)) {
    return `<${element.tagName.toLowerCase()}> is not a text input; use click or select instead`;
  }
  // The prototype setter could force a value in, but a real user cannot
  // type into a readonly field — refusing keeps the test honest.
  if (element.readOnly) {
    return 'the element is readonly';
  }
  // Typing implies focus: autocomplete panels, validation-on-focus and
  // focus-visible styling all key off it (mirrors Playwright's fill()).
  focusTarget(element);
  setNativeValue(element, value);
  dispatchValueEvents(element);
  return null;
}

function performSelect(element: Element, value: string): string | null {
  if (!(element instanceof HTMLSelectElement)) {
    return `<${element.tagName.toLowerCase()}> is not a <select> element`;
  }
  const options = [...element.options];
  const match = options.find((option) => option.value === value || option.text.trim() === value);
  if (!match) {
    const available = options.map((option) => option.value).join(', ');
    return `no option matches "${value}" (available values: ${available})`;
  }
  focusTarget(element);
  setNativeValue(element, match.value);
  dispatchValueEvents(element);
  return null;
}

function performScroll(request: ActionRequest, element: Element | null): string | null {
  if (element) {
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    return null;
  }
  if (typeof request.x === 'number' && typeof request.y === 'number') {
    window.scrollTo(request.x, request.y);
    return null;
  }
  return 'scroll needs either a target or both x and y coordinates';
}

/**
 * Executes daemon-requested page actions with synthetic DOM events.
 *
 * Safety model: disabled unless the app opted in; refuses to act while the
 * user is actively interacting (human input always wins); one action at a
 * time; navigation is confined to the current origin; every synthetic
 * interaction is captured by the interaction collector with a `synthetic`
 * marker, so the store doubles as an audit log.
 */
export function createActionExecutor(options: ActionExecutorOptions): ActionExecutor {
  const userActivityWindowMs = options.userActivityWindowMs ?? DEFAULT_USER_ACTIVITY_WINDOW_MS;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const maxSettleMs = options.maxSettleMs ?? DEFAULT_MAX_SETTLE_MS;

  let lastTrustedInputAt = 0;
  let lastLocalEventAt = 0;
  let busy = false;
  let counting = false;
  let effects = zeroEffects();

  function noteUserActivity(): void {
    lastTrustedInputAt = Date.now();
  }

  // Trusted-input tracking: synthetic events carry isTrusted === false, so
  // the executor's own dispatches can never trip this detector.
  const onTrustedInput = (event: Event): void => {
    if (event.isTrusted) {
      noteUserActivity();
    }
  };
  const activityEvents = ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'wheel'] as const;
  for (const name of activityEvents) {
    document.addEventListener(name, onTrustedInput, { capture: true, passive: true });
  }

  function noteLocalEvent(event: AgentLensEvent): void {
    lastLocalEventAt = Date.now();
    if (!counting) {
      return;
    }
    if (event.type === 'error') {
      effects.errors += 1;
    } else if (event.type === 'console' && event.level === 'error') {
      effects.consoleErrors += 1;
    } else if (
      event.type === 'network' &&
      event.transport !== 'beacon' &&
      (event.status === null || event.status >= 400)
    ) {
      effects.failedRequests += 1;
    }
  }

  function settle(startedAt: number): Promise<{ settledAfterMs: number; settleTimedOut: boolean }> {
    return new Promise((resolve) => {
      const check = (): void => {
        const now = Date.now();
        if (now - Math.max(lastLocalEventAt, startedAt) >= quietMs) {
          resolve({ settledAfterMs: now - startedAt, settleTimedOut: false });
          return;
        }
        if (now - startedAt >= maxSettleMs) {
          resolve({ settledAfterMs: now - startedAt, settleTimedOut: true });
          return;
        }
        setTimeout(check, SETTLE_POLL_MS);
      };
      setTimeout(check, SETTLE_POLL_MS);
    });
  }

  async function run(request: ActionRequest): Promise<ActionOutcome> {
    // Element-less variants first.
    if (request.action === 'navigate') {
      return runNavigate(request);
    }

    let element: Element | null = null;
    if (request.action !== 'scroll' || request.target) {
      const resolved = resolveTarget(request.target);
      if (typeof resolved === 'string') {
        return failure(resolved);
      }
      element = resolved;
      const notInteractable = checkInteractable(element);
      if (notInteractable && request.action !== 'scroll') {
        return failure(notInteractable);
      }
    }

    const described = element ? describeTarget(element) : null;
    if (element) {
      highlight(element);
    }

    // Bug guard, not a user-facing path: click/input/select always resolve
    // an element above. A throw here surfaces via handle()'s catch.
    const requireElement = (): Element => {
      if (!element) {
        throw new Error('executor bug: element-bound action reached run() without an element');
      }
      return element;
    };

    const startedAt = Date.now();
    counting = true;
    effects = zeroEffects();
    let error: string | null = null;
    // No try/catch around the dispatches: exceptions thrown by the app's
    // own handlers never propagate out of dispatchEvent (they surface via
    // window.onerror and are captured as error events). Anything that DOES
    // throw here is an executor bug and is reported by handle()'s guard.
    switch (request.action) {
      case 'click':
        dispatchClick(requireElement());
        break;
      case 'input':
        error =
          request.value === undefined
            ? 'input needs a value'
            : performInput(requireElement(), request.value);
        break;
      case 'select':
        error =
          request.value === undefined
            ? 'select needs a value'
            : performSelect(requireElement(), request.value);
        break;
      case 'scroll':
        error = performScroll(request, element);
        break;
    }

    if (error !== null) {
      counting = false;
      return failure(error);
    }

    const { settledAfterMs, settleTimedOut } = await settle(startedAt);
    counting = false;
    return {
      ok: true,
      error: null,
      target: described,
      effects,
      settledAfterMs,
      settleTimedOut,
    };
  }

  function runNavigate(request: ActionRequest): ActionOutcome {
    if (request.url === undefined) {
      return failure('navigate needs a url');
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url, window.location.href);
    } catch {
      return failure(`invalid url "${request.url}"`);
    }
    // The action channel operates on the app under development, never the
    // wider web — cross-origin navigation stays forbidden by design.
    if (parsed.origin !== window.location.origin) {
      return failure(
        `cross-origin navigation to ${parsed.origin} is not allowed; the action channel only operates on ${window.location.origin}`,
      );
    }
    const hashOnly =
      parsed.pathname === window.location.pathname && parsed.search === window.location.search;
    if (hashOnly && parsed.hash !== '') {
      // Hash routers navigate without unloading the page or the socket.
      window.location.hash = parsed.hash;
    } else {
      // A full load tears down this page and the WebSocket with it: send
      // the result first, then navigate on the next tick.
      setTimeout(() => {
        window.location.assign(parsed.href);
      }, 50);
    }
    return {
      ok: true,
      error: null,
      target: null,
      effects: zeroEffects(),
      settledAfterMs: 0,
      settleTimedOut: false,
    };
  }

  return {
    async handle(request: ActionRequest): Promise<ActionOutcome> {
      if (!options.enabled) {
        return failure(
          'actions are disabled for this app — opt in with allowActions: true in the AgentLens plugin/init options',
        );
      }
      // Version-skew guard: a newer daemon may know action kinds this
      // runtime does not. Without this check the switch in run() would
      // match nothing and report a dishonest ok: true.
      if (!KNOWN_ACTIONS.has(request.action)) {
        return failure(
          `unsupported action "${request.action}" — update @agentlensjs/runtime (or the Vite plugin) to a version that supports it`,
        );
      }
      if (Date.now() - lastTrustedInputAt < userActivityWindowMs) {
        return failure(
          'the user is actively interacting with the page right now; human input wins — retry in a moment',
        );
      }
      if (busy) {
        return failure('another action is still in progress; actions run one at a time');
      }
      busy = true;
      try {
        return await run(request);
      } catch (unexpected) {
        return failure(
          `action failed unexpectedly: ${unexpected instanceof Error ? unexpected.message : String(unexpected)}`,
        );
      } finally {
        busy = false;
        counting = false;
      }
    },
    noteLocalEvent,
    noteUserActivity,
    dispose: () => {
      for (const name of activityEvents) {
        document.removeEventListener(name, onTrustedInput, { capture: true });
      }
    },
  };
}
