import { OAuthError } from './errors.js';

/** OAuth scope tokens, preserving absent versus explicitly empty lists at the caller boundary. */
export function scopeList(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (s: unknown) =>
        typeof s === 'string' && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s),
    ) ||
    new Set(value).size !== value.length
  )
    throw new OAuthError('configuration');
  return Object.freeze([...value] as string[]);
}
