import { LinearIndex, type SpatialIndex } from './spatial.ts';
import type { El } from './types.ts';

const before = (a: El, b: El) => a.z < b.z || (a.z === b.z && a.id < b.id);

// Committed elements in paint order. All edits go through replace(), which history entries replay in both directions.
export class Scene {
  readonly byId = new Map<string, El>();
  // Sorted by z, then id.
  readonly order: El[] = [];
  readonly index: SpatialIndex = new LinearIndex();
  // Bumped by every replace, so a pending AI job can tell the drawing changed since it was sent.
  rev = 0;
  // Called after every replace; the saved copy uses it to schedule a write.
  onChange: (() => void) | null = null;
  private topZ = 0;

  nextZ() {
    return ++this.topZ;
  }

  // Returns true when every added element landed on top, so the caller can paint just those instead of everything.
  replace(remove: readonly El[], add: readonly El[]): boolean {
    this.rev++;
    for (const el of remove) {
      const cur = this.byId.get(el.id);
      if (!cur) continue;
      this.byId.delete(el.id);
      this.index.remove(cur);
      this.order.splice(this.find(cur), 1);
    }
    let onTop = true;
    for (const el of add) {
      this.byId.set(el.id, el);
      this.index.insert(el);
      const at = this.find(el);
      if (at < this.order.length) onTop = false;
      this.order.splice(at, 0, el);
      if (el.z > this.topZ) this.topZ = el.z;
    }
    this.onChange?.();
    return onTop && remove.length === 0;
  }

  // Insertion point (or position) of `el` in `order`.
  private find(el: El) {
    let lo = 0, hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(this.order[mid], el)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
