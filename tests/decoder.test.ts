// End-to-end vision test: rendered camera pixels -> real decoders -> calibration -> world position.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { prepareZXingModule } from "zxing-wasm/reader";
import { decodeJsQRMultipass, decodeZXing } from "../src/camera/decoders.ts";
import { DRACULA_PAYLOAD, SHIELD_PAYLOAD, ZONE_PAYLOAD } from "../src/engine/boardLayout.ts";
import { calibrate, markerWorldPose } from "../src/engine/calibration.ts";
import { dist, wrapAngle } from "../src/engine/geometry.ts";
import { makeVirtualCamera } from "../src/engine/simulator.ts";
import { renderScene, source } from "./helpers/renderScene.ts";
import { MarkerScanner } from "../src/camera/scanner.ts";

const require = createRequire(import.meta.url);

beforeAll(async () => {
  const wasmPath = require.resolve("zxing-wasm/reader/zxing_reader.wasm");
  await prepareZXingModule({ overrides: { wasmBinary: readFileSync(wasmPath).buffer as ArrayBuffer }, fireImmediately: true });
});

const deg = (d: number) => (d * Math.PI) / 180;

// Camera frames at the resolution measured on the real phone (live session debug: 1080x1920 portrait).
const scenes = [
  { name: "upright", cam: { rotationDeg: 0, width: 1920, height: 1080 } },
  { name: "phone rotated 90deg + perspective", cam: { rotationDeg: 90, keystone: 0.12, width: 1080, height: 1920 } },
  { name: "rotated 17deg + keystone", cam: { rotationDeg: -17, keystone: 0.15, width: 1920, height: 1080 } },
  { name: "upside down 180deg", cam: { rotationDeg: 180, keystone: 0.08, width: 1920, height: 1080 } },
];

describe("zxing-wasm via the phone's multi-pass scanner, on rendered camera frames", () => {
  // Same path as the phone: MarkerScanner (full pass + ROI refinement), 3 consecutive frames.
  const decode = async (img: ReturnType<typeof renderScene>) => {
    const sc = new MarkerScanner(decodeZXing);
    let out: Awaited<ReturnType<typeof decodeZXing>> = [];
    for (let f = 0; f < 3; f++) out = await sc.scan(source(img), f * 100);
    return out;
  };

  it.each(scenes)("finds 4 identical anchors separately + Dracula + Shield ($name)", async ({ cam }) => {
    const camera = makeVirtualCamera({ fill: 0.92, ...cam });
    const dracula = { position: { x: 120, y: 90 }, heading: deg(35) };
    const shield = { position: { x: 220, y: 140 }, heading: deg(-120) };
    const img = renderScene(camera, { dracula, shield, blur: true, noise: 18, markerSize: 32 });
    const markers = await decode(img);

    const anchors = markers.filter((m) => m.payload === ZONE_PAYLOAD);
    expect(anchors.length).toBe(4); // identical payloads are NOT collapsed
    expect(markers.some((m) => m.payload === DRACULA_PAYLOAD)).toBe(true);
    expect(markers.some((m) => m.payload === SHIELD_PAYLOAD)).toBe(true);

    const cal = calibrate(markers);
    expect(cal.ok, cal.reason).toBe(true);
    expect(cal.reprojErrorMeters!).toBeLessThan(3);

    const d = markerWorldPose(cal.H!, markers.find((m) => m.payload === DRACULA_PAYLOAD)!);
    expect(dist(d.center, dracula.position)).toBeLessThan(2.5);
    expect(Math.abs(wrapAngle(d.heading - dracula.heading))).toBeLessThan(deg(6));

    const s = markerWorldPose(cal.H!, markers.find((m) => m.payload === SHIELD_PAYLOAD)!);
    expect(dist(s.center, shield.position)).toBeLessThan(2.5);
    expect(Math.abs(wrapAngle(s.heading - shield.heading))).toBeLessThan(deg(6));
  }, 30000);

  it("reports a missing corner instead of guessing", async () => {
    const camera = makeVirtualCamera({ rotationDeg: 10 });
    const img = renderScene(camera, { dracula: { position: { x: 160, y: 110 }, heading: 0 }, hideAnchor: "BR" });
    const markers = await decode(img);
    expect(markers.filter((m) => m.payload === ZONE_PAYLOAD).length).toBe(3);
    const cal = calibrate(markers);
    expect(cal.ok).toBe(false);
    expect(cal.reason).toMatch(/Need 4/);
  }, 30000);
});

describe("jsQR tiled multipass (fallback decoder)", () => {
  it.each(scenes)("finds the 4 identical anchors separately and calibrates ($name)", ({ cam }) => {
    const camera = makeVirtualCamera({ fill: 0.92, ...cam });
    const img = renderScene(camera, { dracula: { position: { x: 120, y: 90 }, heading: 0 }, blur: true, noise: 18 });
    const markers = decodeJsQRMultipass(img);
    expect(markers.filter((m) => m.payload === ZONE_PAYLOAD).length).toBe(4);
    const cal = calibrate(markers);
    expect(cal.ok, cal.reason).toBe(true);
    // Known limitation: small object markers are found less reliably than with zxing-wasm (not asserted).
  }, 30000);
});

describe("Dracula marker positions across the board (zxing-wasm)", () => {
  it.each([
    ["left", { x: 75, y: 110 }],
    ["center", { x: 160, y: 110 }],
    ["right", { x: 250, y: 110 }],
  ])("%s", async (_n, position) => {
    const camera = makeVirtualCamera({ rotationDeg: 4, keystone: 0.1, fill: 0.9 });
    const img = renderScene(camera, { dracula: { position, heading: deg(200) } });
    const markers = await decodeZXing(img);
    const cal = calibrate(markers);
    expect(cal.ok).toBe(true);
    const d = markerWorldPose(cal.H!, markers.find((m) => m.payload === DRACULA_PAYLOAD)!);
    expect(dist(d.center, position)).toBeLessThan(2.5);
  }, 30000);
});

describe("corner QR size (default M = 32 m plate)", () => {
  it.each([
    ["portrait phone at 75°, board fills 70%", { width: 1080, height: 1920, rotationDeg: 75, keystone: 0.18, fill: 0.7 }],
    ["portrait phone, board only fills 50% (camera higher)", { width: 1080, height: 1920, rotationDeg: 90, keystone: 0.1, fill: 0.5 }],
  ])("calibrates: %s", async (_n, view) => {
    const camera = makeVirtualCamera(view);
    for (const seed of [1, 2, 3]) {
      const img = renderScene(camera, { dracula: { position: { x: 150, y: 110 }, heading: 0.4 }, blur: true, noise: 18, markerSize: 30, seed });
      const sc = new MarkerScanner(decodeZXing); // default: native resolution
      const m = await sc.scan(source(img), 0);
      const cal = calibrate(m);
      expect(cal.ok, cal.reason).toBe(true);
    }
  }, 60000);
});
