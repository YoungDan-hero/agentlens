import { describe, expect, it } from 'vitest';

import { isAllowedOrigin, parseAllowedOrigins } from './origin';

describe('isAllowedOrigin', () => {
  it('allows absent origins (non-browser clients)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('allows loopback origins on any port and scheme', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('https://localhost')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:8080')).toBe(true);
  });

  it('allows *.localhost subdomains', () => {
    expect(isAllowedOrigin('http://app.localhost:5173')).toBe(true);
  });

  it('allows RFC 1918 private addresses (dev server via LAN IP)', () => {
    expect(isAllowedOrigin('http://192.168.52.66:1688')).toBe(true);
    expect(isAllowedOrigin('http://10.0.0.5:5173')).toBe(true);
    expect(isAllowedOrigin('http://172.16.1.1:5173')).toBe(true);
    expect(isAllowedOrigin('http://172.31.255.1:5173')).toBe(true);
  });

  it('rejects public origins', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('http://172.32.0.1')).toBe(false);
    expect(isAllowedOrigin('http://11.0.0.1')).toBe(false);
    // Domains merely containing local-looking substrings must not pass.
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedOrigin('http://192.168.1.1.evil.com')).toBe(false);
  });

  it('rejects the literal "null" origin and garbage', () => {
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('not a url')).toBe(false);
  });

  it('honours the extra allow-list with exact matching', () => {
    expect(isAllowedOrigin('https://dev.example.com', ['https://dev.example.com'])).toBe(true);
    expect(isAllowedOrigin('https://dev.example.com:444', ['https://dev.example.com'])).toBe(false);
  });
});

describe('parseAllowedOrigins', () => {
  it('splits, trims and strips trailing slashes', () => {
    expect(parseAllowedOrigins(' https://a.dev/ , http://b.dev ')).toEqual([
      'https://a.dev',
      'http://b.dev',
    ]);
  });

  it('returns empty for unset or blank input', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('  ,')).toEqual([]);
  });
});
