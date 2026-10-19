// The board elements JSON as a model reads it. web/src/board/elements.ts holds the validator for this exact shape.
export const BOARD_SCHEMA = `Board elements JSON. Integer px coordinates relative to the region's top-left corner; y grows downward.

{ "w": 400, "h": 300, "elements": [
  { "kind": "rect", "x": 10, "y": 10, "w": 120, "h": 40, "r": 8, "fill": "light", "label": "Log in" },
  { "kind": "ellipse", "x": 200, "y": 20, "w": 60, "h": 60 },
  { "kind": "line", "from": [10, 80], "to": [390, 80], "color": "gray", "strokeWidth": 2 },
  { "kind": "arrow", "from": [60, 100], "to": [60, 160] },
  { "kind": "arrow", "from": [100, 100], "via": [[140, 90], [170, 130]], "to": [190, 160] },
  { "kind": "poly", "pts": [[300, 110], [350, 190], [250, 190]], "closed": true },
  { "kind": "text", "x": 22, "y": 18, "text": "Log in", "size": 16 },
  { "kind": "icon", "x": 350, "y": 14, "w": 24, "h": 24, "name": "menu" },
  { "kind": "stroke", "x": 0, "y": 200, "w": 90, "h": 40, "pts": [[0, 230], [45, 200], [90, 240]] },
  { "kind": "rect", "x": 150, "y": 230, "w": 100, "h": 50, "role": "note", "dash": "dashed" },
  { "kind": "text", "x": 260, "y": 245, "text": "sticky on scroll", "role": "note" }
] }

w, h: the region size. rect r: corner radius. arrow: head at "to"; optional "via" bends it through those points in
order. rect and ellipse "label": text centered inside the shape and wrapped to its width (optional "labelSize", default
16); size the shape so the label fits, and prefer a label over a separate text on top of a box. poly: straight segments through pts; "closed": true
joins the last point to the first (triangles, diamonds, other polygons), absent leaves it open (zigzags).
text: x, y is the top-left of the first line, size is the font size (default 16), "\\n" breaks lines; optional
"align": "center" centers each line in the text's box, and "rot" rotates it (degrees clockwise about its center). icon name: a Lucide
icon (menu, search, user, bell, home, settings, chevron-left, heart, cart, apple, ...). stroke: freehand ink as its
box plus a simplified polyline in the same coordinates.
Optional on any element: "id"; "color": "ink" (default), "gray" (secondary or placeholder parts), "accent" (one
highlight color), "note" or "#rrggbb"; "role": "note" marks an annotation (a remark about the design, not part of it):
it takes the annotation color unless "color" is set, and note text defaults to size 13.
Optional on stroke, rect, ellipse, line, arrow, poly: "strokeWidth" (px, 1-64, default 3), "dash": "solid" (default),
"dashed" or "dotted".
Optional on rect, ellipse and closed poly: "fill": "none" (default), "light" or "medium", a neutral tint of the
element's color, for wireframe blocks such as headers, sidebars, image placeholders and cards.
Optional on rect and ellipse: "rot", degrees clockwise about the center.
Input only: { "kind": "image", "x", "y", "w", "h" } is a pasted picture; it is never part of an answer.`;
