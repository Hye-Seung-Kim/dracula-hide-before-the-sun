import type { Homography, Vec2 } from "./types.ts";

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const normalize = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Unit vector for a compass bearing in world space (0 = north = -y, PI/2 = east = +x). */
export const bearingToVec = (bearing: number): Vec2 => ({ x: Math.sin(bearing), y: -Math.cos(bearing) });
/** Compass bearing of a world/image vector (y-down). */
export const vecToBearing = (d: Vec2): number => Math.atan2(d.x, -d.y);

export const wrapAngle = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
};

export function centroid(points: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** Shoelace signed area. Positive = clockwise on screen (y-down). */
export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export const polygonArea = (poly: Vec2[]): number => Math.abs(signedArea(poly));

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function isConvex(poly: Vec2[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const z = cross(sub(b, a), sub(c, b));
    if (Math.abs(z) < 1e-9) continue;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Andrew's monotone chain. Returns hull in clockwise-on-screen order (y-down). */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(p, lower[lower.length - 1])) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(p, upper[upper.length - 1])) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function distPointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, scale(ab, t)));
}

/** Distance from point to polygon boundary; 0 if inside. */
export function distPointPolygon(p: Vec2, poly: Vec2[]): number {
  if (pointInPolygon(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distPointSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return best;
}

/** Ray (origin + t*dir, t>=0) vs segment. Returns t or null. */
export function raySegment(origin: Vec2, dir: Vec2, a: Vec2, b: Vec2): number | null {
  const s = sub(b, a);
  const denom = cross(dir, s);
  if (Math.abs(denom) < 1e-12) return null;
  const ao = sub(a, origin);
  const t = cross(ao, s) / denom;
  const u = cross(ao, dir) / denom;
  if (t >= 0 && u >= 0 && u <= 1) return t;
  return null;
}

export function rayPolygon(origin: Vec2, dir: Vec2, poly: Vec2[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const t = raySegment(origin, dir, poly[i], poly[(i + 1) % poly.length]);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

export function rayCircle(origin: Vec2, dir: Vec2, center: Vec2, r: number): number | null {
  const d = normalize(dir);
  const oc = sub(origin, center);
  const b = dot(oc, d);
  const c = dot(oc, oc) - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  const t1 = -b + sq;
  if (t1 < 0) return null;
  return t0 >= 0 ? t0 : 0;
}

/** Equal-area sample points inside a disc (Vogel / sunflower spiral). */
export function discSamples(center: Vec2, radius: number, n = 240): Vec2[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const r = radius * Math.sqrt((i + 0.5) / n);
    const a = i * golden;
    out.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return out;
}

/** Fraction of a disc covered by the union of polygons. */
export function discCoverage(center: Vec2, radius: number, polys: Vec2[][], n = 240): number {
  if (radius <= 0) return polys.some((p) => pointInPolygon(center, p)) ? 1 : 0;
  const samples = discSamples(center, radius, n);
  let inside = 0;
  for (const s of samples) if (polys.some((p) => pointInPolygon(s, p))) inside++;
  return inside / samples.length;
}

export function rectPoly(x: number, y: number, w: number, h: number): Vec2[] {
  return [v(x, y), v(x + w, y), v(x + w, y + h), v(x, y + h)];
}

export function bbox(poly: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Intersection of segment diagonals (projective centre of a quad). */
export function quadCenter(c: Vec2[]): Vec2 {
  const [a, b, cc, d] = c;
  const r = sub(cc, a);
  const s = sub(d, b);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-9) return centroid(c);
  const t = cross(sub(b, a), s) / denom;
  return add(a, scale(r, t));
}

// ---------------------------------------------------------------- homography

/** Solve A x = b with Gaussian elimination + partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homography H such that H * src[i] ~ dst[i] for 4 point pairs. */
export function computeHomography(src: Vec2[], dst: Vec2[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  // Normalise for conditioning.
  const norm = (pts: Vec2[]) => {
    const c = centroid(pts);
    const s = pts.reduce((acc, p) => acc + dist(p, c), 0) / pts.length || 1;
    const k = Math.SQRT2 / s;
    return { T: [k, 0, -k * c.x, 0, k, -k * c.y, 0, 0, 1], pts: pts.map((p) => ({ x: (p.x - c.x) * k, y: (p.y - c.y) * k })) };
  };
  const ns = norm(src);
  const nd = norm(dst);
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = ns.pts[i];
    const { x: X, y: Y } = nd.pts[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  const h = solve(A, b);
  if (!h) return null;
  const Hn = [...h, 1];
  // H = Td^-1 * Hn * Ts
  const Tdinv = invert3(nd.T);
  if (!Tdinv) return null;
  const H = mul3(mul3(Tdinv, Hn), ns.T);
  const s = H[8];
  return H.map((x) => x / s);
}

/**
 * Least-squares homography from N >= 4 point pairs (normalised DLT, h33 = 1).
 * Used for calibration with all 16 anchor symbol corners + 4 centres, which averages out corner noise.
 */
export function computeHomographyLS(src: Vec2[], dst: Vec2[]): Homography | null {
  if (src.length < 4 || src.length !== dst.length) return null;
  const norm = (pts: Vec2[]) => {
    const c = centroid(pts);
    const s = pts.reduce((acc, p) => acc + dist(p, c), 0) / pts.length || 1;
    const k = Math.SQRT2 / s;
    return { T: [k, 0, -k * c.x, 0, k, -k * c.y, 0, 0, 1], pts: pts.map((p) => ({ x: (p.x - c.x) * k, y: (p.y - c.y) * k })) };
  };
  const ns = norm(src);
  const nd = norm(dst);
  const ATA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const ATb = new Array(8).fill(0);
  const addRow = (r: number[], b: number) => {
    for (let i = 0; i < 8; i++) {
      ATb[i] += r[i] * b;
      for (let j = 0; j < 8; j++) ATA[i][j] += r[i] * r[j];
    }
  };
  for (let i = 0; i < src.length; i++) {
    const { x, y } = ns.pts[i];
    const { x: X, y: Y } = nd.pts[i];
    addRow([x, y, 1, 0, 0, 0, -X * x, -X * y], X);
    addRow([0, 0, 0, x, y, 1, -Y * x, -Y * y], Y);
  }
  const h = solve(ATA, ATb);
  if (!h) return null;
  const Tdinv = invert3(nd.T);
  if (!Tdinv) return null;
  const H = mul3(mul3(Tdinv, [...h, 1]), ns.T);
  return H.map((x) => x / H[8]);
}

export function applyHomography(H: Homography, p: Vec2): Vec2 {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

export function mul3(a: number[], b: number[]): number[] {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((x) => x / det);
}
