/**
 * Virtual overhead camera. Used by (a) the board's mouse simulator and (b) the unit tests.
 * It produces the SAME TrackingFrame shape that the phone sends (camera-pixel corners), so the
 * simulator exercises the real calibration -> homography -> tracking -> game pipeline.
 * Frames produced here are always tagged decoder: "simulator" and labelled on screen.
 */
import { BOARD_H, BOARD_W, CORNER_ORDER, DRACULA_PAYLOAD, SHIELD_PAYLOAD, ZONE_PAYLOAD, anchorSymbolCorners } from "./boardLayout.ts";
import { add, applyHomography, bearingToVec, computeHomography, quadCenter, scale, vecToBearing, sub } from "./geometry.ts";
import type { Homography, MarkerDetection, Pose, TrackingFrame, Vec2 } from "./types.ts";

export interface VirtualCamera {
  width: number;
  height: number;
  /** world -> image */
  H: Homography;
}

/**
 * Build a camera looking down at the board. `rotationDeg` rotates the phone (board appears rotated
 * the other way), `keystone` (0..0.3) adds perspective by shrinking the far edge.
 */
export function makeVirtualCamera(opts: { width?: number; height?: number; rotationDeg?: number; keystone?: number; fill?: number; offset?: Vec2 } = {}): VirtualCamera {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const fill = opts.fill ?? 0.8;
  const k = opts.keystone ?? 0;
  const rot = ((opts.rotationDeg ?? 0) * Math.PI) / 180;
  // Fit the ROTATED board inside the frame.
  const cr = Math.abs(Math.cos(rot));
  const sr = Math.abs(Math.sin(rot));
  const fitW = (BOARD_W * cr + BOARD_H * sr);
  const fitH = (BOARD_W * sr + BOARD_H * cr);
  const sc = Math.min((width * fill) / fitW, (height * fill) / fitH);
  const bw = BOARD_W * sc;
  const bh = BOARD_H * sc;
  // Board corners in image before rotation, with keystone on the top edge.
  const local: Vec2[] = [
    { x: -bw / 2 * (1 - k), y: -bh / 2 },
    { x: bw / 2 * (1 - k), y: -bh / 2 },
    { x: bw / 2, y: bh / 2 },
    { x: -bw / 2, y: bh / 2 },
  ];
  const c = { x: width / 2 + (opts.offset?.x ?? 0), y: height / 2 + (opts.offset?.y ?? 0) };
  const img = local.map((p) => ({
    x: c.x + p.x * Math.cos(rot) - p.y * Math.sin(rot),
    y: c.y + p.x * Math.sin(rot) + p.y * Math.cos(rot),
  }));
  const world: Vec2[] = [{ x: 0, y: 0 }, { x: BOARD_W, y: 0 }, { x: BOARD_W, y: BOARD_H }, { x: 0, y: BOARD_H }];
  const H = computeHomography(world, img);
  if (!H) throw new Error("virtual camera homography failed");
  return { width, height, H };
}

/** World corners (symbol TL, TR, BR, BL) of a square marker of side `size` at `pose`. */
export function markerWorldCorners(pose: Pose, size: number): Vec2[] {
  const up = bearingToVec(pose.heading);
  const right = { x: -up.y, y: up.x };
  const s = size / 2;
  const c = pose.position;
  return [
    add(c, add(scale(right, -s), scale(up, s))),
    add(c, add(scale(right, s), scale(up, s))),
    add(c, add(scale(right, s), scale(up, -s))),
    add(c, add(scale(right, -s), scale(up, -s))),
  ];
}

function detectionFromWorld(cam: VirtualCamera, payload: string, worldCorners: Vec2[], t: number, jitterPx = 0): MarkerDetection {
  const corners = worldCorners.map((p) => {
    const q = applyHomography(cam.H, p);
    return jitterPx ? { x: q.x + (Math.random() - 0.5) * jitterPx, y: q.y + (Math.random() - 0.5) * jitterPx } : q;
  });
  const [tl, tr, br, bl] = corners;
  const up = scale(add(sub(tl, bl), sub(tr, br)), 0.5);
  return { payload, corners, center: quadCenter(corners), rotationRadians: vecToBearing(up), timestamp: t };
}

export interface SimObjects {
  dracula?: Pose | null;
  shield?: Pose | null;
  /** Anchors to hide (simulates a hand covering a corner). */
  hiddenAnchors?: string[];
  markerSize?: number;
  jitterPx?: number;
}

export function simulateFrame(cam: VirtualCamera, objs: SimObjects, sessionId = "SIM", t = Date.now()): TrackingFrame {
  const markers: MarkerDetection[] = [];
  for (const c of CORNER_ORDER) {
    if (objs.hiddenAnchors?.includes(c)) continue;
    markers.push(detectionFromWorld(cam, ZONE_PAYLOAD, anchorSymbolCorners(c), t, objs.jitterPx));
  }
  const size = objs.markerSize ?? 26;
  if (objs.dracula) markers.push(detectionFromWorld(cam, DRACULA_PAYLOAD, markerWorldCorners(objs.dracula, size), t, objs.jitterPx));
  if (objs.shield) markers.push(detectionFromWorld(cam, SHIELD_PAYLOAD, markerWorldCorners(objs.shield, size), t, objs.jitterPx));
  // Shuffle so tests never rely on detector ordering.
  markers.sort(() => Math.random() - 0.5);
  return { sessionId, frameWidth: cam.width, frameHeight: cam.height, markers, timestamp: t, decoder: "simulator" };
}
