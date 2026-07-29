import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProtocolMessage } from '@agentlensjs/shared';
import type { EventContext } from './events';
import { buildConsoleEvent } from './events';
import { Transport } from './transport';

const context: EventContext = {
  sessionId: 'session-1',
  url: 'http://localhost:5173/',
};

/** Minimal WebSocket double: starts CONNECTING, opened manually per test. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners.get('open') ?? []) {
      listener();
    }
  }

  simulateMessage(data: string): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  lastMessages(): ProtocolMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ProtocolMessage);
  }
}

function makeEvent(label: string): ReturnType<typeof buildConsoleEvent> {
  return buildConsoleEvent(context, 'log', [label]);
}

describe('Transport micro-batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('batches events inside one window into a single message', () => {
    const transport = new Transport({ endpoint: 'ws://localhost:8631/agentlens' });
    const socket = FakeWebSocket.instances[0];
    socket?.simulateOpen();

    transport.send(makeEvent('a'));
    transport.send(makeEvent('b'));
    transport.send(makeEvent('c'));
    expect(socket?.sent).toHaveLength(0);

    vi.advanceTimersByTime(100);

    expect(socket?.sent).toHaveLength(1);
    expect(socket?.lastMessages()[0]?.events).toHaveLength(3);
    transport.close();
  });

  it('flushes immediately when the batch is full', () => {
    const transport = new Transport({
      endpoint: 'ws://localhost:8631/agentlens',
      maxBatchSize: 2,
    });
    const socket = FakeWebSocket.instances[0];
    socket?.simulateOpen();

    transport.send(makeEvent('a'));
    transport.send(makeEvent('b'));

    expect(socket?.sent).toHaveLength(1);
    expect(socket?.lastMessages()[0]?.events).toHaveLength(2);
    transport.close();
  });

  it('queues while connecting and flushes everything on open', () => {
    const transport = new Transport({ endpoint: 'ws://localhost:8631/agentlens' });
    const socket = FakeWebSocket.instances[0];

    transport.send(makeEvent('a'));
    transport.send(makeEvent('b'));
    vi.advanceTimersByTime(200);
    expect(socket?.sent).toHaveLength(0);

    socket?.simulateOpen();

    expect(socket?.sent).toHaveLength(1);
    expect(socket?.lastMessages()[0]?.events).toHaveLength(2);
    transport.close();
  });

  it('drops the oldest events beyond the queue bound', () => {
    const transport = new Transport({
      endpoint: 'ws://localhost:8631/agentlens',
      maxQueueSize: 2,
      maxBatchSize: 100,
    });
    const socket = FakeWebSocket.instances[0];

    transport.send(makeEvent('a'));
    transport.send(makeEvent('b'));
    transport.send(makeEvent('c'));
    socket?.simulateOpen();

    const events = socket?.lastMessages()[0]?.events;
    expect(events).toHaveLength(2);
    expect(events?.map((e) => (e.type === 'console' ? e.args[0] : ''))).toEqual(['b', 'c']);
    transport.close();
  });

  it('delivers parsed daemon messages to onMessage and ignores junk', () => {
    const received: unknown[] = [];
    const transport = new Transport({
      endpoint: 'ws://localhost:8631/agentlens',
      onMessage: (message) => received.push(message),
    });
    const socket = FakeWebSocket.instances[0];
    socket?.simulateOpen();

    socket?.simulateMessage(JSON.stringify({ kind: 'snapshot-request', requestId: 'r1' }));
    socket?.simulateMessage('not json at all');

    expect(received).toEqual([{ kind: 'snapshot-request', requestId: 'r1' }]);
    transport.close();
  });

  it('sendRaw bypasses the batch queue and drops when not open', () => {
    const transport = new Transport({ endpoint: 'ws://localhost:8631/agentlens' });
    const socket = FakeWebSocket.instances[0];

    transport.sendRaw({ kind: 'snapshot-response' });
    expect(socket?.sent).toHaveLength(0);

    socket?.simulateOpen();
    transport.sendRaw({ kind: 'snapshot-response', requestId: 'r1' });

    expect(socket?.sent).toHaveLength(1);
    expect(JSON.parse(socket?.sent[0] ?? '')).toEqual({
      kind: 'snapshot-response',
      requestId: 'r1',
    });
    transport.close();
  });

  it('sends nothing after close', () => {
    const transport = new Transport({ endpoint: 'ws://localhost:8631/agentlens' });
    const socket = FakeWebSocket.instances[0];
    socket?.simulateOpen();

    transport.close();
    transport.send(makeEvent('a'));
    vi.advanceTimersByTime(200);

    expect(socket?.sent).toHaveLength(0);
  });
});
