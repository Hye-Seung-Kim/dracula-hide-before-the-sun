import { anchorCenter, anchorQrSize, CORNER_ORDER, anchorSymbolCorners, classifyPayload } from "./boardLayout.ts";
import {
  add, applyHomography, centroid, computeHomographyLS, dist, invert3, isConvex, len, normalize, polygonArea, quadCenter,
  scale, sub, vecToBearing,
} from "./geometry.ts";
import type { Homography, MarkerDetection, Vec2 } from "./types.ts";

export interface CalibrationOptions {
  /** Manual fallback: rotate the automatic corner assignment by N quarter turns. */
  cornerOffset: number;
  /**
   * "auto": try all 8 anchor-to-corner assignments, keep the one whose homography fits all 16 symbol corners.
   * "image": manual fallback — board-north is image-up rotated by cornerOffset quarter turns.
   */
  mode: "auto" | "image";
}

export const DEFAULT_CALIBRATION_OPTIONS: CalibrationOptions = { cornerOffset: 0, mode: "auto" };

export interface CalibrationResult {
  ok: boolean;
  reason?: string;
  /** Number of individual anchor QR instances seen (identical payloads are NOT merged). */
  anchorCount: number;
  /** Image-space anchor centers TL, TR, BR, BL (if ok). */
  imageQuad?: Vec2[];
  /** image px -> world meters */
  H?: Homography;
  /** world meters -> image px */
  Hinv?: Homography;
  /** Image-space unit vector pointing to board-north. */
  boardUpImage?: Vec2;
  orientationSource?: "qr-orientation" | "image-axes";
  ambiguous: boolean;
  mirrored: boolean;
  /** Mean distance (world meters) between reprojected anchor symbol corners and their known positions. */
  reprojErrorMeters?: number;
}

/** Image-space "up" vector of a decoded QR symbol (from its bottom edge to its top edge). */
export function symbolUp(m: MarkerDetection): Vec2 {
  const [tl, tr, br, bl] = m.corners;
  return scale(add(sub(tl, bl), sub(tr, br)), 0.5);
}

export function symbolRotation(m: MarkerDetection): number {
  return vecToBearing(symbolUp(m));
}

function pickFour(anchors: MarkerDetection[]): MarkerDetection[] | null {
  if (anchors.length < 4) return null;
  if (anchors.length === 4) return anchors;
  // More than four (reflection, duplicate decode): choose the convex quad with the largest area.
  let best: MarkerDetection[] | null = null;
  let bestArea = -1;
  const n = Math.min(anchors.length, 8);
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const set = [anchors[a], anchors[b], anchors[c], anchors[d]];
          const area = polygonArea(orderByAngle(set.map((m) => m.center)));
          if (area > bestArea) {
            bestArea = area;
            best = set;
          }
        }
  return best;
}

function orderByAngle(points: Vec2[]): Vec2[] {
  const g = centroid(points);
  return [...points].sort((p, q) => Math.atan2(p.y - g.y, p.x - g.x) - Math.atan2(q.y - g.y, q.x - g.x));
}

interface Hypothesis {
  ordered: MarkerDetection[];
  mirrored: boolean;
  H: Homography;
  err: number;
}

/** Fit image -> world with all 16 symbol corners + 4 centres for a given anchor-to-corner assignment. */
function fitAssignment(ordered: MarkerDetection[], mirrored: boolean): Hypothesis | null {
  const src: Vec2[] = [];
  const dst: Vec2[] = [];
  ordered.forEach((m, i) => {
    const c = CORNER_ORDER[i];
    const known = anchorSymbolCorners(c);
    m.corners.forEach((p, k) => {
      src.push(p);
      dst.push(known[k]);
    });
    src.push(m.center);
    dst.push(anchorCenter(c));
  });
  const H = computeHomographyLS(src, dst);
  if (!H) return null;
  let e = 0;
  for (let i = 0; i < src.length; i++) e += dist(applyHomography(H, src[i]), dst[i]);
  return { ordered, mirrored, H, err: e / src.length };
}

/** A correct fit must be well under the QR size; a wrong assignment rotates/mirrors symbols (error ~ QR size). */
export const calibrationMaxError = () => 0.3 * anchorQrSize();

/**
 * Four-QR board calibration.
 * 1) find >=4 anchor instances (identical payloads are kept separate)
 * 2) sort their centres around the centroid (clockwise in the image)
 * 3) AUTO: try all 8 assignments (4 rotations x mirrored/not) and keep the one whose least-squares homography
 *    fits all 16 anchor symbol corners best. The anchors are drawn upright, so only the true assignment can fit
 *    every symbol's orientation. IMAGE (manual fallback): board-north = image-up rotated by cornerOffset quarter turns.
 * 4) accept if the fit error is small and the best assignment clearly beats the runner-up.
 */
