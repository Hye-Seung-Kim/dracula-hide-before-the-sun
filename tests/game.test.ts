import { describe, expect, it } from "vitest";
import { LEVELS } from "../src/engine/levels.ts";
import { evaluatePlacement, checkPlacement } from "../src/engine/rules.ts";
import { gameReducer, initialGameState, type GameState } from "../src/engine/gameState.ts";
import { TrackingPipeline } from "../src/engine/tracking.ts";
import { makeVirtualCamera, simulateFrame } from "../src/engine/simulator.ts";
import { centroid } from "../src/engine/geometry.ts";
import type { Pose } from "../src/engine/types.ts";

const deg = (d: number) => (d * Math.PI) / 180;
const cam = makeVirtualCamera({ rotationDeg: 8, keystone: 0.1 });

/** Drive the real pipeline with simulated camera frames for `ms` milliseconds. */
function feed(p: TrackingPipeline, dracula: Pose | null, shield: Pose | null, t0: number, ms = 800, step = 80, jitterPx = 0.6) {
  let t = t0;
  for (; t < t0 + ms; t += step) p.ingest(simulateFrame(cam, { dracula, shield, jitterPx, markerSize: 32 }, "T", t), t);
  return t;
}

function toPrediction(levelIndex: number): GameState {
  let s = initialGameState();
  s = gameReducer(s, { type: "SOURCE", connected: true, calibrated: true, draculaSeen: true });
  s = gameReducer(s, { type: "START" });
  if (levelIndex) s = gameReducer(s, { type: "GOTO_LEVEL", levelIndex });
  return gameReducer(s, { type: "MISSION_DONE" });
}

