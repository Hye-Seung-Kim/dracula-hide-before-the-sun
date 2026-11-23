import { describe, expect, it } from "vitest";
import { getPosition } from "suncalc";
import { NEW_YORK, sunFor, tzOffsetMinutes, zonedTimeToUtc } from "../src/engine/solar.ts";
import { prismShadow } from "../src/engine/shadows.ts";
import { centroid, dot, normalize, rectPoly, sub } from "../src/engine/geometry.ts";
import { LEVELS } from "../src/engine/levels.ts";

describe("SunCalc version + units", () => {
  it("installed SunCalc returns degrees, azimuth clockwise from north", () => {
    // Noon-ish in NYC in June: sun must be roughly south (~180 deg) and high (> 60 deg) — in DEGREES.
    const p = getPosition(new Date("2026-06-21T17:00:00Z"), 40.7128, -74.006);
    expect(p.altitude).toBeGreaterThan(60);
    expect(p.altitude).toBeLessThan(90);
    expect(p.azimuth).toBeGreaterThan(150);
    expect(p.azimuth).toBeLessThan(230);
  });
});

describe("time zones", () => {
  it("summer uses EDT (UTC-4)", () => {
    expect(zonedTimeToUtc("2026-06-21", "17:00", "America/New_York").toISOString()).toBe("2026-06-21T21:00:00.000Z");
  });
  it("winter uses EST (UTC-5)", () => {
    expect(zonedTimeToUtc("2026-12-21", "17:00", "America/New_York").toISOString()).toBe("2026-12-21T22:00:00.000Z");
  });
  it("offset helper", () => {
    expect(tzOffsetMinutes(new Date("2026-07-01T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(tzOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "Asia/Seoul")).toBe(540);
  });
});

describe("sun direction plausibility (New York)", () => {
  it("morning sun is in the east, evening sun in the west", () => {
    const am = sunFor(NEW_YORK, "2026-06-21", "08:00");
    const pm = sunFor(NEW_YORK, "2026-06-21", "18:00");
    expect(am.azimuthDeg).toBeGreaterThan(45);
    expect(am.azimuthDeg).toBeLessThan(135);
    expect(pm.azimuthDeg).toBeGreaterThan(250);
    expect(pm.azimuthDeg).toBeLessThan(310);
    // World vectors: east = +x on the board, west = -x.
    expect(am.toSun.x).toBeGreaterThan(0.5);
    expect(pm.toSun.x).toBeLessThan(-0.5);
  });
  it("same clock time differs across the year", () => {
    const june = sunFor(NEW_YORK, "2026-06-21", "17:00");
    const dec = sunFor(NEW_YORK, "2026-12-21", "17:00");
    expect(june.altitudeDeg).toBeGreaterThan(20);
    expect(dec.altitudeDeg).toBeLessThan(0); // already set in December
  });
  it("every level happens in daylight", () => {
    for (const l of LEVELS) expect(sunFor(l.place, l.dateISO, l.time).altitudeDeg).toBeGreaterThan(15);
  });
});

describe("shadow geometry", () => {
  const fp = rectPoly(100, 100, 20, 20);
  it("shadow points AWAY from the sun", () => {
    for (const time of ["08:00", "12:30", "17:00"]) {
      const sun = sunFor(NEW_YORK, "2026-06-21", time);
      const sh = prismShadow(fp, 40, sun);
      const shift = normalize(sub(centroid(sh), centroid(fp)));
      expect(dot(shift, sun.toSun)).toBeLessThan(-0.95);
    }
  });
  it("lower sun -> longer shadow, higher sun -> shorter", () => {
    const low = sunFor(NEW_YORK, "2026-06-21", "18:30");
    const high = sunFor(NEW_YORK, "2026-06-21", "13:00");
    expect(low.altitudeDeg).toBeLessThan(high.altitudeDeg);
    const lenOf = (s: typeof low) => 40 * s.shadowFactor;
    expect(lenOf(low)).toBeGreaterThan(lenOf(high) * 2);
    expect(lenOf(high)).toBeCloseTo(40 / Math.tan((high.altitudeDeg * Math.PI) / 180), 5);
  });
  it("refuses night-time scenarios", () => {
    expect(() => prismShadow(fp, 40, sunFor(NEW_YORK, "2026-12-21", "18:00"))).toThrow(/below the horizon/);
  });
});
