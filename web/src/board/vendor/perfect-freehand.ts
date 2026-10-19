/*
 * perfect-freehand 1.2.3 (https://github.com/steveruizok/perfect-freehand), vendored from its TypeScript sources
 * into one file. Only the long doc comments and unused vector helpers were dropped; the code is unchanged.
 *
 * MIT License
 *
 * Copyright (c) 2021 Stephen Ruiz Ltd
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ---- types.ts

export type Vec2 = [number, number];

export interface StrokeOptions {
  size?: number;
  thinning?: number;
  smoothing?: number;
  streamline?: number;
  easing?: (pressure: number) => number;
  simulatePressure?: boolean;
  start?: {
    cap?: boolean;
    taper?: number | boolean;
    easing?: (distance: number) => number;
  };
  end?: {
    cap?: boolean;
    taper?: number | boolean;
    easing?: (distance: number) => number;
  };
  last?: boolean;
}

export interface StrokePoint {
  point: Vec2;
  pressure: number;
  distance: number;
  vector: Vec2;
  runningLength: number;
}

// ---- constants.ts

const { PI } = Math;
const RATE_OF_PRESSURE_CHANGE = 0.275;
// PI with a tiny offset to fix browser rendering artifacts.
const FIXED_PI = PI + 0.0001;
const START_CAP_SEGMENTS = 13;
const END_CAP_SEGMENTS = 29;
const CORNER_CAP_SEGMENTS = 13;
const END_NOISE_THRESHOLD = 3;
const MIN_STREAMLINE_T = 0.15;
const STREAMLINE_T_RANGE = 0.85;
const MIN_RADIUS = 0.01;
const DEFAULT_FIRST_PRESSURE = 0.25;
const DEFAULT_PRESSURE = 0.5;
const UNIT_OFFSET: [number, number] = [1, 1];

// ---- getStrokeRadius.ts

function getStrokeRadius(size: number, thinning: number, pressure: number, easing: (t: number) => number = (t) => t) {
  return size * easing(0.5 - thinning * (0.5 - pressure));
}

// ---- simulatePressure.ts

const { min } = Math;

function simulatePressure(prevPressure: number, distance: number, size: number): number {
  // Speed of change - how fast should the pressure be changing?
  const sp = min(1, distance / size);
  // Rate of change - how much of a change is there?
  const rp = min(1, 1 - sp);
  // Accelerate the pressure
  return min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
}

// ---- vec.ts

function neg(A: Vec2): Vec2 {
  return [-A[0], -A[1]];
}

function add(A: Vec2, B: Vec2): Vec2 {
  return [A[0] + B[0], A[1] + B[1]];
}

function addInto(out: Vec2, A: Vec2, B: Vec2): Vec2 {
  out[0] = A[0] + B[0];
  out[1] = A[1] + B[1];
  return out;
}

function sub(A: Vec2, B: Vec2): Vec2 {
  return [A[0] - B[0], A[1] - B[1]];
}

function subInto(out: Vec2, A: Vec2, B: Vec2): Vec2 {
  out[0] = A[0] - B[0];
  out[1] = A[1] - B[1];
  return out;
}

function mul(A: Vec2, n: number): Vec2 {
  return [A[0] * n, A[1] * n];
}

function mulInto(out: Vec2, A: Vec2, n: number): Vec2 {
  out[0] = A[0] * n;
  out[1] = A[1] * n;
  return out;
}

function div(A: Vec2, n: number): Vec2 {
  return [A[0] / n, A[1] / n];
}

function per(A: Vec2): Vec2 {
  return [A[1], -A[0]];
}

function perInto(out: Vec2, A: Vec2): Vec2 {
  const temp = A[0];
  out[0] = A[1];
  out[1] = -temp;
  return out;
}

function dpr(A: Vec2, B: Vec2): number {
  return A[0] * B[0] + A[1] * B[1];
}

function isEqual(A: Vec2, B: Vec2): boolean {
  return A[0] === B[0] && A[1] === B[1];
}

function len(A: Vec2): number {
  return Math.hypot(A[0], A[1]);
}

function dist2(A: Vec2, B: Vec2): number {
  const dx = A[0] - B[0];
  const dy = A[1] - B[1];
  return dx * dx + dy * dy;
}

function uni(A: Vec2): Vec2 {
  return div(A, len(A));
}

function dist(A: Vec2, B: Vec2): number {
  return Math.hypot(A[1] - B[1], A[0] - B[0]);
}

function rotAround(A: Vec2, C: Vec2, r: number): Vec2 {
  const s = Math.sin(r);
  const c = Math.cos(r);
  const px = A[0] - C[0];
  const py = A[1] - C[1];
  const nx = px * c - py * s;
  const ny = px * s + py * c;
  return [nx + C[0], ny + C[1]];
}

function rotAroundInto(out: Vec2, A: Vec2, C: Vec2, r: number): Vec2 {
  const s = Math.sin(r);
  const c = Math.cos(r);
  const px = A[0] - C[0];
  const py = A[1] - C[1];
  const nx = px * c - py * s;
  const ny = px * s + py * c;
  out[0] = nx + C[0];
  out[1] = ny + C[1];
  return out;
}

function lrp(A: Vec2, B: Vec2, t: number): Vec2 {
  return add(A, mul(sub(B, A), t));
}

function lrpInto(out: Vec2, A: Vec2, B: Vec2, t: number): Vec2 {
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  out[0] = A[0] + dx * t;
  out[1] = A[1] + dy * t;
  return out;
}

function prj(A: Vec2, B: Vec2, c: number): Vec2 {
  return add(A, mul(B, c));
}

// ---- getStrokePoints.ts

// Scratch buffer for allocation-free vector calculation in hot loop
const _vectorDiff: Vec2 = [0, 0];

function isValidPressure(pressure: number | undefined): pressure is number {
  return pressure != null && pressure >= 0;
}

export function getStrokePoints<T extends number[], K extends { x: number; y: number; pressure?: number }>(
  points: (T | K)[],
  options = {} as StrokeOptions,
): StrokePoint[] {
  const { streamline = 0.5, size = 16, last: isComplete = false } = options;

  // If we don't have any points, return an empty array.
  if (points.length === 0) return [];

  // Find the interpolation level between points.
  const t = MIN_STREAMLINE_T + (1 - streamline) * STREAMLINE_T_RANGE;

  // Whatever the input is, make sure that the points are in number[][].
  let pts = Array.isArray(points[0])
    ? (points as T[])
    : (points as K[]).map(({ x, y, pressure = DEFAULT_PRESSURE }) => [x, y, pressure]);

  // Add extra points between the two, to help avoid "dash" lines
  // for strokes with tapered start and ends. Don't mutate the
  // input array!
  if (pts.length === 2) {
    const last = pts[1];
    pts = pts.slice(0, -1);
    for (let i = 1; i < 5; i++) {
      pts.push(lrp(pts[0] as Vec2, last as Vec2, i / 4));
    }
  }

  // If there's only one point, add another point at a 1pt offset.
  // Don't mutate the input array!
  if (pts.length === 1) {
    pts = [...pts, [...add(pts[0] as Vec2, UNIT_OFFSET), ...pts[0].slice(2)]];
  }

  // The strokePoints array will hold the points for the stroke.
  // Start it out with the first point, which needs no adjustment.
  const strokePoints: StrokePoint[] = [
    {
      point: [pts[0][0], pts[0][1]],
      pressure: isValidPressure(pts[0][2]) ? pts[0][2] : DEFAULT_FIRST_PRESSURE,
      vector: [...UNIT_OFFSET],
      distance: 0,
      runningLength: 0,
    },
  ];

  // A flag to see whether we've already reached out minimum length
  let hasReachedMinimumLength = false;

  // We use the runningLength to keep track of the total distance
  let runningLength = 0;

  // We're set this to the latest point, so we can use it to calculate
  // the distance and vector of the next point.
  let prev = strokePoints[0];

  const max = pts.length - 1;

  // Iterate through all of the points, creating StrokePoints.
  for (let i = 1; i < pts.length; i++) {
    const point: Vec2 =
      isComplete && i === max
        ? // If we're at the last point, and `options.last` is true,
          // then add the actual input point.
          [pts[i][0], pts[i][1]]
        : // Otherwise, using the t calculated from the streamline
          // option, interpolate a new point between the previous
          // point the current point.
          lrp(prev.point, pts[i] as Vec2, t);

    // If the new point is the same as the previous point, skip ahead.
    if (isEqual(prev.point, point)) continue;

    // How far is the new point from the previous point?
    const distance = dist(point, prev.point);

    // Add this distance to the total "running length" of the line.
    runningLength += distance;

    // At the start of the line, we wait until the new point is a
    // certain distance away from the original point, to avoid noise
    if (i < max && !hasReachedMinimumLength) {
      if (runningLength < size) continue;
      hasReachedMinimumLength = true;
      // TODO: Backfill the missing points so that tapering works correctly.
    }
    // Create a new strokepoint (it will be the new "previous" one).
    // Use scratch buffer for vector difference to reduce allocations
    subInto(_vectorDiff, prev.point, point);
    prev = {
      // The adjusted point
      point,
      // The input pressure (or default if not specified)
      pressure: isValidPressure(pts[i][2]) ? pts[i][2] : DEFAULT_PRESSURE,
      // The vector from the current point to the previous point
      vector: uni(_vectorDiff),
      // The distance between the current point and the previous point
      distance,
      // The total distance so far
      runningLength,
    };

    // Push it to the strokePoints array.
    strokePoints.push(prev);
  }

  // Set the vector of the first point to be the same as the second point.
  strokePoints[0].vector = strokePoints[1]?.vector || [0, 0];

  return strokePoints;
}

// ---- getStrokeOutlinePoints.ts

// Scratch buffers for allocation-free hot loop calculations
const _offset: Vec2 = [0, 0];
const _tl: Vec2 = [0, 0];
const _tr: Vec2 = [0, 0];

function drawDot(center: Vec2, radius: number): Vec2[] {
  const offsetPoint = add(center, [1, 1]);
  const start = prj(center, uni(per(sub(center, offsetPoint))), -radius);
  const dotPts: Vec2[] = [];
  const step = 1 / START_CAP_SEGMENTS;
  for (let t = step; t <= 1; t += step) {
    dotPts.push(rotAround(start, center, FIXED_PI * 2 * t));
  }
  return dotPts;
}

function drawRoundStartCap(center: Vec2, rightPoint: Vec2, segments: number): Vec2[] {
  const cap: Vec2[] = [];
  const step = 1 / segments;
  for (let t = step; t <= 1; t += step) {
    cap.push(rotAround(rightPoint, center, FIXED_PI * t));
  }
  return cap;
}

function drawFlatStartCap(center: Vec2, leftPoint: Vec2, rightPoint: Vec2): Vec2[] {
  const cornersVector = sub(leftPoint, rightPoint);
  const offsetA = mul(cornersVector, 0.5);
  const offsetB = mul(cornersVector, 0.51);
  return [sub(center, offsetA), sub(center, offsetB), add(center, offsetB), add(center, offsetA)];
}

// 1.5 turns to handle sharp end turns correctly.
function drawRoundEndCap(center: Vec2, direction: Vec2, radius: number, segments: number): Vec2[] {
  const cap: Vec2[] = [];
  const start = prj(center, direction, radius);
  const step = 1 / segments;
  for (let t = step; t < 1; t += step) {
    cap.push(rotAround(start, center, FIXED_PI * 3 * t));
  }
  return cap;
}

function drawFlatEndCap(center: Vec2, direction: Vec2, radius: number): Vec2[] {
  return [
    add(center, mul(direction, radius)),
    add(center, mul(direction, radius * 0.99)),
    sub(center, mul(direction, radius * 0.99)),
    sub(center, mul(direction, radius)),
  ];
}

function computeTaperDistance(taper: boolean | number | undefined, size: number, totalLength: number): number {
  if (taper === false || taper === undefined) return 0;
  if (taper === true) return Math.max(size, totalLength);
  return taper;
}

// Averages the first few points: drawn lines almost always start slow.
function computeInitialPressure(points: StrokePoint[], shouldSimulatePressure: boolean, size: number): number {
  return points.slice(0, 10).reduce((acc, curr) => {
    let pressure = curr.pressure;
    if (shouldSimulatePressure) {
      pressure = simulatePressure(acc, curr.distance, size);
    }
    return (acc + pressure) / 2;
  }, points[0].pressure);
}

export function getStrokeOutlinePoints(
  points: StrokePoint[],
  options: Partial<StrokeOptions> = {} as Partial<StrokeOptions>,
): Vec2[] {
  const {
    size = 16,
    smoothing = 0.5,
    thinning = 0.5,
    simulatePressure: shouldSimulatePressure = true,
    easing = (t) => t,
    start = {},
    end = {},
    last: isComplete = false,
  } = options;

  const { cap: capStart = true, easing: taperStartEase = (t) => t * (2 - t) } = start;

  const { cap: capEnd = true, easing: taperEndEase = (t) => --t * t * t + 1 } = end;

  // We can't do anything with an empty array or a stroke with negative size.
  if (points.length === 0 || size <= 0) {
    return [];
  }

  // The total length of the line
  const totalLength = points[points.length - 1].runningLength;

  const taperStart = computeTaperDistance(start.taper, size, totalLength);
  const taperEnd = computeTaperDistance(end.taper, size, totalLength);

  // The minimum allowed distance between points (squared)
  const minDistance = Math.pow(size * smoothing, 2);

  // Our collected left and right points
  const leftPts: Vec2[] = [];
  const rightPts: Vec2[] = [];

  // Previous pressure (averaged from first few points to prevent fat starts)
  let prevPressure = computeInitialPressure(points, shouldSimulatePressure, size);

  // The current radius
  let radius = getStrokeRadius(size, thinning, points[points.length - 1].pressure, easing);

  // The radius of the first saved point
  let firstRadius: number | undefined = undefined;

  // Previous vector
  let prevVector = points[0].vector;

  // Previous left and right points
  let prevLeftPoint = points[0].point;
  let prevRightPoint = prevLeftPoint;

  // Temporary left and right points
  let tempLeftPoint: Vec2 = prevLeftPoint;
  let tempRightPoint: Vec2 = prevRightPoint;

  // Keep track of whether the previous point is a sharp corner
  // ... so that we don't detect the same corner twice
  let isPrevPointSharpCorner = false;

  for (let i = 0; i < points.length; i++) {
    let { pressure } = points[i];
    const { point, vector, distance, runningLength } = points[i];
    const isLastPoint = i === points.length - 1;

    // Removes noise from the end of the line
    if (!isLastPoint && totalLength - runningLength < END_NOISE_THRESHOLD) {
      continue;
    }

    if (thinning) {
      if (shouldSimulatePressure) {
        // If we're simulating pressure, then do so based on the distance
        // between the current point and the previous point, and the size
        // of the stroke. Otherwise, use the input pressure.
        pressure = simulatePressure(prevPressure, distance, size);
      }

      radius = getStrokeRadius(size, thinning, pressure, easing);
    } else {
      radius = size / 2;
    }

    if (firstRadius === undefined) {
      firstRadius = radius;
    }

    const taperStartStrength = runningLength < taperStart ? taperStartEase(runningLength / taperStart) : 1;

    const taperEndStrength = totalLength - runningLength < taperEnd ? taperEndEase((totalLength - runningLength) / taperEnd) : 1;

    radius = Math.max(MIN_RADIUS, radius * Math.min(taperStartStrength, taperEndStrength));

    // Sharp corners: if the next vector is at more than a right angle to the current one, draw a cap here.
    const nextVector = (!isLastPoint ? points[i + 1] : points[i]).vector;
    const nextDpr = !isLastPoint ? dpr(vector, nextVector) : 1.0;
    const prevDpr = dpr(vector, prevVector);

    const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
    const isNextPointSharpCorner = nextDpr !== null && nextDpr < 0;

    if (isPointSharpCorner || isNextPointSharpCorner) {
      // Use mutable operations for the offset calculation
      perInto(_offset, prevVector);
      mulInto(_offset, _offset, radius);

      const step = 1 / CORNER_CAP_SEGMENTS;
      for (let t = 0; t <= 1; t += step) {
        // Calculate left point: rotate (point - offset) around point
        subInto(_tl, point, _offset);
        rotAroundInto(_tl, _tl, point, FIXED_PI * t);
        tempLeftPoint = [_tl[0], _tl[1]];
        leftPts.push(tempLeftPoint);

        // Calculate right point: rotate (point + offset) around point
        addInto(_tr, point, _offset);
        rotAroundInto(_tr, _tr, point, FIXED_PI * -t);
        tempRightPoint = [_tr[0], _tr[1]];
        rightPts.push(tempRightPoint);
      }

      prevLeftPoint = tempLeftPoint;
      prevRightPoint = tempRightPoint;

      if (isNextPointSharpCorner) {
        isPrevPointSharpCorner = true;
      }
      continue;
    }

    isPrevPointSharpCorner = false;

    // Handle the last point
    if (isLastPoint) {
      perInto(_offset, vector);
      mulInto(_offset, _offset, radius);
      leftPts.push(sub(point, _offset));
      rightPts.push(add(point, _offset));
      continue;
    }

    // Regular points: project to either side, keeping those far enough from the previous point on that side.
    lrpInto(_offset, nextVector, vector, nextDpr);
    perInto(_offset, _offset);
    mulInto(_offset, _offset, radius);

    subInto(_tl, point, _offset);
    tempLeftPoint = [_tl[0], _tl[1]];

    if (i <= 1 || dist2(prevLeftPoint, tempLeftPoint) > minDistance) {
      leftPts.push(tempLeftPoint);
      prevLeftPoint = tempLeftPoint;
    }

    addInto(_tr, point, _offset);
    tempRightPoint = [_tr[0], _tr[1]];

    if (i <= 1 || dist2(prevRightPoint, tempRightPoint) > minDistance) {
      rightPts.push(tempRightPoint);
      prevRightPoint = tempRightPoint;
    }

    // Set variables for next iteration
    prevPressure = pressure;
    prevVector = vector;
  }

  // Caps: tapered lines get none, but very short lines may become dots.
  const firstPoint: Vec2 = [points[0].point[0], points[0].point[1]];

  const lastPoint: Vec2 =
    points.length > 1 ? [points[points.length - 1].point[0], points[points.length - 1].point[1]] : add(points[0].point, [1, 1]);

  const startCap: Vec2[] = [];

  const endCap: Vec2[] = [];

  // Draw a dot for very short or completed strokes
  if (points.length === 1) {
    if (!(taperStart || taperEnd) || isComplete) {
      return drawDot(firstPoint, firstRadius || radius);
    }
  } else {
    // Draw start cap (unless tapered)
    if (taperStart || (taperEnd && points.length === 1)) {
      // The start point is tapered, noop
    } else if (capStart) {
      startCap.push(...drawRoundStartCap(firstPoint, rightPts[0], START_CAP_SEGMENTS));
    } else {
      startCap.push(...drawFlatStartCap(firstPoint, leftPts[0], rightPts[0]));
    }

    // Draw end cap (unless tapered)
    const direction = per(neg(points[points.length - 1].vector));

    if (taperEnd || (taperStart && points.length === 1)) {
      // Tapered end - push the last point to the line
      endCap.push(lastPoint);
    } else if (capEnd) {
      endCap.push(...drawRoundEndCap(lastPoint, direction, radius, END_CAP_SEGMENTS));
    } else {
      endCap.push(...drawFlatEndCap(lastPoint, direction, radius));
    }
  }

  // Winding order: left side, end cap, right side back, then the start cap.
  return leftPts.concat(endCap, rightPts.reverse(), startCap);
}

// ---- getStroke.ts

export function getStroke(
  points: (number[] | { x: number; y: number; pressure?: number })[],
  options: StrokeOptions = {} as StrokeOptions,
): Vec2[] {
  return getStrokeOutlinePoints(getStrokePoints(points, options), options);
}

export default getStroke;
