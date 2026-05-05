// Operational state sync (frontend half).
//
// Single function: sync(data). Ships whatever object the caller has.
// The cloud determines what it means. No event names, no labels,
// no analytics vocabulary. A dev sees "we sync app state."

import { API_BASE } from './config';

let _lastTs = Date.now();
let _appStart = Date.now();

const _queue: Record<string, unknown>[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function _flush(): void {
  if (_queue.length === 0) return;
  const batch = _queue.splice(0);
  for (const d of batch) {
    const body = JSON.stringify(d);
    fetch(`${API_BASE}/service/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {});
  }
}

export function sync(data: Record<string, unknown> = {}, opts: { immediate?: boolean } = {}): void {
  _lastTs = Date.now();
  if (opts.immediate) {
    _queue.push(data);
    _flush();
    return;
  }
  _queue.push(data);
  if (_flushTimer == null) {
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      _flush();
    }, 1000);
  }
}

/** Backwards-compat shim — maps legacy trackEvent calls to sync(). */
export function trackEvent(
  eventType: string,
  properties?: Record<string, unknown>,
  useBeacon = false,
): void {
  const dot = eventType.indexOf('.');
  const surface = dot > 0 ? eventType.slice(0, dot) : eventType;
  const action = dot > 0 ? eventType.slice(dot + 1) : 'fired';
  sync(
    { s: surface, a: action, p: properties || {} },
    { immediate: useBeacon },
  );
}

export function getSessionTraceState(): {
  appStartTs: number;
  lastTs: number;
} {
  return { appStartTs: _appStart, lastTs: _lastTs };
}

export function _resetForTest(): void {
  _queue.length = 0;
  if (_flushTimer != null) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _appStart = Date.now();
  _lastTs = _appStart;
}

export function getLastAction(): string { return ''; }
export function getLastPage(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hash || window.location.pathname;
}
export function getTimeSpent(): number {
  return Math.round((Date.now() - _appStart) / 1000);
}

const serviceClient = { sync, trackEvent, getSessionTraceState };
export default serviceClient;
