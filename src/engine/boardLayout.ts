import type { CornerName, Vec2 } from "./types.ts";

/**
 * The board's world coordinate system, in meters of the miniature city.
 * The whole board (including the four QR anchor plates) spans BOARD_W x BOARD_H.
 * On a 13" laptop, the board is ~25 cm wide, so 1 cm on screen is ~12.8 m in the city.
 */
export const BOARD_W = 320;
export const BOARD_H = 220;

export const ZONE_PAYLOAD = "zone:dracula-board";
export const DRACULA_PAYLOAD = "object:dracula:01";
export const SHIELD_PAYLOAD = "object:shield:01";

/**
 * Square white plate reserved for each anchor (QR + quiet zone). Nothing else is drawn here.
 * RUNTIME setting (board "Corner QR size"), in world meters. The laptop board and the phone must use the same value;
 * the board sends it to the phone in BoardStatus.
 * Measured (tests + rendered 1080x1920 phone frames, blur+noise, 75–90° phone rotation, board filling 50–70% of
 * the frame, decoded at native resolution): 32 m passed every view; 28 m failed at an angle / from further away.
 * Rule of thumb: the corner QR must be >= ~115 camera pixels wide (~4.5 px per module).
 */
export const ANCHOR_PLATE_OPTIONS = { S: 28, M: 32, L: 40 } as const;
export const DEFAULT_ANCHOR_PLATE = ANCHOR_PLATE_OPTIONS.M;
let plate: number = DEFAULT_ANCHOR_PLATE;
export function setAnchorPlate(meters: number) {
  if (Number.isFinite(meters) && meters >= 16 && meters <= 80) plate = meters;
}
export const anchorPlate = () => plate;

/** QR module count for ZONE_PAYLOAD at ECC "M" is 25 (version 2); 2-module quiet zone (the plate is white anyway). */
export const ANCHOR_QR_MODULES = 25;
export const ANCHOR_QUIET_MODULES = 2;
export const anchorModule = () => plate / (ANCHOR_QR_MODULES + 2 * ANCHOR_QUIET_MODULES);
/** Side length of the QR symbol itself (finder-pattern outer edge to outer edge). */
export const anchorQrSize = () => anchorModule() * ANCHOR_QR_MODULES;

export const CORNER_ORDER: CornerName[] = ["TL", "TR", "BR", "BL"];

/** World position of an anchor QR CENTER. Anchors sit in the extreme board corners. */
export function anchorCenter(c: CornerName): Vec2 {
  const h = plate / 2;
  return { TL: { x: h, y: h }, TR: { x: BOARD_W - h, y: h }, BR: { x: BOARD_W - h, y: BOARD_H - h }, BL: { x: h, y: BOARD_H - h } }[c];
}

/** World corners of each anchor's QR symbol (upright on screen): TL, TR, BR, BL of the symbol. */
export function anchorSymbolCorners(c: CornerName): Vec2[] {
  const ctr = anchorCenter(c);
  const s = anchorQrSize() / 2;
  return [
    { x: ctr.x - s, y: ctr.y - s },
    { x: ctr.x + s, y: ctr.y - s },
    { x: ctr.x + s, y: ctr.y + s },
    { x: ctr.x - s, y: ctr.y + s },
  ];
}

export function anchorPlateRect(c: CornerName) {
  const ctr = anchorCenter(c);
  return { x: ctr.x - plate / 2, y: ctr.y - plate / 2, w: plate, h: plate };
}

/** True if p is inside (or within margin of) any anchor plate: the QR safe area. */
export function inAnchorSafeArea(p: Vec2, margin = 4): boolean {
  return CORNER_ORDER.some((c) => {
    const r = anchorPlateRect(c);
    return p.x > r.x - margin && p.x < r.x + r.w + margin && p.y > r.y - margin && p.y < r.y + r.h + margin;
  });
}

export function classifyPayload(payload: string): "anchor" | "dracula" | "shield" | "unknown" {
  if (payload === ZONE_PAYLOAD) return "anchor";
  if (payload === DRACULA_PAYLOAD) return "dracula";
  if (payload === SHIELD_PAYLOAD) return "shield";
  return "unknown";
}
