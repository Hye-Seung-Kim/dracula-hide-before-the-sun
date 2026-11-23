import { BOARD_H, BOARD_W, inAnchorSafeArea } from "./boardLayout.ts";
import { discCoverage, dist, distPointPolygon, pointInPolygon } from "./geometry.ts";
import type { Level } from "./levels.ts";
import { buildingShadow, shieldShadow, shieldWall, type ShadowPoly } from "./shadows.ts";
import { sunFor, type SunInfo } from "./solar.ts";
import type { Pose, Vec2 } from "./types.ts";

export const RULES = {
  /** Dracula's logical footprint (his feet), world meters. */
  draculaRadius: 7,
  /** Fraction of the footprint that must be in shade. */
  coverageThreshold: 0.75,
  /** Footprint radius is reduced by this much to absorb marker noise (~1 m measured jitter). */
  trackingToleranceMeters: 1,
};

export type PlacementProblem = "ROOFTOP" | "OFF_MAP" | "OUTSIDE_TARGET" | "SHIELD_MISSING" | "SHIELD_IN_BUILDING";

export const PROBLEM_TEXT: Record<PlacementProblem, string> = {
  ROOFTOP: "Dracula can't stand on a roof — move him onto the street.",
  OFF_MAP: "Dracula is outside the city (or on a QR anchor).",
  OUTSIDE_TARGET: "Dracula must stand inside the golden circle.",
  SHIELD_MISSING: "Bring the shield into view.",
  SHIELD_IN_BUILDING: "The shield can't stand inside a building.",
};

export function checkPlacement(level: Level, dracula: Vec2, shield?: { pose: Pose; markerSize: number } | null): PlacementProblem[] {
  const out: PlacementProblem[] = [];
  const r = RULES.draculaRadius;
  if (dracula.x < r || dracula.y < r || dracula.x > BOARD_W - r || dracula.y > BOARD_H - r || inAnchorSafeArea(dracula, 0)) out.push("OFF_MAP");
  // Inside a footprint, or more than ~half the footprint overlapping a building.
  if (level.buildings.some((b) => pointInPolygon(dracula, b.footprint) || distPointPolygon(dracula, b.footprint) < r * 0.3)) out.push("ROOFTOP");
  if (level.destination && dist(dracula, level.destination.center) > level.destination.radius) out.push("OUTSIDE_TARGET");
  if (level.usesShield) {
    if (!shield) out.push("SHIELD_MISSING");
    else {
      const [a, b2] = shieldWall(shield.pose, level.shield!, shield.markerSize);
      const mid = { x: (a.x + b2.x) / 2, y: (a.y + b2.y) / 2 };
      if (level.buildings.some((b) => pointInPolygon(mid, b.footprint))) out.push("SHIELD_IN_BUILDING");
    }
  }
  return out;
}

export function levelSun(level: Level): SunInfo {
  return sunFor(level.place, level.dateISO, level.time);
}

export function computeShadows(level: Level, sun: SunInfo, shield?: { pose: Pose; markerSize: number } | null): ShadowPoly[] {
  const polys = level.buildings.map((b) => buildingShadow(b, sun));
  if (level.usesShield && shield) polys.push(shieldShadow(shield.pose, level.shield!, shield.markerSize, sun));
  return polys;
}

export interface Verdict {
  safe: boolean;
  coverage: number;
  problems: PlacementProblem[];
  sun: SunInfo;
  shadows: ShadowPoly[];
  /** Coverage contributed by the shield alone (Level 3 feedback). */
  shieldCoverage?: number;
}

/** Evaluate a SUBMITTED placement. Pure function: the result depends only on the snapshot passed in. */
export function evaluatePlacement(level: Level, dracula: Vec2, shield?: { pose: Pose; markerSize: number } | null): Verdict {
  const sun = levelSun(level);
  const shadows = computeShadows(level, sun, shield);
  const problems = checkPlacement(level, dracula, shield);
  const rEval = Math.max(0, RULES.draculaRadius - RULES.trackingToleranceMeters);
  const coverage = discCoverage(dracula, rEval, shadows.map((s) => s.poly));
  const shieldPoly = shadows.find((s) => s.kind === "shield");
  const shieldCoverage = shieldPoly ? discCoverage(dracula, rEval, [shieldPoly.poly]) : undefined;
  return { safe: problems.length === 0 && coverage >= RULES.coverageThreshold, coverage, problems, sun, shadows, shieldCoverage };
}
