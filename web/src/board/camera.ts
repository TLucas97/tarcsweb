import type { Box, Pt } from './types.ts';

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

// The world point at the screen's top-left corner, and CSS pixels per world unit.
export class Camera {
  x = 0;
  y = 0;
  z = 1;

  toWorld(sx: number, sy: number): Pt {
    return { x: this.x + sx / this.z, y: this.y + sy / this.z };
  }

  view(w: number, h: number): Box {
    return { x0: this.x, y0: this.y, x1: this.x + w / this.z, y1: this.y + h / this.z };
  }

  // Keeps the world point under (sx, sy) fixed while zooming.
  zoomAt(sx: number, sy: number, next: number) {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (z === this.z) return false;
    this.x += sx / this.z - sx / z;
    this.y += sy / this.z - sy / z;
    this.z = z;
    return true;
  }

  panBy(dsx: number, dsy: number) {
    this.x -= dsx / this.z;
    this.y -= dsy / this.z;
  }

  // World to device pixels.
  apply(ctx: CanvasRenderingContext2D, dpr: number) {
    const k = this.z * dpr;
    ctx.setTransform(k, 0, 0, k, -this.x * k, -this.y * k);
  }
}
