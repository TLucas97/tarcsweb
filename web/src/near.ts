// One IntersectionObserver per scroller and margin; elements report once they come within `margin` of view.
const observers = new Map<string, WeakMap<Element | Document, IntersectionObserver>>();
const onNear = new WeakMap<Element, () => void>();

// Built here, with no element in scope, so the callback never keeps a detached block alive.
function observerFor(root: Element | Document, margin: string) {
  let byRoot = observers.get(margin);
  if (!byRoot) observers.set(margin, (byRoot = new WeakMap()));
  let io = byRoot.get(root);
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) onNear.get(e.target)?.();
    }, { root: root === document ? null : (root as Element), rootMargin: margin });
    byRoot.set(root, io);
  }
  return io;
}

export function watchNear(el: Element, fn: () => void, margin = '1200px 0px') {
  const io = observerFor(el.closest('.conv') ?? document, margin);
  onNear.set(el, fn);
  io.observe(el);
  return () => {
    io.unobserve(el);
    onNear.delete(el);
  };
}
