import { useCallback, useRef, useSyncExternalStore } from "react";

const STATE_MESSAGE = "rakazo-page:state";
const SAVED_KEY = /^(?!__proto__$)[A-Za-z0-9_.:-]{1,64}$/;
const SEND_DELAY_MS = 400;
const SEND_MAX_KEYS = 100;

const values = new Map<string, unknown>();
const listeners = new Set<() => void>();
let saving = false;
const unsent = new Map<string, unknown>();
const inTransit = new Map<string, string>();
const persisted = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function notify() {
  for (const listener of listeners) listener();
}

function send() {
  const entries = [...unsent];
  unsent.clear();
  for (let start = 0; start < entries.length; start += SEND_MAX_KEYS) {
    const batch = entries.slice(start, start + SEND_MAX_KEYS);
    for (const [key, value] of batch) inTransit.set(key, JSON.stringify(value));
    window.parent?.postMessage({ type: STATE_MESSAGE, values: Object.fromEntries(batch) }, "*");
  }
}

function cooled() {
  timer = undefined;
  if (unsent.size === 0) return;
  send();
  timer = setTimeout(cooled, SEND_DELAY_MS);
}

function receiveState(event: MessageEvent) {
  const { type, values: saved } = event.data ?? {};
  if (event.source !== window.parent || !saved || typeof saved !== "object" || Array.isArray(saved))
    return;
  if (type === "rakazo-page:state-received") {
    for (const [key, value] of Object.entries(saved)) {
      if (inTransit.get(key) === asJsonText(value)) inTransit.delete(key);
    }
    return;
  }
  if (type !== "rakazo-page:state-refresh") return;

  const editing = (key: string) => unsent.has(key) || inTransit.has(key);
  let changed = false;
  for (const key of persisted) {
    if (Object.hasOwn(saved, key) || editing(key)) continue;
    persisted.delete(key);
    changed = values.delete(key) || changed;
  }
  for (const [key, value] of Object.entries(saved)) {
    if (!SAVED_KEY.test(key) || editing(key)) continue;
    persisted.add(key);
    if (Object.is(value, values.get(key)) || asJsonText(value) === asJsonText(values.get(key)))
      continue;
    values.set(key, value);
    changed = true;
  }
  if (changed) notify();
}

/** The values the host saved for this reader; without them the page saves nothing. */
export function startPageState(saved: unknown) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  saving = true;
  for (const [key, value] of Object.entries(saved)) {
    values.set(key, value);
    persisted.add(key);
  }
  addEventListener("message", receiveState);
  addEventListener("pagehide", send);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") send();
  });
}

function asJsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function setValue(key: string, value: unknown) {
  values.set(key, value);
  notify();
  if (!saving || !SAVED_KEY.test(key)) return;
  const saved = asJsonText(value);
  if (saved === undefined) return;
  unsent.set(key, JSON.parse(saved));
  if (timer !== undefined) return;
  send();
  timer = setTimeout(cooled, SEND_DELAY_MS);
}

function sameShape(saved: unknown, initial: unknown): boolean {
  if (initial === null || initial === undefined) return true;
  if (saved === null || saved === undefined) return false;
  return Array.isArray(saved) === Array.isArray(initial) && typeof saved === typeof initial;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePageState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((current: T) => T)) => void] {
  const name = String(key);
  const fallback = useRef(initial);
  fallback.current = initial;
  const read = () => values.get(name);
  const stored = useSyncExternalStore(subscribe, read, read);
  const value = values.has(name) && sameShape(stored, initial) ? (stored as T) : initial;
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      const saved = values.get(name);
      const current =
        values.has(name) && sameShape(saved, fallback.current) ? (saved as T) : fallback.current;
      setValue(name, typeof next === "function" ? (next as (current: T) => T)(current) : next);
    },
    [name],
  );
  return [value, set];
}
