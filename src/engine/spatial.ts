/**
 * Workshop spatial relationships: Zones, Position, Movement, Directionality.
 * All predicates are real geometry on tracked WORLD coordinates (no hard-coded labels).
 */
import { anchorCenter, BOARD_W, CORNER_ORDER } from "./boardLayout.ts";
import {
  bearingToVec, centroid, convexHull, dist, distPointPolygon, pointInPolygon, rayCircle, rayPolygon, add, scale,
} from "./geometry.ts";
import type { Building, Pose, Vec2 } from "./types.ts";

// ------------------------------------------------------------------ ZONES

export type Half = "LEFT" | "RIGHT";

/** Left/right half of the board, with hysteresis so the indicator doesn't flicker on the midline. */
export function leftRightZone(p: Vec2, prev: Half | null, hysteresis = 3): Half {
  const mid = BOARD_W / 2;
  if (prev === "LEFT" && p.x < mid + hysteresis) return "LEFT";
  if (prev === "RIGHT" && p.x > mid - hysteresis) return "RIGHT";
  return p.x < mid ? "LEFT" : "RIGHT";
}

/** Polygon through the four QR anchor centers, clockwise. */
export function boardZonePolygon(): Vec2[] {
  return CORNER_ORDER.map((c) => anchorCenter(c));
}

export function inPolygonZone(p: Vec2, poly: Vec2[]): boolean {
  return poly.length >= 3 && pointInPolygon(p, poly);
}

// ------------------------------------------------------------------ POSITION

export type Side = "LEFT" | "RIGHT" | "ALIGNED";

/** Is p left or right of a building (compared against the footprint's x-extent, with a margin). */
export function sideOfBuilding(p: Vec2, b: Building, margin = 2): Side {
  const xs = b.footprint.map((q) => q.x);
  if (p.x < Math.min(...xs) - margin) return "LEFT";
  if (p.x > Math.max(...xs) + margin) return "RIGHT";
  return "ALIGNED";
}

/** p is BETWEEN A and B if it lies in the convex hull of both footprints but in neither footprint. */
export function isBetween(p: Vec2, a: Building, b: Building): boolean {
  const hull = convexHull([...a.footprint, ...b.footprint]);
  return pointInPolygon(p, hull) && !pointInPolygon(p, a.footprint) && !pointInPolygon(p, b.footprint);
}

/** ADJACENT: Dracula's footprint edge is within `gap` meters of the building wall. */
export function isAdjacent(p: Vec2, b: Building, radius: number, gap = 8): boolean {
  return distPointPolygon(p, b.footprint) - radius <= gap;
}

export function nearestBuilding(p: Vec2, buildings: Building[]): { building: Building; distance: number } | null {
  let best: { building: Building; distance: number } | null = null;
  for (const b of buildings) {
    const d = distPointPolygon(p, b.footprint);
    if (!best || d < best.distance) best = { building: b, distance: d };
  }
  return best;
}

// ------------------------------------------------------------------ DIRECTIONALITY

export interface RayHit {
  origin: Vec2;
  dir: Vec2;
  /** End point to draw (hit point or max length) */
  end: Vec2;
  building: Building | null;
  distance: number | null;
}

/** Function 1: Dracula's facing ray -> first building it hits. */
export function gazeRay(pose: Pose, buildings: Building[], maxLen = 400): RayHit {
  const dir = bearingToVec(pose.heading);
  let best: { b: Building; t: number } | null = null;
  for (const b of buildings) {
    const t = rayPolygon(pose.position, dir, b.footprint);
    if (t !== null && (!best || t < best.t)) best = { b, t };
  }
  const t = best ? best.t : maxLen;
  return { origin: pose.position, dir, end: add(pose.position, scale(dir, t)), building: best?.b ?? null, distance: best?.t ?? null };
}

/** Function 2: is the shield's facing axis aimed at Dracula's footprint? */
export function shieldAim(shield: Pose, dracula: Vec2, radius: number, maxLen = 400): { aimed: boolean; distance: number | null; end: Vec2; dir: Vec2 } {
  const dir = bearingToVec(shield.heading);
  const t = rayCircle(shield.position, dir, dracula, radius);
  const aimed = t !== null && t <= maxLen;
  return { aimed, distance: t, dir, end: add(shield.position, scale(dir, aimed ? dist(shield.position, dracula) : 120)) };
}

// ------------------------------------------------------------------ MOVEMENT

export interface MovementEvent {
  t: number;
  type: "ENTER" | "EXIT" | "TOWARD" | "AWAY";
  subject: string;
  message: string;
}

export interface NamedZone {
  name: string;
  contains: (p: Vec2) => boolean;
}

/**
 * Turns successive tracked positions into discrete movement events. A zone change must persist for
 * `debounceMs` before an ENTER/EXIT fires; TOWARD/AWAY need a sustained distance change over `windowMs`.
 */
export class MovementDetector {
  private inside = new Map<string, { state: boolean; since: number; pending: boolean | null; pendingSince: number }>();
  private samples: { t: number; p: Vec2 }[] = [];
  private lastFired = new Map<string, number>();
  debounceMs = 250;
  windowMs = 900;
  approachMeters = 12;

  reset() {
    this.inside.clear();
    this.samples = [];
    this.lastFired.clear();
  }

  update(p: Vec2 | null, t: number, zones: NamedZone[], buildings: Building[]): MovementEvent[] {
    const events: MovementEvent[] = [];
    if (!p) return events;
    this.samples.push({ t, p });
    this.samples = this.samples.filter((s) => t - s.t <= this.windowMs);

    for (const z of zones) {
      const now = z.contains(p);
      const st = this.inside.get(z.name);
      if (!st) {
        this.inside.set(z.name, { state: now, since: t, pending: null, pendingSince: t });
        continue;
      }
      if (now === st.state) {
        st.pending = null;
        continue;
      }
      if (st.pending !== now) {
        st.pending = now;
        st.pendingSince = t;
      }
      if (t - st.pendingSince >= this.debounceMs) {
        st.state = now;
        st.since = t;
        st.pending = null;
        events.push({ t, type: now ? "ENTER" : "EXIT", subject: z.name, message: `Dracula moved ${now ? "INTO" : "OUT OF"} ${z.name}` });
      }
    }

    if (this.samples.length >= 3 && t - this.samples[0].t >= this.windowMs * 0.6) {
      const first = this.samples[0].p;
      for (const b of buildings) {
        const d0 = distPointPolygon(first, b.footprint);
        const d1 = distPointPolygon(p, b.footprint);
        const delta = d1 - d0;
        if (Math.abs(delta) < this.approachMeters) continue;
        // Require the motion to actually point at / away from the building, not just slide along it.
        const travel = dist(first, p);
        if (travel < this.approachMeters || Math.abs(delta) / travel < 0.6) continue;
        const type = delta < 0 ? "TOWARD" : "AWAY";
        const key = `${type}:${b.id}`;
        if (t - (this.lastFired.get(key) ?? 0) < 1500) continue;
        this.lastFired.set(key, t);
        events.push({ t, type, subject: b.name, message: `Dracula is moving ${type} ${b.name}` });
      }
    }
    return events;
  }

  trail(): Vec2[] {
    return this.samples.map((s) => s.p);
  }
}

export function buildingCenter(b: Building): Vec2 {
  return centroid(b.footprint);
}
