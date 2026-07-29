import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateId } from './uuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateId', () => {
  it('produces a v4 UUID via crypto.randomUUID when available', () => {
    expect(generateId()).toMatch(UUID_V4);
  });

  it('falls back to getRandomValues in insecure contexts', () => {
    // Simulates a plain-http LAN context: getRandomValues exists,
    // randomUUID does not.
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i += 1) {
          array[i] = i * 16;
        }
        return array;
      },
    });

    const id = generateId();
    expect(id).toMatch(UUID_V4);
  });

  it('generates unique ids across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, generateId));
    expect(ids.size).toBe(100);
  });
});
