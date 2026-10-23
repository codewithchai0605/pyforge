/**
 * Pinch-to-resize the editor font.
 *
 * Browser page zoom is disabled (it scales the whole UI and breaks layout), so
 * the natural pinch gesture is given a useful meaning instead: change the code
 * font size, like most mobile editors.
 */

export function clampFontSize(size: number, min = 11, max = 26): number {
  return Math.min(max, Math.max(min, Math.round(size)));
}

/** New font size for a pinch that started at `startDistance` px apart and is now `currentDistance`. */
export function pinchFontSize(startSize: number, startDistance: number, currentDistance: number): number {
  if (startDistance <= 0) return startSize;
  return clampFontSize(startSize * (currentDistance / startDistance));
}

export interface PinchOptions {
  getSize(): number;
  setSize(size: number): void;
}

/** Attaches the gesture to `el`; returns a detach function. Single-finger scrolling/selecting is untouched. */
export function attachPinchZoom(el: HTMLElement, { getSize, setSize }: PinchOptions): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let startDistance = 0;
  let startSize = 0;

  const distance = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const down = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      startDistance = distance();
      startSize = getSize();
    }
  };
  const move = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const next = pinchFontSize(startSize, startDistance, distance());
      if (next !== getSize()) setSize(next);
    }
  };
  const up = (e: PointerEvent): void => void pointers.delete(e.pointerId);

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
}
