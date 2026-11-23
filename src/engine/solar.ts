import { getPosition } from "suncalc";
import { bearingToVec, scale } from "./geometry.ts";
import type { Vec2 } from "./types.ts";

/**
 * SunCalc v2.x (installed: 2.1.4) returns DEGREES, azimuth clockwise from NORTH (0=N, 90=E).
 * NOTE: this differs from SunCalc 1.x (radians, azimuth from SOUTH, westward). Verified in tests.
 */

export interface Place {
  city: string;
  lat: number;
  lng: number;
  timeZone: string;
}

export const NEW_YORK: Place = { city: "New York", lat: 40.7128, lng: -74.006, timeZone: "America/New_York" };

/** Offset (minutes, east of UTC positive) of `timeZone` at the given instant, via Intl. */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUTC - instant.getTime()) / 60000);
}

/** "2026-06-21" + "17:00" wall-clock time in `timeZone` -> UTC instant (DST-aware). */
export function zonedTimeToUtc(dateISO: string, time: string, timeZone: string): Date {
  const [y, m, d] = dateISO.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let off = tzOffsetMinutes(new Date(naive), timeZone);
  let utc = naive - off * 60000;
  const off2 = tzOffsetMinutes(new Date(utc), timeZone);
  if (off2 !== off) {
    off = off2;
    utc = naive - off * 60000;
  }
  return new Date(utc);
}

export interface SunInfo {
  utc: Date;
  azimuthDeg: number;
  altitudeDeg: number;
  /** World unit vector pointing TOWARD the sun (north-up board). */
  toSun: Vec2;
  /** World unit vector of ground shadows (AWAY from the sun). */
  shadowDir: Vec2;
  /** Shadow length per meter of object height: 1 / tan(altitude). */
  shadowFactor: number;
}

export function sunFor(place: Place, dateISO: string, time: string): SunInfo {
  const utc = zonedTimeToUtc(dateISO, time, place.timeZone);
  const p = getPosition(utc, place.lat, place.lng);
  const az = (p.azimuth * Math.PI) / 180;
  const toSun = bearingToVec(az);
  const alt = Math.max(p.altitude, 0.5);
  return {
    utc,
    azimuthDeg: ((p.azimuth % 360) + 360) % 360,
    altitudeDeg: p.altitude,
    toSun,
    shadowDir: scale(toSun, -1),
    shadowFactor: 1 / Math.tan((alt * Math.PI) / 180),
  };
}

export function compassName(deg: number): string {
  const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
