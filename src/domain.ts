import { createHash, randomUUID } from 'node:crypto';

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomId(): string {
  return randomUUID();
}

export function randomToken(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}

let quietOverrideUntil: number | null = null;

/**
 * Development escape hatch, mirroring CW_QUIET_HOURS_DISABLED_UNTIL in the Rust server. It has an
 * expiry so it cannot replace the night pause permanently.
 */
export function setQuietOverride(until: number | null): void {
  quietOverrideUntil = until;
}

/** Fixed UTC+8, pause from 23:00 (inclusive) to 07:00 (exclusive). Host timezone independent. */
export function quietStatus(now: number): {
  enabled: boolean;
  active: boolean;
  timezone: string;
  starts_at: string;
  ends_at: string;
  changes_at: number;
} {
  const local = now + 8 * 3600;
  const day = Math.floor(local / 86400) * 86400;
  const second = ((local % 86400) + 86400) % 86400;
  let boundary: number;
  if (second < 7 * 3600) boundary = day + 7 * 3600;
  else if (second < 23 * 3600) boundary = day + 23 * 3600;
  else boundary = day + 86400 + 7 * 3600;
  return {
    enabled: true,
    active:
      !(second >= 7 * 3600 && second < 23 * 3600) &&
      !(quietOverrideUntil !== null && now < quietOverrideUntil),
    timezone: 'Asia/Shanghai (UTC+8)',
    starts_at: '23:00',
    ends_at: '07:00',
    changes_at: boundary - 8 * 3600,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
