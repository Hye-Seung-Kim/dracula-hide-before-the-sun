// The multi-pass scanner must find small and low-contrast Dracula markers that a single downscaled pass misses.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { prepareZXingModule } from "zxing-wasm/reader";
import { decodeZXing } from "../src/camera/decoders.ts";
import { MarkerScanner } from "../src/camera/scanner.ts";
import { DRACULA_PAYLOAD, ZONE_PAYLOAD } from "../src/engine/boardLayout.ts";
import { calibrate, markerWorldPose } from "../src/engine/calibration.ts";
import { dist } from "../src/engine/geometry.ts";
import { makeVirtualCamera } from "../src/engine/simulator.ts";
import { renderScene, source, type RenderOpts } from "./helpers/renderScene.ts";

const require = createRequire(import.meta.url);
beforeAll(async () => {
  await prepareZXingModule({ overrides: { wasmBinary: readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm")).buffer as ArrayBuffer }, fireImmediately: true });
});

// Phone camera native 1920x1080, board fills ~75% of the frame, slight rotation + keystone.
const cam = makeVirtualCamera({ width: 1920, height: 1080, fill: 0.75, rotationDeg: 8, keystone: 0.08 });
const dracula = { position: { x: 150, y: 110 }, heading: 0.5 };

async function trial(opts: RenderOpts, frames = 8) {
  const img = renderScene(cam, { dracula, blur: true, noise: 14, ...opts });
  const src = source(img);
  const singleHits = (await decodeZXing(src.getImage(0, 0, 1920, 1080, 1280, 720))).some((m) => m.payload === DRACULA_PAYLOAD);
  const scanner = new MarkerScanner(decodeZXing);
  let hits = 0;
  let last = null;
  for (let f = 0; f < frames; f++) {
    const dets = await scanner.scan(src, f * 400);
    const d = dets.find((m) => m.payload === DRACULA_PAYLOAD);
    if (d) hits++;
    last = dets;
  }
  return { singleHits, hits, last: last! };
}

describe("multi-pass scanner", () => {
  it("small Dracula marker (~2 cm): single 1280px pass misses it, scanner locks on and stays locked", async () => {
    const r = await trial({ markerSize: 20 });
    // pass 3 finds it on the first frame, then the ROI pass keeps it every frame after
    expect(r.singleHits).toBe(false);
    expect(r.hits).toBeGreaterThanOrEqual(7);
    const cal = calibrate(r.last);
    expect(cal.ok).toBe(true);
    const pose = markerWorldPose(cal.H!, r.last.find((m) => m.payload === DRACULA_PAYLOAD)!);
    expect(dist(pose.center, dracula.position)).toBeLessThan(2);
    console.log(`small marker: single-pass found=${r.singleHits}, scanner hits ${r.hits}/8`);
  }, 60000);

  it("dim Dracula (QR shown on a phone screen at low brightness) is found and kept", async () => {
    const r = await trial({ markerSize: 28, objectLevels: [0.15, 0.7] });
    expect(r.hits).toBeGreaterThanOrEqual(5);
    console.log(`low contrast: single-pass found=${r.singleHits}, scanner hits ${r.hits}/8`);
  }, 60000);

  // Known limitation (not asserted): a grey-on-grey code on a bright map (e.g. a phone screen at low brightness lying on
  // the laptop, as in the first hardware photo) is not reliably decodable even with tight ROIs. Fix: paper marker
  // with a white border, or phone brightness at max.

  it("normal marker: found on every frame, anchors unaffected", async () => {
    const r = await trial({ markerSize: 30 });
    expect(r.hits).toBe(8);
    expect(r.last.filter((m) => m.payload === ZONE_PAYLOAD).length).toBe(4);
  }, 60000);
});

describe("under-exposed printed paper on a bright screen (real-photo levels)", () => {
  // Measured on real phone photos: paper black ~0.14, paper "white" ~0.3 of full scale, next to a bright board.
  it.each([
    [[0.12, 0.3]],
    [[0.14, 0.34]],
  ] as [[number, number]][])("finds a shield printed at levels %j once the board is calibrated", async (levels) => {
    const cam = makeVirtualCamera({ width: 1920, height: 1080, fill: 0.75, rotationDeg: 8, keystone: 0.08 });
    let raw = 0;
    let scanned = 0;
    for (const seed of [1, 2, 3]) {
      const img = renderScene(cam, { shield: { position: { x: 175, y: 140 }, heading: 2.5 }, blur: true, noise: 14, markerSize: 30, objectLevels: levels, seed });
      if ((await decodeZXing(img)).some((m) => m.payload.includes("shield"))) raw++;
      const sc = new MarkerScanner(decodeZXing);
      const first = await sc.scan(source(img), 0);
      const quad = calibrate(first).imageQuad ?? null;
      const second = await sc.scan(source(img), 600, quad);
      if ([...first, ...second].some((m) => m.payload.includes("shield"))) scanned++;
    }
    console.log(`levels ${levels}: raw single pass ${raw}/3, scanner ${scanned}/3`);
    expect(scanned).toBe(3);
  }, 60000);
});
