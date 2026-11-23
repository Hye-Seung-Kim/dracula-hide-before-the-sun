/**
 * Canvas renderer for the laptop board. Draws in WORLD units (meters) through one transform, so the
 * digital map, the QR anchors and the tracked physical objects always share one coordinate system.
 */
import QRCode from "qrcode";
import { drawMeadow, drawTownTiles, drawTownTrees, drawTownStreet, drawTownBuilding, drawTownFountain, drawDraculaSprite, drawTownSun } from "./pixelArt.ts";
import {
  ANCHOR_QR_MODULES, ANCHOR_QUIET_MODULES, BOARD_H, BOARD_W, CORNER_ORDER, ZONE_PAYLOAD, anchorPlateRect,
} from "../engine/boardLayout.ts";
import { add, applyHomography, bbox, bearingToVec, centroid, convexHull, scale } from "../engine/geometry.ts";
import type { Level } from "../engine/levels.ts";
import { RULES, type Verdict } from "../engine/rules.ts";
import { prismShadow, shieldWall, type ShadowPoly } from "../engine/shadows.ts";
import type { SunInfo } from "../engine/solar.ts";
import type { RayHit } from "../engine/spatial.ts";
import type { PipelineSnapshot } from "../engine/tracking.ts";
import type { Building, Pose, Vec2 } from "../engine/types.ts";
import type { Phase, Submission } from "../engine/gameState.ts";

export interface View {
  scale: number;
  ox: number;
  oy: number;
  dpr: number;
}

export const toScreen = (v: View, p: Vec2) => ({ x: v.ox + p.x * v.scale, y: v.oy + p.y * v.scale });
export const toWorld = (v: View, x: number, y: number): Vec2 => ({ x: (x - v.ox) / v.scale, y: (y - v.oy) / v.scale });

export interface WorkshopLayer {
  half: "LEFT" | "RIGHT" | null;
  customPoly: Vec2[];
  customClosed: boolean;
  customInside: boolean;
  boardZoneCount: number;
  draculaInBoardZone: boolean;
  sideOf: { building: Building; side: string } | null;
  between: { a: Building; b: Building; yes: boolean } | null;
  adjacent: Building[];
  trail: Vec2[];
  shieldAim: { aimed: boolean; end: Vec2 } | null;
  previewShadows: boolean;
  shadowZone: "SAFE" | "EXPOSED" | null;
}

export interface RenderInput {
  now: number;
  level: Level;
  phase: Phase;
  tracking: PipelineSnapshot;
  sun: SunInfo;
  submission: Submission | null;
  verdict: Verdict | null;
  /** 0..1 during REVEAL, 1 after; null when shadows are hidden. */
  reveal: number | null;
  gaze: RayHit | null;
  workshop: WorkshopLayer | null;
  debug: boolean;
  simSelected: "dracula" | "shield" | null;
  /** live shield shadow preview (workshop only) */
  liveShadows: ShadowPoly[] | null;
}

const COLORS = {
  ground: "#8bbf72",
  groundEdge: "#6f9c5b",
  street: "#5d527a",
  streetLine: "rgba(255,236,190,0.55)",
  park: "#8bbf72",
  plaza: "#bacdc4",
  courtyard: "#dfc49a",
  roof: { LOW: "#f2a66b", MEDIUM: "#cf7a5a", HIGH: "#7d6bb6" },
  wall: { LOW: "#d98a52", MEDIUM: "#a95c43", HIGH: "#5a4a92" },
  shadow: "rgba(55, 60, 87, 0.62)",
  shadowEdge: "rgba(45, 49, 73, 0.9)",
  dracula: "#a45570",
  sun: "#ffb547",
};

// ------------------------------------------------------------------ QR anchor bitmap (crisp, cached)

let anchorBitmap: HTMLCanvasElement | null = null;
function getAnchorBitmap(): HTMLCanvasElement {
  if (anchorBitmap) return anchorBitmap;
  const qr = QRCode.create(ZONE_PAYLOAD, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  if (n !== ANCHOR_QR_MODULES) console.warn(`Anchor QR has ${n} modules, layout assumes ${ANCHOR_QR_MODULES}`);
  const total = n + 2 * ANCHOR_QUIET_MODULES;
  const c = document.createElement("canvas");
  c.width = c.height = total;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.modules.get(r, col)) ctx.fillRect(col + ANCHOR_QUIET_MODULES, r + ANCHOR_QUIET_MODULES, 1, 1);
  anchorBitmap = c;
  return c;
}

