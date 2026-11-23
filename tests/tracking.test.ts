import { describe, expect, it } from "vitest";
import { calibrate } from "../src/engine/calibration.ts";
import { dist, wrapAngle } from "../src/engine/geometry.ts";
import { makeVirtualCamera, simulateFrame } from "../src/engine/simulator.ts";
import { TRACKING, TrackingPipeline } from "../src/engine/tracking.ts";

const deg = (d: number) => (d * Math.PI) / 180;

describe("four-QR calibration (geometry)", () => {
  it.each([0, 37, 90, 145, 180, 270, -60])("phone rotated %i deg: corners are not swapped", (rot) => {
    const cam = makeVirtualCamera({ rotationDeg: rot, keystone: 0.15 });
    const f = simulateFrame(cam, { dracula: { position: { x: 100, y: 150 }, heading: deg(70) } });
    const cal = calibrate(f.markers);
    expect(cal.ok).toBe(true);
    expect(cal.orientationSource).toBe("qr-orientation");
    expect(cal.reprojErrorMeters!).toBeLessThan(0.01);
  });
  it("identical anchor payloads are kept as four instances", () => {
    const f = simulateFrame(makeVirtualCamera(), {});
    expect(f.markers.filter((m) => m.payload === "zone:dracula-board").length).toBe(4);
    expect(calibrate(f.markers).anchorCount).toBe(4);
  });
  it("missing one corner -> not calibrated", () => {
    const cal = calibrate(simulateFrame(makeVirtualCamera(), { hiddenAnchors: ["TL"] }).markers);
    expect(cal.ok).toBe(false);
    expect(cal.anchorCount).toBe(3);
  });
  it("a wrong manual corner offset is caught by the 16-corner check", () => {
    const f = simulateFrame(makeVirtualCamera({ rotationDeg: 20 }), {});
    expect(calibrate(f.markers, { mode: "image", cornerOffset: 0 }).ok).toBe(true);
    expect(calibrate(f.markers, { mode: "image", cornerOffset: 1 }).ok).toBe(false);
  });
  it("auto mode ignores a stale manual offset (searches all 8 assignments)", () => {
    const f = simulateFrame(makeVirtualCamera({ rotationDeg: 200, keystone: 0.2 }), {});
    expect(calibrate(f.markers, { mode: "auto", cornerOffset: 3 }).ok).toBe(true);
  });
  it("handheld phone: noisy corners (±4 px), small board in frame, strong perspective still calibrate", () => {
    for (const rot of [90, -90, 15]) {
      const cam = makeVirtualCamera({ width: 1080, height: 1920, rotationDeg: rot, keystone: 0.25, fill: 0.55 });
      for (let i = 0; i < 10; i++) {
        const cal = calibrate(simulateFrame(cam, { jitterPx: 8 }).markers);
        expect(cal.ok, cal.reason).toBe(true);
      }
    }
  });
  it("ambiguous orientation falls back to image axes + manual offset", () => {
    const cam = makeVirtualCamera({ rotationDeg: 90 });
    const f = simulateFrame(cam, {});
    // "image" mode assumes board-north = image-up, which is wrong for a 90deg phone -> needs offset.
    const results = [0, 1, 2, 3].map((k) => calibrate(f.markers, { mode: "image", cornerOffset: k }).ok);
    expect(results.filter(Boolean).length).toBe(1);
  });
});

