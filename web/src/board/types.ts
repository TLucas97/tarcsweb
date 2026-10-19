// Board element model. Elements are immutable after commit: an edit replaces the object, so caches key on identity.
// Shapes are never split: lasso moves them whole and the eraser turns them into strokes first.
// Everything is in world coordinates; the camera maps world to screen.

export type Pt = { x: number; y: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };

type Base = {
  readonly id: string;
  // Paint order, lowest first; ties break by id. A split piece can reuse its parent's z to keep its place.
  readonly z: number;
  readonly bbox: Box;
  // An annotation (a remark about the design), kept apart from color so recoloring keeps it.
  readonly role?: 'note';
};

// Line pattern and fill tint; absent means solid and unfilled, so elements made before them look the same.
export type Dash = 'dashed' | 'dotted';
export type Fill = 'light' | 'medium';

// Centerline points as flat x,y pairs with streamlining already baked in; size is the constant width in world units.
export type Stroke = Base & {
  readonly kind: 'stroke';
  readonly pts: readonly number[];
  readonly color: string;
  readonly size: number;
  readonly dash?: Dash;
};

// Text bound inside a rect or ellipse: wrapped to its width, centered, drawn in the shape's color.
export type Label = { readonly text: string; readonly fontSize: number };

// x, y, w, h is the unrotated box; rot (radians, clockwise) turns it about its center. r is the corner radius.
export type Rect = Base & {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rot: number;
  readonly r: number;
  readonly color: string;
  readonly size: number;
  readonly dash?: Dash;
  readonly fill?: Fill;
  readonly label?: Label;
};

export type Ellipse = Base & {
  readonly kind: 'ellipse';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rot: number;
  readonly color: string;
  readonly size: number;
  readonly dash?: Dash;
  readonly fill?: Fill;
  readonly label?: Label;
};

export type Line = Base & {
  readonly kind: 'line' | 'arrow';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly color: string;
  readonly size: number;
  readonly dash?: Dash;
  // Arrows only: a drawn path as flat x,y pairs, first and last equal to (x1, y1) and (x2, y2), drawn as a smooth curve.
  readonly pts?: readonly number[];
};

// w and h are measured from the text at commit; fontSize is in world units.
export type Text = Base & {
  readonly kind: 'text';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text: string;
  readonly fontSize: number;
  readonly color: string;
  // Set on a label detached from its shape: lines centered in w, the box turned rot radians about its center.
  readonly align?: 'center';
  readonly rot?: number;
};

// A lucide icon by name, drawn into its box.
export type Icon = Base & {
  readonly kind: 'icon';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly name: string;
  readonly color: string;
};

// Straight segments through flat x,y pairs; closed joins the last point back to the first (triangles, polygons).
export type Poly = Base & {
  readonly kind: 'poly';
  readonly pts: readonly number[];
  readonly closed: boolean;
  readonly color: string;
  readonly size: number;
  readonly dash?: Dash;
  // Drawn only when closed.
  readonly fill?: Fill;
};

// A pasted or dropped picture drawn into its box. src keys the decoded bitmap in images.ts, so copies share it.
export type Img = Base & {
  readonly kind: 'image';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly src: string;
};

export type Shape = Rect | Ellipse | Line | Poly | Text | Icon | Img;
export type El = Stroke | Shape;
export type Kind = El['kind'];

// Theme-resolved colors: 'ink' follows the board's text color in both themes; 'gray', 'accent' and 'note'
// (annotations) are the board's other named colors. Any other value is a CSS hex color.
export const INK = 'ink';
