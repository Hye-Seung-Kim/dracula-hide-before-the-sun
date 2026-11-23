/**
 * Multi-pass marker scanner (phone side). Makes small / low-contrast object markers (Dracula, Shield) stable:
 *   1. full frame, downscaled to `procSize`  -> anchors + objects
 *   2. ROI pass: for each object seen recently, crop around it from the NATIVE camera frame (optionally
 *      upscaled), stretch the contrast, decode again. Gives sharper corners and recovers frames that pass 1 missed.
 *   3. If an object is missing, decode the whole frame at native resolution at most every `nativeIntervalMs`
 *      (more often before it was ever seen). Time-based so a slow phone keeps a usable frame rate.
 * Note: a global contrast stretch HURTS small codes (tested); stretching is only applied to small ROI crops.
 * All output coordinates are NATIVE camera pixels.
 */
import { DRACULA_PAYLOAD, SHIELD_PAYLOAD } from "../engine/boardLayout.ts";
import type { MarkerDetection, Vec2 } from "../engine/types.ts";
import type { ImageLike } from "./decoders.ts";

export interface FrameSource {
  width: number;
  height: number;
  /** Crop (sx, sy, sw, sh) of the native frame, resampled to dw x dh. */
  getImage(sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): ImageLike;
}

export type Decoder = (img: ImageLike, t: number) => Promise<MarkerDetection[]>;

export const OBJECT_PAYLOADS = [DRACULA_PAYLOAD, SHIELD_PAYLOAD];

/**
 * Lift shadows (gamma < 1). A printed marker on an emissive laptop screen in a dim room is UNDER-exposed: the camera
 * exposes for the bright screen, so the paper's "white" is dark grey. Gamma 0.4 opens up the dark range while the
 * bright board just saturates. Verified on a real phone photo (IMG_6860): raw and 2–98% stretch failed, gamma 0.4
 * decoded both Dracula and the Shield.
 */