describe("tracking pipeline", () => {
  it("screen resizing / zoom: same world position regardless of how large the board appears", () => {
    for (const fill of [0.5, 0.75, 0.95]) {
      const p = new TrackingPipeline();
      const cam = makeVirtualCamera({ fill, rotationDeg: 5 });
      for (let t = 0; t < 400; t += 50) p.ingest(simulateFrame(cam, { dracula: { position: { x: 200, y: 70 }, heading: 0 } }, "S", t), t);
      expect(dist(p.snapshot(400).dracula.pose!.position, { x: 200, y: 70 })).toBeLessThan(0.5);
    }
  });

  it("camera orientation change mid-game recalibrates without restarting", () => {
    const p = new TrackingPipeline();
    const target = { x: 120, y: 160 };
    let t = 0;
    for (; t < 500; t += 50) p.ingest(simulateFrame(makeVirtualCamera({ rotationDeg: 0 }), { dracula: { position: target, heading: deg(30) } }, "S", t), t);
    for (; t < 1000; t += 50) p.ingest(simulateFrame(makeVirtualCamera({ rotationDeg: 120, keystone: 0.1 }), { dracula: { position: target, heading: deg(30) } }, "S", t), t);
    const s = p.snapshot(t);
    expect(dist(s.dracula.pose!.position, target)).toBeLessThan(0.5);
    expect(Math.abs(wrapAngle(s.dracula.pose!.heading - deg(30)))).toBeLessThan(deg(1));
  });

  it("temporary marker loss: holds last position, then reports lost (never fabricates)", () => {
    const p = new TrackingPipeline();
    const cam = makeVirtualCamera();
    let t = 0;
    for (; t < 500; t += 50) p.ingest(simulateFrame(cam, { dracula: { position: { x: 100, y: 100 }, heading: 0 } }, "S", t), t);
    for (; t < 1700; t += 50) p.ingest(simulateFrame(cam, {}, "S", t), t);
    let s = p.snapshot(t);
    expect(s.dracula.status).toBe("held");
    expect(dist(s.dracula.pose!.position, { x: 100, y: 100 })).toBeLessThan(0.5);
    for (; t < 3500; t += 50) p.ingest(simulateFrame(cam, {}, "S", t), t);
    s = p.snapshot(t);
    expect(s.dracula.status).toBe("lost");
    expect(s.dracula.pose).toBeNull();
  });

  it("a one-frame glitch does not teleport Dracula", () => {
    const p = new TrackingPipeline();
    const cam = makeVirtualCamera();
    let t = 0;
    for (; t < 500; t += 50) p.ingest(simulateFrame(cam, { dracula: { position: { x: 100, y: 100 }, heading: 0 } }, "S", t), t);
    p.ingest(simulateFrame(cam, { dracula: { position: { x: 250, y: 180 }, heading: 0 } }, "S", t), t);
    expect(dist(p.snapshot(t).dracula.pose!.position, { x: 100, y: 100 })).toBeLessThan(1);
    // ...but a real, sustained move is accepted.
    for (t += 50; t < 800; t += 50) p.ingest(simulateFrame(cam, { dracula: { position: { x: 250, y: 180 }, heading: 0 } }, "S", t), t);
    expect(dist(p.snapshot(t).dracula.pose!.position, { x: 250, y: 180 })).toBeLessThan(1);
  });

  it("hand covering one anchor: calibration is held briefly so tracking continues", () => {
    const p = new TrackingPipeline();
    const cam = makeVirtualCamera();
    let t = 0;
    for (; t < 300; t += 50) p.ingest(simulateFrame(cam, { dracula: { position: { x: 100, y: 100 }, heading: 0 } }, "S", t), t);
    for (; t < 1300; t += 50) p.ingest(simulateFrame(cam, { dracula: { position: { x: 130, y: 100 }, heading: 0 }, hiddenAnchors: ["BR"] }, "S", t), t);
    const s = p.snapshot(t);
    expect(s.calibration!.ok).toBe(false);
    expect(s.calibrationFresh).toBe(true);
    expect(dist(s.dracula.pose!.position, { x: 130, y: 100 })).toBeLessThan(1);
    expect(TRACKING.calibrationFreshMs).toBeGreaterThan(1000);
  });

  it("multiple object markers tracked separately", () => {
    const p = new TrackingPipeline();
    const cam = makeVirtualCamera({ rotationDeg: 30 });
    for (let t = 0; t < 400; t += 50) p.ingest(simulateFrame(cam, { dracula: { position: { x: 90, y: 90 }, heading: 0 }, shield: { position: { x: 230, y: 150 }, heading: deg(90) } }, "S", t), t);
    const s = p.snapshot(400);
    expect(dist(s.dracula.pose!.position, { x: 90, y: 90 })).toBeLessThan(0.5);
    expect(dist(s.shield.pose!.position, { x: 230, y: 150 })).toBeLessThan(0.5);
    expect(Math.abs(wrapAngle(s.shield.pose!.heading - deg(90)))).toBeLessThan(deg(1));
  });
});
