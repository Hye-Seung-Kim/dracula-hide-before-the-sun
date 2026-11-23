import { describe, expect, it } from "vitest";
import { LEVELS } from "../src/engine/levels.ts";
import { MovementDetector, boardZonePolygon, gazeRay, inPolygonZone, isAdjacent, isBetween, leftRightZone, shieldAim, sideOfBuilding } from "../src/engine/spatial.ts";

const deg = (d: number) => (d * Math.PI) / 180;
const [tower, hall, deli] = LEVELS[0].buildings;

describe("zones", () => {
  it("left/right with hysteresis", () => {
    expect(leftRightZone({ x: 100, y: 0 }, null)).toBe("LEFT");
    expect(leftRightZone({ x: 161, y: 0 }, "LEFT")).toBe("LEFT");
    expect(leftRightZone({ x: 170, y: 0 }, "LEFT")).toBe("RIGHT");
  });
  it("four-QR board polygon + custom polygon containment", () => {
    expect(inPolygonZone({ x: 160, y: 110 }, boardZonePolygon())).toBe(true);
    expect(inPolygonZone({ x: 5, y: 5 }, boardZonePolygon())).toBe(false);
    const custom = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }, { x: -10, y: 25 }];
    expect(inPolygonZone({ x: 25, y: 25 }, custom)).toBe(true);
    expect(inPolygonZone({ x: 60, y: 25 }, custom)).toBe(false);
  });
});

describe("position relationships", () => {
  it("left / right of a building", () => {
    expect(sideOfBuilding({ x: 40, y: 60 }, tower)).toBe("LEFT");
    expect(sideOfBuilding({ x: 150, y: 60 }, tower)).toBe("RIGHT");
    expect(sideOfBuilding({ x: 90, y: 100 }, tower)).toBe("ALIGNED");
  });
  it("between two buildings", () => {
    expect(isBetween({ x: 95, y: 106 }, tower, hall)).toBe(true);
    expect(isBetween({ x: 250, y: 30 }, tower, hall)).toBe(false);
  });
  it("adjacent to a building", () => {
    expect(isAdjacent({ x: 200, y: 130 }, deli, 7)).toBe(true);
    expect(isAdjacent({ x: 150, y: 130 }, deli, 7)).toBe(false);
  });
});

describe("directionality", () => {
  it("gaze ray hits the building Dracula faces", () => {
    const hit = gazeRay({ position: { x: 150, y: 60 }, heading: deg(270) }, LEVELS[0].buildings);
    expect(hit.building?.id).toBe("tower");
    expect(hit.distance!).toBeCloseTo(40, 0);
    const miss = gazeRay({ position: { x: 150, y: 60 }, heading: deg(0) }, LEVELS[0].buildings);
    expect(miss.building).toBeNull();
  });
  it("rotating the shield changes whether it aims at Dracula", () => {
    const d = { x: 160, y: 104 };
    expect(shieldAim({ position: { x: 170, y: 136 }, heading: deg(339) }, d, 7).aimed).toBe(true);
    expect(shieldAim({ position: { x: 170, y: 136 }, heading: deg(159) }, d, 7).aimed).toBe(false);
  });
});

describe("movement events", () => {
  it("INTO, OUT OF and TOWARD fire from position changes over frames", () => {
    const m = new MovementDetector();
    const zone = { name: "Left Half", contains: (p: { x: number }) => p.x < 160 };
    const events: string[] = [];
    let t = 0;
    const step = (x: number, y: number) => {
      for (const e of m.update({ x, y }, t, [zone], LEVELS[0].buildings)) events.push(`${e.type}:${e.subject}`);
      t += 100;
    };
    for (let x = 220; x >= 120; x -= 8) step(x, 200); // walk left along the bottom street
    for (let x = 120; x <= 220; x += 8) step(x, 200); // and back right
    for (let y = 30; y <= 110; y += 8) step(240, y); // straight down toward the deli
    expect(events).toContain("ENTER:Left Half");
    expect(events).toContain("EXIT:Left Half");
    expect(events).toContain("TOWARD:Corner Deli");
  });
});
