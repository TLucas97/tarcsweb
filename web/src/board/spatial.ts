import { intersects } from './geom.ts';
import type { Box, El } from './types.ts';

// Bbox lookups for the eraser, lasso and hit tests. A linear scan until a 4x-throttle profile asks for rbush.
export interface SpatialIndex {
  insert(el: El): void;
  remove(el: El): void;
  query(box: Box): El[];
}

export class LinearIndex implements SpatialIndex {
  private els = new Set<El>();

  insert(el: El) {
    this.els.add(el);
  }

  remove(el: El) {
    this.els.delete(el);
  }

  query(box: Box) {
    const out: El[] = [];
    for (const el of this.els) if (intersects(el.bbox, box)) out.push(el);
    return out;
  }
}
