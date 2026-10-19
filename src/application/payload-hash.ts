import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, undefined
 * fields dropped. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): Json {
  if (value === null || typeof value !== 'object') {
    return value as Json;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  const out: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) {
    const field = (value as Record<string, unknown>)[key];
    if (field !== undefined) {
      out[key] = normalize(field);
    }
  }
  return out;
}

/** SHA-256 (hex) of the canonical JSON. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
