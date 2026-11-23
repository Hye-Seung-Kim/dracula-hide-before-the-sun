// Rasterises the board's QR anchors + object markers as an overhead phone camera would see them.
// Used to test the REAL decoders (zxing-wasm, jsQR multipass) on identical-payload multi-QR frames.
import QRCode from "qrcode";
import { ANCHOR_QUIET_MODULES, CORNER_ORDER, DRACULA_PAYLOAD, SHIELD_PAYLOAD, ZONE_PAYLOAD, anchorSymbolCorners } from "../../src/engine/boardLayout.ts";
import { applyHomography, computeHomography, invert3 } from "../../src/engine/geometry.ts";
import { markerWorldCorners, type VirtualCamera } from "../../src/engine/simulator.ts";
import type { Pose, Vec2 } from "../../src/engine/types.ts";
import type { ImageLike } from "../../src/camera/decoders.ts";
import type { FrameSource } from "../../src/camera/scanner.ts";

interface Symbol { modules: { size: number; get(r: number, c: number): number }; toLocal: number[]; quiet: number; dark: number; light: number }

function symbolFor(payload: string, ecc: "L" | "M", worldCorners: Vec2[], quiet: number, dark = 0.05, light = 1): Symbol {
  const qr = QRCode.create(payload, { errorCorrectionLevel: ecc });
  const n = qr.modules.size;
  // world -> module-grid coordinates (0..n)
  const H = computeHomography(worldCorners, [{ x: 0, y: 0 }, { x: n, y: 0 }, { x: n, y: n }, { x: 0, y: n }])!;
  return { modules: { size: n, get: (r, c) => qr.modules.get(r, c) }, toLocal: H, quiet, dark, light };
}

export interface RenderOpts {
  dracula?: Pose; shield?: Pose; markerSize?: number; blur?: boolean; noise?: number; hideAnchor?: string;
  /** Object markers shown with poor contrast (e.g. on a dim phone screen): [dark, light] grey levels 0..1 */
  objectLevels?: [number, number];
  /** Seed for the sensor noise, so every test run renders the identical frame. */
  seed?: number;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderScene(cam: VirtualCamera, o: RenderOpts) {
  const syms: Symbol[] = [];
  for (const c of CORNER_ORDER) if (o.hideAnchor !== c) syms.push(symbolFor(ZONE_PAYLOAD, "M", anchorSymbolCorners(c), ANCHOR_QUIET_MODULES));
  const ms = o.markerSize ?? 26;
  const [dk, lt] = o.objectLevels ?? [0.05, 1];
  if (o.dracula) syms.push(symbolFor(DRACULA_PAYLOAD, "L", markerWorldCorners(o.dracula, ms), 2, dk, lt));
  if (o.shield) syms.push(symbolFor(SHIELD_PAYLOAD, "L", markerWorldCorners(o.shield, ms), 2, dk, lt));
  const inv = invert3(cam.H)!; // image -> world
  const { width: W, height: Hh } = cam;
  const gray = new Float32Array(W * Hh);
  const SS = 2; // supersampling
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const w = applyHomography(inv, { x: x + (sx + 0.5) / SS, y: y + (sy + 0.5) / SS });
      let val = 0.78; // map background (light-ish screen)
      for (const s of syms) {
        const l = applyHomography(s.toLocal, w);
        const n = s.modules.size;
        const q = s.quiet;
        if (l.x >= -q && l.y >= -q && l.x < n + q && l.y < n + q) {
          val = s.light; // white quiet zone / plate
          if (l.x >= 0 && l.y >= 0 && l.x < n && l.y < n && s.modules.get(Math.floor(l.y), Math.floor(l.x))) val = s.dark;
        }
      }
      acc += val;
    }
    gray[y * W + x] = acc / (SS * SS);
  }
  let out = gray;
  if (o.blur) {
    out = new Float32Array(W * Hh);
    for (let y = 1; y < Hh - 1; y++) for (let x = 1; x < W - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += gray[(y + dy) * W + x + dx];
      out[y * W + x] = s / 9;
    }
  }
  const rand = rng(o.seed ?? 7);
  const rgba = new Uint8ClampedArray(W * Hh * 4);
  for (let i = 0; i < W * Hh; i++) {
    const n = o.noise ? (rand() - 0.5) * o.noise : 0;
    const g = Math.max(0, Math.min(255, Math.round(out[i] * 255 + n)));
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, width: W, height: Hh, colorSpace: "srgb" as const };
}

/** Nearest/box resampling crop of a native image, like drawImage would do on the phone. */
export function source(img: ImageLike): FrameSource {
  const at = (x: number, y: number) => img.data[(Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4];
  return {
    width: img.width,
    height: img.height,
    // Box filter when downscaling, bilinear when upscaling (like canvas drawImage with smoothing on the phone).
    getImage(sx, sy, sw, sh, dw, dh) {
      const out = new Uint8ClampedArray(dw * dh * 4);
      const fx = sw / dw;
      const fy = sh / dh;
      for (let y = 0; y < dh; y++)
        for (let x = 0; x < dw; x++) {
          let v: number;
          if (fx >= 1 && fy >= 1) {
            const x0 = sx + x * fx, y0 = sy + y * fy;
            const nx = Math.max(1, Math.round(fx)), ny = Math.max(1, Math.round(fy));
            let acc = 0;
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) acc += at(Math.floor(x0 + i), Math.floor(y0 + j));
            v = acc / (nx * ny);
          } else {
            const u = sx + (x + 0.5) * fx - 0.5, w = sy + (y + 0.5) * fy - 0.5;
            const x0 = Math.floor(u), y0 = Math.floor(w), ax = u - x0, ay = w - y0;
            v = at(x0, y0) * (1 - ax) * (1 - ay) + at(x0 + 1, y0) * ax * (1 - ay) + at(x0, y0 + 1) * (1 - ax) * ay + at(x0 + 1, y0 + 1) * ax * ay;
          }
          const o = (y * dw + x) * 4;
          out[o] = out[o + 1] = out[o + 2] = v;
          out[o + 3] = 255;
        }
      return { data: out, width: dw, height: dh };
    },
  };
}
