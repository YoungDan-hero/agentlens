import { describe, expect, it } from 'vitest';

import {
  MAX_BODY_LENGTH,
  MAX_BODY_PARSE_BYTES,
  REDACTED,
  isSensitiveKey,
  redactBodyText,
  redactUrl,
  sanitizeBody,
} from './redact';

describe('isSensitiveKey', () => {
  it('matches credential-like keys regardless of casing and separators', () => {
    for (const key of [
      'password',
      'PASSWORD',
      'user_passwd',
      'pwd',
      'accessToken',
      'refresh_token',
      'apiKey',
      'api-key',
      'x-api_key',
      'clientSecret',
      'Authorization',
      'authToken',
      'sessionId',
      'cookie',
      'credentials',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('leaves ordinary keys alone, including "author"', () => {
    for (const key of ['author', 'authorName', 'name', 'email', 'query', 'page']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('redactUrl', () => {
  it('redacts sensitive query parameter values', () => {
    expect(redactUrl('https://api.test/login?user=a&token=s3cret')).toBe(
      `https://api.test/login?user=a&token=${encodeURIComponent(REDACTED)}`,
    );
  });

  it('preserves relative urls and hash fragments', () => {
    const result = redactUrl('/api/data?apiKey=abc#section');
    expect(result).toContain('/api/data?');
    expect(result).toContain('#section');
    expect(result).not.toContain('abc');
  });

  it('returns urls without sensitive params byte-for-byte', () => {
    const url = 'https://api.test/items?page=2&sort=asc';
    expect(redactUrl(url)).toBe(url);
    expect(redactUrl('/plain/path')).toBe('/plain/path');
  });
});

describe('redactBodyText', () => {
  it('redacts nested json fields and array members', () => {
    const body = JSON.stringify({
      user: { name: 'dan', password: 'hunter2' },
      items: [{ accessToken: 'abc' }],
    });
    const result = JSON.parse(redactBodyText(body)) as {
      user: { name: string; password: string };
      items: { accessToken: string }[];
    };
    expect(result.user.name).toBe('dan');
    expect(result.user.password).toBe(REDACTED);
    expect(result.items[0]?.accessToken).toBe(REDACTED);
  });

  it('redacts a sensitive collection key as a whole', () => {
    const result = redactBodyText(JSON.stringify({ tokens: ['a', 'b'] }));
    expect(result).toBe(`{"tokens":"${REDACTED}"}`);
  });

  it('redacts form-urlencoded bodies', () => {
    const result = redactBodyText('user=dan&password=hunter2');
    expect(result).toContain('user=dan');
    expect(result).not.toContain('hunter2');
  });

  it('passes through non-structured text and invalid json', () => {
    expect(redactBodyText('plain text payload')).toBe('plain text payload');
    expect(redactBodyText('{not json')).toBe('{not json');
  });
});

describe('sanitizeBody', () => {
  it('replaces oversized bodies with a placeholder', () => {
    const huge = 'x'.repeat(MAX_BODY_PARSE_BYTES + 1);
    expect(sanitizeBody(huge)).toBe(`[body omitted: ${String(huge.length)} chars]`);
  });

  it('truncates long redacted bodies', () => {
    const long = JSON.stringify({ data: 'y'.repeat(MAX_BODY_LENGTH * 2) });
    const result = sanitizeBody(long);
    expect(result.length).toBeLessThanOrEqual(MAX_BODY_LENGTH + 1);
    expect(result.endsWith('…')).toBe(true);
  });

  it('redacts before shipping', () => {
    expect(sanitizeBody('{"password":"hunter2"}')).toBe(`{"password":"${REDACTED}"}`);
  });
});
