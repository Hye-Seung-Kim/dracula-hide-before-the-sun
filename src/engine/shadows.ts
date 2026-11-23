import { add, bearingToVec, convexHull, isConvex, scale } from "./geometry.ts";
import type { SunInfo } from "./solar.ts";
import type { Building, Pose, Vec2 } from "./types.ts";

/**
 * Deterministic 2.5D shadow model (flat ground, vertical prisms):
 *   shadowLength = height / tan(sunAltitude), projected AWAY from the sun.
 * For a convex footprint the ground shadow of the prism is exactly hull(footprint ∪ footprint + offset).
 * Not a full 3D simulation: no shadows falling onto roofs, no terrain.
 */

export interface ShadowPoly {
  sourceId: string;
  kind: "building" | "shield";
  poly: Vec2[];
}

export function shadowOffset(heightMeters: number, sun: SunInfo): Vec2 {
  return scale(sun.shadowDir, heightMeters * sun.shadowFactor);
}

export function prismShadow(footprint: Vec2[], heightMeters: number, sun: SunInfo): Vec2[] {
  if (sun.altitudeDeg <= 0) throw new Error("Sun is below the horizon: every level must be in daylight");
  if (!isConvex(footprint)) throw new Error("Building footprints must be convex (split concave buildings into parts)");
  const off = shadowOffset(heightMeters, sun);
  return convexHull([...footprint, ...footprint.map((p) => add(p, off))]);
}

export function buildingShadow(b: Building, sun: SunInfo): ShadowPoly {
  return { sourceId: b.id, kind: "building", poly: prismShadow(b.footprint, b.heightMeters, sun) };
}

export interface ShieldSpec {
  /** Simulated wall width (m) */
  widthMeters: number;
  /** Simulated wall height (m) */
  heightMeters: number;
  /**
   * Where the wall stands relative to the QR marker, along the marker's facing axis, in MARKER-SIDE units
   * (so it is independent of the laptop screen size). 0.75 = the wall stands on the card edge in front of the QR.
   */
  wallOffsetMarkerUnits: number;
}

/** Wall segment endpoints [A, B] for a shield whose marker is at `pose`. */
export function shieldWall(pose: Pose, spec: ShieldSpec, markerSizeMeters: number): [Vec2, Vec2] {
  const f = bearingToVec(pose.heading);
  const right = { x: -f.y, y: f.x };
  const c = add(pose.position, scale(f, spec.wallOffsetMarkerUnits * markerSizeMeters));
  return [add(c, scale(right, -spec.widthMeters / 2)), add(c, scale(right, spec.widthMeters / 2))];
}

export function shieldShadow(pose: Pose, spec: ShieldSpec, markerSizeMeters: number, sun: SunInfo): ShadowPoly {
  const [a, b] = shieldWall(pose, spec, markerSizeMeters);
  const off = shadowOffset(spec.heightMeters, sun);
  return { sourceId: "shield", kind: "shield", poly: convexHull([a, b, add(a, off), add(b, off)]) };
}