const GAMMA_LUT = (() => {
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(255 * Math.pow(i / 255, 0.4));
  return t;
})();
export function liftShadows(img: ImageLike): ImageLike {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = GAMMA_LUT[(img.data[i * 4] * 77 + img.data[i * 4 + 1] * 150 + img.data[i * 4 + 2] * 29) >> 8];
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

/** Stretch only the DARK half of the histogram (2nd..50th percentile -> 0..255); bright screen pixels clip to white. */
export function stretchDarkRange(img: ImageLike): ImageLike {
  const n = img.width * img.height;
  const hist = new Uint32Array(256);
  const g = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = (img.data[i * 4] * 77 + img.data[i * 4 + 1] * 150 + img.data[i * 4 + 2] * 29) >> 8;
    g[i] = v;
    hist[v]++;
  }
  let lo = 0;
  let mid = 0;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
  for (let acc = 0; mid < 255 && (acc += hist[mid]) < n * 0.5; mid++);
  const span = Math.max(8, mid - lo);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = ((g[i] - lo) * 255) / span;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

/** Image variants tried on object-marker crops, cheapest/most likely first. */
const OBJECT_VARIANTS: ((img: ImageLike) => ImageLike)[] = [(i) => i, liftShadows, stretchDarkRange, stretchContrast];

/** Percentile-based contrast stretch to full 0..255 grey (helps QR shown on dim screens / under glare). */
export function stretchContrast(img: ImageLike): ImageLike {
  const n = img.width * img.height;
  const hist = new Uint32Array(256);
  const g = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = (img.data[i * 4] * 77 + img.data[i * 4 + 1] * 150 + img.data[i * 4 + 2] * 29) >> 8;
    g[i] = v;
    hist[v]++;
  }
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
  const span = Math.max(8, hi - lo);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = ((g[i] - lo) * 255) / span;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

const sideOf = (c: Vec2[]) => Math.max(...c.map((p, i) => Math.hypot(p.x - c[(i + 1) % 4].x, p.y - c[(i + 1) % 4].y)));
const mapBack = (m: MarkerDetection, ox: number, oy: number, s: number): MarkerDetection => ({
  ...m,
  center: { x: m.center.x / s + ox, y: m.center.y / s + oy },
  corners: m.corners.map((p) => ({ x: p.x / s + ox, y: p.y / s + oy })),
});

export interface ScanStats {
  fullMs: number;
  roiMs: number;
  nativeMs: number;
  roiHits: number;
  nativeHits: number;
  tileMs: number;
  tileHits: number;
  liftHits: number;
}

export class MarkerScanner {
  /** Decode at native resolution by default (measured ~60 ms/frame on the target iPhone at 1080x1920). */
  procSize = 1920;
  /** Native-resolution full scans are expensive on phones (~0.3–1 s): run them at most this often. */
  nativeIntervalMs = 2500;
  nativeIntervalUnseenMs = 1200;
  memoryMs = 2500;
  private frame = 0;
  private lastNativeAt = -Infinity;
  private last = new Map<string, { corners: Vec2[]; t: number }>();
  stats: ScanStats = { fullMs: 0, roiMs: 0, nativeMs: 0, roiHits: 0, nativeHits: 0, tileMs: 0, tileHits: 0, liftHits: 0 };
  private decode: Decoder;

  constructor(decode: Decoder) {
    this.decode = decode;
  }

  setDecoder(d: Decoder) {
    this.decode = d;
  }

  /** Board-area tile search (pass 4) cadence. */
  tileIntervalMs = 1500;
  tileIntervalUnseenMs = 500;
  private lastTileAt = -Infinity;

  /**
   * @param boardQuad image-space anchor centres from the last calibration (optional). When an object marker is
   *   missing, the board area is searched in overlapping native-resolution tiles (raw, then contrast-stretched):
   *   each tile holds a few codes against local background, which finds grey / small markers the full pass misses.
   */
  async scan(src: FrameSource, t: number, boardQuad?: Vec2[] | null): Promise<MarkerDetection[]> {
    this.frame++;
    const W = src.width;
    const H = src.height;
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

    // 1) Full frame at processing size
    let t0 = now();
    const k = Math.min(1, this.procSize / Math.max(W, H));
    const full = await this.decode(src.getImage(0, 0, W, H, Math.round(W * k), Math.round(H * k)), t);
    let dets = full.map((m) => mapBack(m, 0, 0, k));
    this.stats.fullMs = now() - t0;

    // 1b) Objects missing in the raw frame: decode once more with lifted shadows (dark paper on a bright screen).
    this.stats.liftHits = 0;
    const missing1 = OBJECT_PAYLOADS.filter((p) => !dets.some((d) => d.payload === p));
    if (missing1.length) {
      const lifted = await this.decode(liftShadows(src.getImage(0, 0, W, H, Math.round(W * k), Math.round(H * k))), t);
      for (const m of lifted)
        if (missing1.includes(m.payload) && !dets.some((d) => d.payload === m.payload)) {
          dets.push(mapBack(m, 0, 0, k));
          this.stats.liftHits++;
        }
    }

    // 2) ROI refinement for objects seen recently (or just now)
    t0 = now();
    this.stats.roiHits = 0;
    for (const payload of OBJECT_PAYLOADS) {
      const cur = dets.find((d) => d.payload === payload);
      const prev = this.last.get(payload);
      const ref = cur?.corners ?? (prev && t - prev.t < this.memoryMs ? prev.corners : null);
      if (!ref) continue;
      const side = Math.max(24, sideOf(ref));
      const c = { x: ref.reduce((a, p) => a + p.x, 0) / 4, y: ref.reduce((a, p) => a + p.y, 0) / 4 };
      // Try a normal crop, then a tight one (half-size 0.62 = code + its quiet zone; isolates a grey code from a bright map), each raw then
      // contrast-stretched. Stops at the first hit.
      let hit: MarkerDetection | null = null;
      for (const factor of [1.6, 0.62]) {
        const half = side * factor;
        const sx = Math.max(0, Math.floor(c.x - half));
        const sy = Math.max(0, Math.floor(c.y - half));
        const sw = Math.min(W - sx, Math.ceil(half * 2));
        const sh = Math.min(H - sy, Math.ceil(half * 2));
        if (sw < 16 || sh < 16) continue;
        // Aim for ~6 px per module (a 21-module code -> ~130 px), never more than 3x upscale.
        const sc = Math.min(3, Math.max(1, 130 / side));
        const img = src.getImage(sx, sy, sw, sh, Math.round(sw * sc), Math.round(sh * sc));
        for (const fx of OBJECT_VARIANTS) {
          const found = (await this.decode(fx(img), t)).find((d) => d.payload === payload);
          if (found) {
            hit = mapBack(found, sx, sy, sc);
            break;
          }
        }
        if (hit) break;
      }
      if (hit) {
        dets = dets.filter((d) => d.payload !== payload);
        dets.push(hit);
        this.stats.roiHits++;
      }
    }
    this.stats.roiMs = now() - t0;

    // 3) Periodic native-resolution pass when an object is still missing
    this.stats.nativeHits = 0;
    this.stats.nativeMs = 0;
    const missing = OBJECT_PAYLOADS.filter((p) => !dets.some((d) => d.payload === p));
    const neverSeen = missing.some((p) => !this.last.has(p));
    const gap = neverSeen ? this.nativeIntervalUnseenMs : this.nativeIntervalMs;
    if (missing.length && k < 1 && t - this.lastNativeAt >= gap) {
      this.lastNativeAt = t;
      t0 = now();
      const nat = await this.decode(src.getImage(0, 0, W, H, W, H), t);
      for (const m of nat) {
        if (missing.includes(m.payload)) {
          dets.push(m);
          this.stats.nativeHits++;
        }
      }
      this.stats.nativeMs = now() - t0;
    }

    // 4) Board-area tile search for objects still missing (acquisition: the ROI pass needs a first sighting).
    this.stats.tileHits = 0;
    this.stats.tileMs = 0;
    const stillMissing = OBJECT_PAYLOADS.filter((p) => !dets.some((d) => d.payload === p));
    const tileGap = stillMissing.some((p) => !this.last.has(p) || t - this.last.get(p)!.t > this.memoryMs) ? this.tileIntervalUnseenMs : this.tileIntervalMs;
    if (stillMissing.length && boardQuad && boardQuad.length === 4 && t - this.lastTileAt >= tileGap) {
      this.lastTileAt = t;
      t0 = now();
      const xs = boardQuad.map((p) => p.x);
      const ys = boardQuad.map((p) => p.y);
      const padX = (Math.max(...xs) - Math.min(...xs)) * 0.08;
      const padY = (Math.max(...ys) - Math.min(...ys)) * 0.08;
      const x0 = Math.max(0, Math.floor(Math.min(...xs) - padX));
      const y0 = Math.max(0, Math.floor(Math.min(...ys) - padY));
      const x1 = Math.min(W, Math.ceil(Math.max(...xs) + padX));
      const y1 = Math.min(H, Math.ceil(Math.max(...ys) + padY));
      const bw = x1 - x0;
      const bh = y1 - y0;
      const cols = Math.max(1, Math.ceil(bw / 560));
      const rows = Math.max(1, Math.ceil(bh / 560));
      const tw = Math.min(bw, Math.ceil((bw / cols) * 1.45)); // ~45% overlap so a marker is whole in some tile
      const th = Math.min(bh, Math.ceil((bh / rows) * 1.45));
      const found = new Set<string>();
      for (let r = 0; r < rows && found.size < stillMissing.length; r++)
        for (let c = 0; c < cols && found.size < stillMissing.length; c++) {
          const sx = Math.min(x1 - tw, x0 + Math.round((c * (bw - tw)) / Math.max(1, cols - 1)));
          const sy = Math.min(y1 - th, y0 + Math.round((r * (bh - th)) / Math.max(1, rows - 1)));
          const img = src.getImage(sx, sy, tw, th, tw, th);
          for (const fx of OBJECT_VARIANTS.slice(0, 3)) {
            const hits = (await this.decode(fx(img), t)).filter((d) => stillMissing.includes(d.payload) && !found.has(d.payload));
            for (const h of hits) {
              found.add(h.payload);
              dets.push(mapBack(h, sx, sy, 1));
              this.stats.tileHits++;
            }
            if (hits.length) break;
          }
        }
      this.stats.tileMs = now() - t0;
    }

    for (const d of dets) if (OBJECT_PAYLOADS.includes(d.payload)) this.last.set(d.payload, { corners: d.corners, t });
    return dets;
  }
}
