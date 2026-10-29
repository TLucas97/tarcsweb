// One IntersectionObserver per scroller, margin and direction; elements report once they come within `margin` of view
// (or, for watchFar, once they leave it).
const observers = new Map<string, WeakMap<Element | Document, IntersectionObserver>>();
const onNear = new WeakMap<Element, (el: Element) => void>();

// Built here, with no element in scope, so the callback never keeps a detached block alive.
function observerFor(root: Element | Document, margin: string, far: boolean) {
  const key = far ? `far ${margin}` : margin;
  let byRoot = observers.get(key);
  if (!byRoot) observers.set(key, (byRoot = new WeakMap()));
  let io = byRoot.get(root);
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting !== far) onNear.get(e.target)?.(e.target);
    }, { root: root === document ? null : (root as Element), rootMargin: margin });
    byRoot.set(root, io);
  }
  return io;
}

export function watchNear(el: Element, fn: (el: Element) => void, margin = '1200px 0px', far = false) {
  const io = observerFor(el.closest('.conv') ?? document, margin, far);
  onNear.set(el, fn);
  io.observe(el);
  return () => {
    io.unobserve(el);
    onNear.delete(el);
  };
}

// Wider than watchNear's default so a card scrolled just past the load margin does not flap.
export const watchFar = (el: Element, fn: (el: Element) => void, margin = '3600px 0px') => watchNear(el, fn, margin, true);
