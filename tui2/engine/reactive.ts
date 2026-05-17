export type Effect = () => void;

let currentEffect: Effect | null = null;
const subscribers = new Map<object, Set<Effect>>();

export function signal<T>(initial: T): [() => T, (v: T) => void] {
  let value = initial;
  const key = {};

  function get(): T {
    if (currentEffect && !subscribers.has(key)) {
      subscribers.set(key, new Set());
    }
    if (currentEffect) {
      subscribers.get(key)!.add(currentEffect);
    }
    return value;
  }

  function set(v: T): void {
    if (v === value) return;
    value = v;
    const subs = subscribers.get(key);
    if (subs) {
      for (const fn of subs) fn();
    }
  }

  return [get, set];
}

export function effect(fn: Effect): void {
  currentEffect = fn;
  fn();
  currentEffect = null;
}

let rafScheduled = false;
const dirtyRects: Array<{ x: number; y: number; w: number; h: number }> = [];
let renderFn: (() => void) | null = null;

export function initReactive(render: () => void): void {
  renderFn = render;
}

export function markDirty(x: number, y: number, w: number, h: number): void {
  dirtyRects.push({ x, y, w, h });
  if (!rafScheduled) {
    rafScheduled = true;
    setImmediate(() => {
      rafScheduled = false;
      dirtyRects.length = 0;
      renderFn?.();
    });
  }
}
