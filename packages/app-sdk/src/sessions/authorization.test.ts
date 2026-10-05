import { expect, it } from 'vitest';
import { safeReturnTo } from './authorization.js';
const client = { redirectUri: 'https://app.example/callback' };
it.each([
  '/.//evil.com',
  '/a/..//evil.com',
  '/%2e//evil.com',
  '//evil.com',
  '/\\evil.com',
])('rejects a return path that could navigate outside the app: %s', (value) => {
  expect(() => safeReturnTo(value, client.redirectUri)).toThrow();
});
it('returns an idempotent same-origin path after normalization', () => {
  const value = safeReturnTo('/tasks/../today?q=1#task', client.redirectUri);
  expect(value).toBe('/today?q=1#task');
  expect(safeReturnTo(value, client.redirectUri)).toBe(value);
  expect(new URL(value, client.redirectUri).origin).toBe('https://app.example');
});