// ------------------------------------------------------------------ helpers

function path(ctx: CanvasRenderingContext2D, poly: Vec2[]) {
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, opts: { size?: number; color?: string; bg?: string; align?: CanvasTextAlign; weight?: number } = {}) {
  const size = opts.size ?? 4.2;
  ctx.font = `${opts.weight ?? 700} ${size}px "Pixelify Sans", ui-monospace, monospace`;
  ctx.textAlign = opts.align ?? "center";
  ctx.textBaseline = "middle";
  if (opts.bg) {
    const w = ctx.measureText(text).width + size * 0.9;
    const h = size * 1.55;
    const x0 = opts.align === "left" ? x - size * 0.45 : opts.align === "right" ? x - w + size * 0.45 : x - w / 2;
    ctx.fillStyle = opts.bg;
    ctx.beginPath();
    ctx.rect(x0, y - h / 2, w, h);
    ctx.fill();
  }
  ctx.fillStyle = opts.color ?? "#2a1d4a";
  ctx.fillText(text, x, y + size * 0.05);
}

/** Sizes of the oblique extrusion used to make heights readable. Fixed direction, independent of the sun. */
const extrude = (b: Building) => ({ LOW: 2.2, MEDIUM: 4.2, HIGH: 7 })[b.displayHeightCategory];

// ------------------------------------------------------------------ main draw

export function render(ctx: CanvasRenderingContext2D, view: View, inp: RenderInput) {
  const { level } = inp;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, view.dpr * view.ox, view.dpr * view.oy);

  // Ground
  ctx.fillStyle = COLORS.ground;
  ctx.beginPath();
  ctx.roundRect(0, 0, BOARD_W, BOARD_H, 4);
  ctx.fill();
  drawGroundTexture(ctx);

  for (const a of level.areas) {
    ctx.fillStyle = a.kind === "park" ? COLORS.park : a.kind === "plaza" ? COLORS.plaza : COLORS.courtyard;
    path(ctx, a.poly);
    ctx.fill();
    if (a.kind === "plaza") drawPlazaTiles(ctx, a.poly);
    if (a.kind === "park") drawTrees(ctx, a.poly);
  }
  for (const s of level.streets) drawStreet(ctx, s.path, s.width, s.name);

  // Level 3 destination
  if (level.destination) {
    const d = level.destination;
    ctx.save();
    ctx.setLineDash([3, 2.2]);
    ctx.lineDashOffset = -inp.now / 120;
    ctx.strokeStyle = "#c98a00";
    ctx.lineWidth = 1.4;
    ctx.fillStyle = "rgba(255, 196, 64, 0.22)";
    ctx.beginPath();
    ctx.arc(d.center.x, d.center.y, d.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawFountain(ctx, d.center);
    label(ctx, "DRACULA MUST STAND HERE", d.center.x, d.center.y + d.radius + 6, { size: 3.6, color: "#7a4d00", bg: "rgba(255,240,200,0.9)" });
  }

  // Workshop zones (under buildings)
  if (inp.workshop) drawWorkshopZones(ctx, inp.workshop, inp.now);

  // Shadows (ONLY after reveal, or in workshop preview)
  const shadowPolys = inp.reveal !== null && inp.verdict ? animatedShadows(level, inp.sun, inp.verdict, inp.reveal) : inp.liveShadows;
  if (shadowPolys) drawShadows(ctx, shadowPolys);

  // Buildings
  const highlighted = new Set<string>();
  if (inp.gaze?.building) highlighted.add(inp.gaze.building.id);
  inp.workshop?.adjacent.forEach((b) => highlighted.add(b.id));
  const sorted = [...level.buildings].sort((a, b) => bbox(a.footprint).maxY - bbox(b.footprint).maxY);
  for (const b of sorted) drawBuilding(ctx, b, highlighted.has(b.id), inp.now);

  // Sun (only after reveal)
  if (inp.reveal !== null) drawSun(ctx, inp.sun, inp.reveal, inp.now);

  // Directional rays
  if (inp.gaze) drawGaze(ctx, inp.gaze, inp.now);
  if (inp.workshop?.shieldAim && inp.tracking.shield.pose) drawShieldAim(ctx, inp.tracking.shield.pose, inp.workshop.shieldAim, inp.now);

  // Physical objects
  if (level.usesShield || inp.workshop) drawShield(ctx, inp, level);
  drawDracula(ctx, inp);

  // Debug shadows outline, markers
  if (inp.debug) drawDebug(ctx, inp);

  // QR anchors last so nothing ever covers them.
  drawAnchors(ctx);
}