describe("levels", () => {
  it("there are exactly three levels; only level 3 uses the shield", () => {
    expect(LEVELS.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(LEVELS.map((l) => l.usesShield)).toEqual([false, false, true]);
  });
  it.each(LEVELS)("level $id reference solution is SAFE (solvable)", (l) => {
    const sh = l.referenceSolution.shield ? { pose: l.referenceSolution.shield, markerSize: 32 } : null;
    const v = evaluatePlacement(l, l.referenceSolution.dracula, sh);
    expect(v.problems).toEqual([]);
    expect(v.safe).toBe(true);
  });
  it("level 1: west side of the tower is sunny at 5 PM (exposed)", () => {
    const v = evaluatePlacement(LEVELS[0], { x: 50, y: 90 });
    expect(v.problems).toEqual([]);
    expect(v.safe).toBe(false);
  });
  it("level 2: the courtyard's west half is a trap; the east edge is shaded", () => {
    expect(evaluatePlacement(LEVELS[1], { x: 158, y: 150 }).safe).toBe(false);
    expect(evaluatePlacement(LEVELS[1], { x: 186, y: 140 }).safe).toBe(true);
  });
  it("level 3: no natural shade anywhere in the destination circle", () => {
    const l = LEVELS[2];
    const d = l.destination!;
    for (let y = d.center.y - d.radius; y <= d.center.y + d.radius; y += 4)
      for (let x = d.center.x - d.radius; x <= d.center.x + d.radius; x += 4) {
        if (Math.hypot(x - d.center.x, y - d.center.y) > d.radius) continue;
        expect(evaluatePlacement(l, { x, y }, null).coverage).toBe(0);
      }
  });
  it("level 3: shield on the WRONG side (north of Dracula) fails", () => {
    const l = LEVELS[2];
    const v = evaluatePlacement(l, { x: 160, y: 104 }, { pose: { position: { x: 154, y: 72 }, heading: deg(159) }, markerSize: 32 });
    expect(v.safe).toBe(false);
  });
  it("Dracula inside a building footprint is an invalid placement", () => {
    const tower = LEVELS[0].buildings[0];
    expect(checkPlacement(LEVELS[0], centroid(tower.footprint))).toContain("ROOFTOP");
  });
});

describe("game flow through the real tracking pipeline", () => {
  it("Dracula in shadow -> O", () => {
    const p = new TrackingPipeline();
    const t = feed(p, { position: LEVELS[0].referenceSolution.dracula, heading: 0 }, null, 1000);
    let s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.phase).toBe("READY");
    s = gameReducer(gameReducer(s, { type: "REVEAL" }), { type: "REVEAL_DONE" });
    expect(s.phase).toBe("SUCCESS");
    expect(s.results[0]).toBe("O");
  });

  it("Dracula in sunlight -> X", () => {
    const p = new TrackingPipeline();
    const t = feed(p, { position: { x: 50, y: 90 }, heading: 0 }, null, 1000);
    let s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    s = gameReducer(gameReducer(s, { type: "REVEAL" }), { type: "REVEAL_DONE" });
    expect(s.phase).toBe("FAILURE");
    expect(s.results[0]).toBe("X");
  });

  it("Dracula on a rooftop -> READY refused", () => {
    const p = new TrackingPipeline();
    const t = feed(p, { position: centroid(LEVELS[0].buildings[0].footprint), heading: 0 }, null, 1000);
    const s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.phase).toBe("PREDICTION");
    expect(s.blockers.join()).toMatch(/roof/);
  });

  it("moving Dracula after READY does not change the submitted result", () => {
    const p = new TrackingPipeline();
    let t = feed(p, { position: { x: 50, y: 90 }, heading: 0 }, null, 1000); // sunny spot
    let s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    const submitted = s.submission!.dracula;
    t = feed(p, { position: LEVELS[0].referenceSolution.dracula, heading: 0 }, null, t, 1500); // now move into shade
    s = gameReducer(s, { type: "REVEAL" });
    s = gameReducer(s, { type: "REVEAL_DONE" });
    expect(s.submission!.dracula).toEqual(submitted);
    expect(s.phase).toBe("FAILURE");
    void t;
  });

  it("no automatic success when tracking is lost", () => {
    const p = new TrackingPipeline();
    let t = feed(p, { position: LEVELS[0].referenceSolution.dracula, heading: 0 }, null, 1000);
    t = feed(p, null, null, t, 1200); // Dracula marker disappears for longer than the 1 s freshness window
    const s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.phase).toBe("PREDICTION");
    expect(s.blockers.join()).toMatch(/not visible/);
  });

  it("no camera frames at all -> READY refused", () => {
    const p = new TrackingPipeline();
    const s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(5000), now: 5000 });
    expect(s.phase).toBe("PREDICTION");
    expect(s.blockers.length).toBeGreaterThan(0);
  });

  it("handheld camera: jitter + a dropped frame + one glitch frame still allow READY", () => {
    const p = new TrackingPipeline();
    const base = LEVELS[0].referenceSolution.dracula;
    let t = 1000;
    for (let i = 0; i < 14; i++, t += 120) {
      const glitch = i === 9; // one bad frame
      const dropped = i === 6 || i === 11; // marker missed
      const pos = glitch ? { x: base.x + 30, y: base.y } : { x: base.x + (Math.random() - 0.5) * 6, y: base.y + (Math.random() - 0.5) * 6 };
      p.ingest(simulateFrame(cam, { dracula: dropped ? null : { position: pos, heading: 0 }, jitterPx: 2, markerSize: 32 }, "T", t), t);
    }
    const s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.blockers).toEqual([]);
    expect(s.phase).toBe("READY");
    expect(Math.hypot(s.submission!.dracula.x - base.x, s.submission!.dracula.y - base.y)).toBeLessThan(4);
  });

  it("READY right after a big move never locks the OLD spot", () => {
    const p = new TrackingPipeline();
    let t = feed(p, { position: { x: 50, y: 90 }, heading: 0 }, null, 1000, 1200); // resting in the sun
    // Move into the shade and press READY on the very next frame.
    p.ingest(simulateFrame(cam, { dracula: { position: LEVELS[0].referenceSolution.dracula, heading: 0 }, markerSize: 32 }, "T", t), t);
    let s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.phase).toBe("PREDICTION"); // refused: just moved
    // After resting at the new spot, READY locks the NEW position.
    t = feed(p, { position: LEVELS[0].referenceSolution.dracula, heading: 0 }, null, t + 80, 1200);
    s = gameReducer(s, { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.phase).toBe("READY");
    expect(Math.hypot(s.submission!.dracula.x - LEVELS[0].referenceSolution.dracula.x, s.submission!.dracula.y - LEVELS[0].referenceSolution.dracula.y)).toBeLessThan(2);
  });

  it.each([1000, 1600])("slow phone (one frame every %i ms): resting Dracula can still be locked", (step) => {
    const p = new TrackingPipeline();
    const t = feed(p, { position: LEVELS[0].referenceSolution.dracula, heading: 0 }, null, 1000, step * 6, step, 1.5);
    const snap = p.snapshot(t + step * 0.8); // pressed between two frames
    expect(snap.dracula.status).toBe("tracked");
    const s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: snap, now: t + step * 0.8 });
    expect(s.blockers).toEqual([]);
    expect(s.phase).toBe("READY");
  });

  it("a token that is still being moved is not locked", () => {
    const p = new TrackingPipeline();
    let t = 1000;
    for (let i = 0; i < 12; i++, t += 100) p.ingest(simulateFrame(cam, { dracula: { position: { x: 100 + i * 6, y: 190 }, heading: 0 }, markerSize: 32 }, "T", t), t);
    const s = gameReducer(toPrediction(0), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.phase).toBe("PREDICTION");
    expect(s.blockers.join()).toMatch(/still/);
  });

  it("level 3 works with the physical shield (via its tracked marker)", () => {
    const l = LEVELS[2];
    const p = new TrackingPipeline();
    const t = feed(p, { position: l.referenceSolution.dracula, heading: 0 }, l.referenceSolution.shield!, 1000);
    let s = gameReducer(toPrediction(2), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.blockers).toEqual([]);
    expect(s.phase).toBe("READY");
    expect(s.submission!.shield).not.toBeNull();
    s = gameReducer(gameReducer(s, { type: "REVEAL" }), { type: "REVEAL_DONE" });
    expect(s.phase).toBe("SUCCESS");
    expect(s.verdict!.shieldCoverage!).toBeGreaterThan(0.75);
  });

  it("level 3: Dracula waits at the fountain — only the shield marker is needed", () => {
    const l = LEVELS[2];
    const p = new TrackingPipeline();
    const t = feed(p, null, l.referenceSolution.shield!, 1000); // no Dracula marker at all
    let s = gameReducer(toPrediction(2), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.blockers).toEqual([]);
    expect(s.submission!.dracula).toEqual(l.draculaFixed);
    s = gameReducer(gameReducer(s, { type: "REVEAL" }), { type: "REVEAL_DONE" });
    expect(s.phase).toBe("SUCCESS");
  });

  it("level 3 without the shield in view -> READY refused", () => {
    const l = LEVELS[2];
    const p = new TrackingPipeline();
    const t = feed(p, { position: l.referenceSolution.dracula, heading: 0 }, null, 1000);
    const s = gameReducer(toPrediction(2), { type: "PRESS_READY", tracking: p.snapshot(t), now: t });
    expect(s.phase).toBe("PREDICTION");
    expect(s.blockers.join()).toMatch(/shield/);
  });

  it("level progression 1 -> 2 -> 3 -> complete", () => {
    let s = toPrediction(0);
    for (let i = 0; i < 3; i++) {
      s = { ...s, phase: "SUCCESS" };
      s = gameReducer(s, { type: "NEXT" });
      if (i < 2) {
        expect(s.phase).toBe("LEVEL_TRANSITION");
        expect(s.levelIndex).toBe(i + 1);
        s = gameReducer(s, { type: "TRANSITION_DONE" });
        expect(s.phase).toBe("MISSION");
      }
    }
    expect(s.phase).toBe("GAME_COMPLETE");
  });
});

describe("level 3 physical tolerance", () => {
  it("the shield solution survives ±3 m of placement error and keeps the wall clear of the figurine", async () => {
    const { shieldWall } = await import("../src/engine/shadows.ts");
    const { distPointSegment } = await import("../src/engine/geometry.ts");
    const l = LEVELS[2];
    const ref = l.referenceSolution;
    const [a, b] = shieldWall(ref.shield!, l.shield!, 32);
    // Physical figurine ~2 cm wide = ~13 m radius on a 13" laptop.
    expect(distPointSegment(ref.dracula, a, b)).toBeGreaterThan(13);
    for (const dx of [-3, 0, 3]) for (const dy of [-3, 0, 3]) {
      const v = evaluatePlacement(l, { x: ref.dracula.x + dx, y: ref.dracula.y + dy }, { pose: ref.shield!, markerSize: 32 });
      expect(v.safe, `offset ${dx},${dy}`).toBe(true);
    }
  });
});
