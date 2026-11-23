/**
 * Multi-QR decoders. Every decoder returns ALL instances in the frame, including several codes with the
 * same payload (the four board anchors all read "zone:dracula-board"). Corners are returned in the
 * symbol's own orientation [TL, TR, BR, BL], which is what makes marker rotation measurable.
 */
import jsQR from "jsqr";
import { readBarcodes } from "zxing-wasm/reader";
import { add, quadCenter, scale, sub, vecToBearing } from "../engine/geometry.ts";
import type { DecoderName, MarkerDetection, Vec2 } from "../engine/types.ts";

export interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function finish(payload: string, corners: Vec2[], t: number): MarkerDetection {
  const [tl, tr, br, bl] = corners;
  const up = scale(add(sub(tl, bl), sub(tr, br)), 0.5);
  return { payload, corners, center: quadCenter(corners), rotationRadians: vecToBearing(up), timestamp: t };
}

/** zxing-cpp (WebAssembly). Natively multi-symbol; verified in tests to keep identical payloads separate. */
export async function decodeZXing(img: ImageLike, t = Date.now()): Promise<MarkerDetection[]> {
  const results = await readBarcodes(img as unknown as ImageData, {
    formats: ["QRCode"],
    maxNumberOfSymbols: 16,
    tryHarder: true,
    tryRotate: true,
    tryInvert: false,
    tryDownscale: true,
  });
  return results
    .filter((r) => r.isValid && r.text)
    .map((r) => finish(r.text, [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft], t));
}

/** Fill a (slightly enlarged) quad with white so the next jsQR pass finds a different code. */
function maskQuad(img: ImageLike, corners: Vec2[], grow = 1.25) {
  const c = quadCenter(corners);
  const q = corners.map((p) => add(c, scale(sub(p, c), grow)));
  const minX = Math.max(0, Math.floor(Math.min(...q.map((p) => p.x))));
  const maxX = Math.min(img.width - 1, Math.ceil(Math.max(...q.map((p) => p.x))));
  const minY = Math.max(0, Math.floor(Math.min(...q.map((p) => p.y))));
  const maxY = Math.min(img.height - 1, Math.ceil(Math.max(...q.map((p) => p.y))));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const a = q[i];
        const b = q[j];
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      if (!inside) continue;
      const o = (y * img.width + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
    }
  }
}

function jsqrOnce(img: ImageLike, ox: number, oy: number, t: number): MarkerDetection | null {
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
  if (!r || !r.data) return null;
  const L = r.location;
  const corners = [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner].map((p) => ({ x: p.x + ox, y: p.y + oy }));
  return finish(r.data, corners, t);
}

function crop(src: ImageLike, x0: number, y0: number, w: number, h: number): ImageLike {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) data.set(src.data.subarray(((y0 + y) * src.width + x0) * 4, ((y0 + y) * src.width + x0 + w) * 4), y * w * 4);
  return { data, width: w, height: h };
}

/**
 * jsQR returns one code per call and gets confused when several similar codes share a frame (it mixes
 * finder patterns). Fallback strategy: scan overlapping tiles so each tile mostly holds one code, mask
 * each found code and rescan the tile, then merge by POSITION (never by payload, so the four identical
 * anchors survive). Mask-and-rescan idea reused from ../qrcode-tracking.
 */
export function decodeJsQRMultipass(src: ImageLike, t = Date.now(), grid = 5): MarkerDetection[] {
  const found: MarkerDetection[] = [];
  const add1 = (m: MarkerDetection) => {
    const size = Math.hypot(m.corners[1].x - m.corners[0].x, m.corners[1].y - m.corners[0].y);
    if (!found.some((f) => Math.hypot(f.center.x - m.center.x, f.center.y - m.center.y) < size * 0.5)) found.push(m);
  };
  const scan = (img: ImageLike, ox: number, oy: number, max: number) => {
    const work = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
    for (let i = 0; i < max; i++) {
      const m = jsqrOnce(work, ox, oy, t);
      if (!m) break;
      add1(m);
      maskQuad(work, m.corners.map((p) => ({ x: p.x - ox, y: p.y - oy })));
    }
  };
  scan(src, 0, 0, 3);
  const tw = Math.floor((src.width * 2) / (grid + 1));
  const th = Math.floor((src.height * 2) / (grid + 1));
  for (let gy = 0; gy < grid; gy++)
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.min(src.width - tw, Math.floor((gx * tw) / 2));
      const y0 = Math.min(src.height - th, Math.floor((gy * th) / 2));
      scan(crop(src, x0, y0, tw, th), x0, y0, 3);
    }
  return found;
}

interface NativeDetected { rawValue: string; cornerPoints: Vec2[] }
interface NativeDetector { detect(src: CanvasImageSource | ImageBitmap | ImageData): Promise<NativeDetected[]> }

export async function nativeDetectorAvailable(): Promise<boolean> {
  const BD = (globalThis as unknown as { BarcodeDetector?: { getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (!BD) return false;
  try {
    return (await BD.getSupportedFormats()).includes("qr_code");
  } catch {
    return false;
  }
}

let native: NativeDetector | null = null;
/**
 * Native BarcodeDetector (Chrome on Android). Returns multiple codes, but the spec does not guarantee
 * that cornerPoints start at the SYMBOL's top-left, so rotation from this decoder is flagged unverified.
 */
export async function decodeNative(src: ImageData, t = Date.now()): Promise<MarkerDetection[]> {
  if (!native) {
    const BD = (globalThis as unknown as { BarcodeDetector: new (o: { formats: string[] }) => NativeDetector }).BarcodeDetector;
    native = new BD({ formats: ["qr_code"] });
  }
  const res = await native.detect(src);
  return res.filter((r) => r.cornerPoints?.length === 4).map((r) => finish(r.rawValue, r.cornerPoints, t));
}

export const DECODER_LABEL: Record<DecoderName, string> = {
  "zxing-wasm": "ZXing WASM (multi-QR, rotation verified)",
  "barcode-detector": "Native BarcodeDetector (rotation unverified)",
  "jsqr-multipass": "jsQR mask-and-rescan (fallback)",
  simulator: "SIMULATOR",
};