function drawGroundTexture(ctx: CanvasRenderingContext2D) {
  drawMeadow(ctx, BOARD_W, BOARD_H);
}

function drawPlazaTiles(ctx: CanvasRenderingContext2D, poly: Vec2[]) {
  drawTownTiles(ctx, poly);
}

function drawTrees(ctx: CanvasRenderingContext2D, poly: Vec2[]) {
  drawTownTrees(ctx, poly);
}

function drawFountain(ctx: CanvasRenderingContext2D, c: Vec2) {
  drawTownFountain(ctx, c);
}

function drawStreet(ctx: CanvasRenderingContext2D, pts: Vec2[], width: number, name?: string) {
  drawTownStreet(ctx, pts, width);
  if (name) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    const horizontal = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    ctx.save();
    ctx.translate(horizontal ? m.x + 46 : m.x, horizontal ? m.y + 3.6 : Math.min(m.y + 50, Math.max(a.y, b.y) - 22));
    if (!horizontal) ctx.rotate(-Math.PI / 2);
    label(ctx, name.toUpperCase(), 0, 0, { size: 3.1, color: "#425c55", bg: "#d5dfcb", weight: 600 });
    ctx.restore();
  }
}

function drawBuilding(ctx: CanvasRenderingContext2D, b: Building, highlight: boolean, now: number) {
  const e = extrude(b);
  const off = { x: -e * 0.35, y: -e };
  const roof = b.footprint.map((p) => add(p, off));
  // The original footprint and extrusion define the same silhouette and world position.
  ctx.save();
  path(ctx, convexHull([...b.footprint, ...roof]));
  ctx.clip();
  drawTownBuilding(ctx, b, e);
  ctx.restore();
  ctx.lineWidth = highlight ? 1.4 : 0.45;
  ctx.strokeStyle = highlight ? `rgba(255,249,217,${0.75 + 0.25 * Math.sin(now / 150)})` : "#62634d";
  path(ctx, b.footprint); ctx.stroke();
  const c = centroid(roof), bb = bbox(b.footprint);
  label(ctx, `${b.displayHeightCategory} · ${b.heightMeters} m`, c.x, bb.minY - e + 6, { size: 3.8, color: "#fff6db", bg: "#65536c" });
  label(ctx, b.name, c.x, bb.maxY + 4.5, { size: 3.4, color: "#554c39", bg: "#f3dfb0", weight: 600 });
}

function animatedShadows(level: Level, sun: SunInfo, verdict: Verdict, t: number): ShadowPoly[] {
  const k = easeOut(Math.min(1, t * 1.15));
  return verdict.shadows.map((s) => {
    if (s.kind === "building") {
      const b = level.buildings.find((x) => x.id === s.sourceId)!;
      return { ...s, poly: prismShadow(b.footprint, Math.max(0.01, b.heightMeters * k), sun) };
    }
    // Shield: grow outward from its centre.
    const pts = s.poly;
    const c = centroid(pts);
    return { ...s, poly: convexHull(pts.map((p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }))) };
  });
}

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

function drawShadows(ctx: CanvasRenderingContext2D, polys: ShadowPoly[]) {
  ctx.save();
  // Union look: draw all fills into one path with nonzero winding.
  ctx.beginPath();
  for (const s of polys) s.poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.fillStyle = COLORS.shadow;
  ctx.fill("nonzero");
  ctx.restore();
  ctx.strokeStyle = COLORS.shadowEdge;
  ctx.lineWidth = 0.4;
  for (const s of polys) {
    path(ctx, s.poly);
    ctx.stroke();
  }
}