export function calibrate(markers: MarkerDetection[], opts: CalibrationOptions = DEFAULT_CALIBRATION_OPTIONS): CalibrationResult {
  const anchors = markers.filter((m) => classifyPayload(m.payload) === "anchor");
  const base: CalibrationResult = { ok: false, anchorCount: anchors.length, ambiguous: false, mirrored: false };
  const four = pickFour(anchors);
  if (!four) return { ...base, reason: `Need 4 board QR codes, see ${anchors.length}` };

  const g = centroid(four.map((m) => m.center));
  if (Math.max(...four.map((m) => dist(m.center, g))) < 10) return { ...base, reason: "Board QR codes overlap" };

  // Clockwise ring in image space (y-down => increasing atan2 is clockwise on screen).
  const ring = [...four].sort((p, q) => Math.atan2(p.center.y - g.y, p.center.x - g.x) - Math.atan2(q.center.y - g.y, q.center.x - g.x));
  if (!isConvex(ring.map((m) => m.center))) return { ...base, reason: "Board QR quad is not convex" };

  let hyps: Hypothesis[] = [];
  let orientationSource: "qr-orientation" | "image-axes" = "qr-orientation";
  if (opts.mode === "image") {
    // Manual: TL = the corner closest to image top-left, rotated by the user's quarter turns.
    orientationSource = "image-axes";
    const startIdx = ring.reduce((best, m, i) => (m.center.x + m.center.y < ring[best].center.x + ring[best].center.y ? i : best), 0);
    const off = ((Math.round(opts.cornerOffset) % 4) + 4) % 4;
    const ordered = [0, 1, 2, 3].map((k) => ring[(startIdx + off + k) % 4]);
    const h = fitAssignment(ordered, false);
    if (h) hyps = [h];
  } else {
    const rev = [ring[0], ring[3], ring[2], ring[1]];
    for (const [list, mirrored] of [[ring, false], [rev, true]] as const)
      for (let k = 0; k < 4; k++) {
        const h = fitAssignment([0, 1, 2, 3].map((i) => list[(i + k) % 4]), mirrored);
        if (h) hyps.push(h);
      }
  }
  hyps.sort((p, q) => p.err - q.err);
  const best = hyps[0];
  if (!best) return { ...base, reason: "Homography failed" };
  const Hinv = invert3(best.H);
  if (!Hinv) return { ...base, reason: "Homography failed" };

  const runnerUp = hyps[1]?.err ?? Infinity;
  const ambiguous = runnerUp < best.err * 2;
  const fits = best.err < calibrationMaxError();
  const ok = fits && !ambiguous;
  // Board-north in the image, for the phone overlay.
  const cW = { x: (anchorCenter("TL").x + anchorCenter("BR").x) / 2, y: (anchorCenter("TL").y + anchorCenter("BR").y) / 2 };
  const up = normalize(sub(applyHomography(Hinv, { x: cW.x, y: cW.y - 20 }), applyHomography(Hinv, cW)));
  return {
    ok,
    reason: ok ? undefined : !fits ? `Corner fit too loose (${best.err.toFixed(1)} m > ${calibrationMaxError().toFixed(1)} m): hold the camera steadier / closer` : `Ambiguous corners (${best.err.toFixed(1)} vs ${runnerUp.toFixed(1)} m)`,
    anchorCount: anchors.length,
    imageQuad: best.ordered.map((m) => m.center),
    H: best.H,
    Hinv,
    boardUpImage: up,
    orientationSource,
    ambiguous,
    mirrored: best.mirrored,
    reprojErrorMeters: best.err,
  };
}

/** World pose of a detected object marker using the calibration homography. */
export function markerWorldPose(H: Homography, m: MarkerDetection): { center: Vec2; heading: number; worldCorners: Vec2[]; sizeMeters: number } {
  const worldCorners = m.corners.map((c) => applyHomography(H, c));
  const center = quadCenter(worldCorners);
  const [tl, tr, br, bl] = worldCorners;
  const upW = scale(add(sub(tl, bl), sub(tr, br)), 0.5);
  const sizeMeters = (len(sub(tr, tl)) + len(sub(br, bl)) + len(sub(tl, bl)) + len(sub(tr, br))) / 4;
  return { center, heading: vecToBearing(upW), worldCorners, sizeMeters };
}