function drawSun(ctx: CanvasRenderingContext2D, sun: SunInfo, t: number, now: number) {
  const c = { x: BOARD_W / 2, y: BOARD_H / 2 };
  const k = easeOut(Math.min(1, t * 1.4));
  // Project toward the sun until we hit the board edge, then pull inside the safe band.
  const d = sun.toSun;
  const tx = d.x ? (d.x > 0 ? BOARD_W - 30 - c.x : 30 - c.x) / d.x : Infinity;
  const ty = d.y ? (d.y > 0 ? BOARD_H - 22 - c.y : 22 - c.y) / d.y : Infinity;
  const r = Math.min(Math.abs(tx), Math.abs(ty));
  const pos = add(c, scale(d, r));
  // Keep the sun out of the QR anchor corners (it would sit next to a quiet zone).
  if (Math.abs(pos.x - c.x) > BOARD_W / 2 - 40) pos.y = Math.max(84, Math.min(BOARD_H - 84, pos.y));
  else pos.x = Math.max(96, Math.min(BOARD_W - 96, pos.x));
  drawTownSun(ctx, pos, k);
  // Light direction arrows across the board
  ctx.save();
  ctx.globalAlpha = 0.55 * k;
  ctx.strokeStyle = "#ff9a2a";
  ctx.lineWidth = 0.9;
  ctx.setLineDash([3, 3]);
  ctx.lineDashOffset = now / 60;
  const perp = { x: -d.y, y: d.x };
  for (const o of [-40, 0, 40]) {
    const s = add(pos, scale(perp, o * 0.4));
    const e = add(s, scale(d, -60 * k));
    ctx.beginPath();
    ctx.moveTo(s.x - d.x * 12, s.y - d.y * 12);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGaze(ctx: CanvasRenderingContext2D, g: RayHit, now: number) {
  ctx.save();
  ctx.strokeStyle = g.building ? "rgba(229,72,77,0.9)" : "rgba(229,72,77,0.45)";
  ctx.lineWidth = 0.9;
  ctx.setLineDash([2.2, 2]);
  ctx.lineDashOffset = -now / 40;
  ctx.beginPath();
  ctx.moveTo(g.origin.x, g.origin.y);
  ctx.lineTo(g.end.x, g.end.y);
  ctx.stroke();
  ctx.restore();
  if (g.building) {
    ctx.fillStyle = "#e5484d";
    ctx.beginPath();
    ctx.arc(g.end.x, g.end.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
    label(ctx, `👀 ${g.building.name} · ${g.building.heightMeters} m`, g.end.x, g.end.y - 5, { size: 3.4, color: "#fff", bg: "rgba(229,72,77,0.92)" });
  }
}

function drawShieldAim(ctx: CanvasRenderingContext2D, shield: Pose, aim: { aimed: boolean; end: Vec2 }, now: number) {
  ctx.save();
  ctx.strokeStyle = aim.aimed ? "#3ddc84" : "rgba(255,181,71,0.7)";
  ctx.lineWidth = aim.aimed ? 1.3 : 0.8;
  ctx.setLineDash([3, 2]);
  ctx.lineDashOffset = -now / 40;
  ctx.beginPath();
  ctx.moveTo(shield.position.x, shield.position.y);
  ctx.lineTo(aim.end.x, aim.end.y);
  ctx.stroke();
  ctx.restore();
  if (aim.aimed) label(ctx, "SHIELD → DRACULA", (shield.position.x + aim.end.x) / 2, (shield.position.y + aim.end.y) / 2 - 4, { size: 3.2, color: "#05351b", bg: "rgba(61,220,132,0.95)" });
}

function statusAlpha(status: string) {
  return status === "tracked" ? 1 : status === "held" ? 0.45 : 0;
}

function drawDracula(ctx: CanvasRenderingContext2D, inp: RenderInput) {
  const st = inp.tracking.dracula;
  const sub = inp.submission;
  const locked = sub && ["READY", "REVEAL", "SUCCESS", "FAILURE"].includes(inp.phase);
  // Submitted (locked) position
  if (locked) {
    const p = sub.dracula;
    const safe = inp.verdict?.safe;
    const revealed = inp.phase === "SUCCESS" || inp.phase === "FAILURE";
    ctx.save();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = revealed ? (safe ? "#3ddc84" : "#e5484d") : "#fff";
    ctx.fillStyle = revealed ? (safe ? "rgba(61,220,132,0.25)" : "rgba(229,72,77,0.3)") : "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, RULES.draculaRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // lock ring
    ctx.setLineDash([2, 1.6]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 20, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    const txt = revealed ? `${Math.round((inp.verdict?.coverage ?? 0) * 100)}% IN SHADE` : "POSITION LOCKED";
    label(ctx, txt, p.x, p.y + 25, { size: 3.6, color: "#fff", bg: revealed ? (safe ? "rgba(20,120,70,0.95)" : "rgba(170,30,40,0.95)") : "rgba(30,18,60,0.85)" });
  }
  const a = statusAlpha(st.status);
  if (!st.pose || a === 0) return;
  const p = st.pose.position;
  const pulse = 1 + 0.06 * Math.sin(inp.now / 220);
  ctx.save();
  ctx.globalAlpha = a * (locked ? 0.45 : 1);
  // Halo ring OUTSIDE the physical token so it is visible around it.
  ctx.strokeStyle = COLORS.dracula;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 19 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 0.6;
  ctx.setLineDash([1.5, 1.5]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, RULES.draculaRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  if (inp.tracking.simulated) drawDraculaSprite(ctx, p);
  // Facing tick
  const f = bearingToVec(st.pose.heading);
  ctx.fillStyle = COLORS.dracula;
  ctx.beginPath();
  const tip = add(p, scale(f, 24 * pulse));
  const l = add(p, add(scale(f, 18), scale({ x: -f.y, y: f.x }, 3)));
  const r = add(p, add(scale(f, 18), scale({ x: f.y, y: -f.x }, 3)));
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(l.x, l.y);
  ctx.lineTo(r.x, r.y);
  ctx.fill();
  ctx.restore();
  if (!locked) {
    const tag = st.status === "held" ? "DRACULA (signal lost…)" : inp.tracking.simulated ? "DRACULA · SIM" : "DRACULA";
    label(ctx, tag, p.x, p.y - 24, { size: 3.6, color: "#fff", bg: st.status === "held" ? "#807286" : "#8c4b67" });
    if (inp.simSelected === "dracula") label(ctx, "drag · wheel/Q/E rotate", p.x, p.y + 25, { size: 2.8, color: "#2a1d4a", bg: "rgba(255,255,255,0.8)", weight: 500 });
  }
}

function drawShield(ctx: CanvasRenderingContext2D, inp: RenderInput, level: Level) {
  const sub = inp.submission;
  const locked = sub?.shield && ["READY", "REVEAL", "SUCCESS", "FAILURE"].includes(inp.phase);
  const pose = locked ? sub!.shield!.pose : inp.tracking.shield.pose;
  const a = locked ? 1 : statusAlpha(inp.tracking.shield.status);
  if (!pose || a === 0) return;
  const spec = level.shield ?? { widthMeters: 44, heightMeters: 80, wallOffsetMarkerUnits: 0.75 };
  const size = locked ? sub!.shield!.markerSize : inp.tracking.shield.markerSizeMeters || 32;
  const [A, B] = shieldWall(pose, spec, size);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#8a5a2b";
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(A.x, A.y);
  ctx.lineTo(B.x, B.y);
  ctx.stroke();
  ctx.strokeStyle = "#d9a066";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  const f = bearingToVec(pose.heading);
  const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const tip = add(m, scale(f, 8));
  ctx.strokeStyle = "#ffb547";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(m.x, m.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.restore();
  label(ctx, locked ? "SHIELD (locked)" : inp.tracking.shield.status === "held" ? "SHIELD (signal lost…)" : "SHIELD", Math.max(22, Math.min(BOARD_W - 22, B.x - f.x * 10)), Math.max(8, Math.min(BOARD_H - 8, B.y - f.y * 10)), { size: 3.2, color: "#59472f", bg: "#e8c580" });
}

function drawWorkshopZones(ctx: CanvasRenderingContext2D, w: WorkshopLayer, now: number) {
  // Left / right halves
  ctx.save();
  ctx.fillStyle = w.half === "LEFT" ? "rgba(90, 160, 255, 0.16)" : "rgba(90,160,255,0.05)";
  ctx.fillRect(0, 0, BOARD_W / 2, BOARD_H);
  ctx.fillStyle = w.half === "RIGHT" ? "rgba(255, 120, 200, 0.16)" : "rgba(255,120,200,0.05)";
  ctx.fillRect(BOARD_W / 2, 0, BOARD_W / 2, BOARD_H);
  ctx.strokeStyle = "rgba(60,40,120,0.6)";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(BOARD_W / 2, 0);
  ctx.lineTo(BOARD_W / 2, BOARD_H);
  ctx.stroke();
  ctx.restore();
  label(ctx, "LEFT ZONE", BOARD_W / 4, BOARD_H - 6, { size: 3.6, color: "#fff", bg: w.half === "LEFT" ? "#3b6fd6" : "rgba(60,80,140,0.6)" });
  label(ctx, "RIGHT ZONE", (BOARD_W * 3) / 4, BOARD_H - 6, { size: 3.6, color: "#fff", bg: w.half === "RIGHT" ? "#c43c94" : "rgba(140,60,110,0.6)" });

  // Four-QR board zone polygon
  const zone = CORNER_ORDER.map((c) => {
    const r = anchorPlateRect(c);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  });
  ctx.save();
  ctx.strokeStyle = "#1fb6c9";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 2.5]);
  ctx.lineDashOffset = now / 80;
  path(ctx, zone);
  ctx.stroke();
  ctx.restore();
  label(ctx, `4-QR BOARD ZONE · objects inside: ${w.boardZoneCount}`, BOARD_W / 2, 36, { size: 3.4, color: "#033", bg: "rgba(127,231,255,0.92)" });

  // Custom polygon
  if (w.customPoly.length) {
    ctx.save();
    ctx.strokeStyle = w.customInside ? "#e5484d" : "#7a4cc2";
    ctx.fillStyle = w.customInside ? "rgba(229,72,77,0.25)" : "rgba(122,76,194,0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    w.customPoly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (w.customClosed) {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
    for (const p of w.customPoly) {
      ctx.fillStyle = "#7a4cc2";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    if (w.customClosed) {
      const c = centroid(w.customPoly);
      label(ctx, w.customInside ? "⚠ GARLIC MARKET — DRACULA INSIDE!" : "GARLIC MARKET (restricted)", c.x, c.y, { size: 3.4, color: "#fff", bg: w.customInside ? "#e5484d" : "#7a4cc2" });
    }
  }

  // Movement trail
  if (w.trail.length > 1) {
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 1; i < w.trail.length; i++) {
      ctx.strokeStyle = `rgba(229,72,77,${(i / w.trail.length) * 0.8})`;
      ctx.lineWidth = 0.4 + (i / w.trail.length) * 1.4;
      ctx.beginPath();
      ctx.moveTo(w.trail[i - 1].x, w.trail[i - 1].y);
      ctx.lineTo(w.trail[i].x, w.trail[i].y);
      ctx.stroke();
    }
    const a = w.trail[Math.max(0, w.trail.length - 6)];
    const b = w.trail[w.trail.length - 1];
    const d = { x: b.x - a.x, y: b.y - a.y };
    const l = Math.hypot(d.x, d.y);
    if (l > 4) {
      const u = { x: d.x / l, y: d.y / l };
      const tip = add(b, scale(u, 12));
      ctx.fillStyle = "#e5484d";
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(b.x + u.x * 5 - u.y * 3, b.y + u.y * 5 + u.x * 3);
      ctx.lineTo(b.x + u.x * 5 + u.y * 3, b.y + u.y * 5 - u.x * 3);
      ctx.fill();
    }
    ctx.restore();
  }

  // Between hull
  if (w.between?.yes) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 207, 90, 0.22)";
    ctx.strokeStyle = "#e0a400";
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 0.7;
    path(ctx, convexHull([...w.between.a.footprint, ...w.between.b.footprint]));
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawAnchors(ctx: CanvasRenderingContext2D) {
  const bmp = getAnchorBitmap();
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (const c of CORNER_ORDER) {
    const r = anchorPlateRect(c);
    ctx.fillStyle = "#fff";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h);
  }
  ctx.restore();
}

function drawDebug(ctx: CanvasRenderingContext2D, inp: RenderInput) {
  const t = inp.tracking;
  const H = t.lastGoodCalibration?.H;
  if (H && t.lastFrame) {
    // Raw detections re-projected into world space.
    for (const m of t.lastFrame.markers) {
      const w = m.corners.map((p) => applyHomography(H, p));
      ctx.strokeStyle = m.payload.startsWith("zone") ? "#00c8ff" : "#ff00aa";
      ctx.lineWidth = 0.5;
      path(ctx, w);
      ctx.stroke();
      ctx.fillStyle = "#ff00aa";
      ctx.beginPath();
      ctx.arc(w[0].x, w[0].y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const raw = t.dracula.raw;
  if (raw) {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(raw.position.x - 3, raw.position.y);
    ctx.lineTo(raw.position.x + 3, raw.position.y);
    ctx.moveTo(raw.position.x, raw.position.y - 3);
    ctx.lineTo(raw.position.x, raw.position.y + 3);
    ctx.stroke();
  }
  if (inp.verdict) {
    ctx.strokeStyle = "#00ff88";
    ctx.lineWidth = 0.35;
    for (const s of inp.verdict.shadows) {
      path(ctx, s.poly);
      ctx.stroke();
    }
  }
}
