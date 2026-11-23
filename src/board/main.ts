/**
 * LAPTOP BOARD (/board) — authoritative game.
 * Receives TrackingFrames (phone or simulator) -> TrackingPipeline -> game state machine -> renderer.
 */
import "../styles/base.css";
import "./board.css";
import QRCode from "qrcode";
import { Sfx } from "../audio/effects.ts";
import { Voice, type Speaker } from "../audio/speech.ts";
import { ANCHOR_PLATE_OPTIONS, anchorPlate, BOARD_H, BOARD_W, DEFAULT_ANCHOR_PLATE, setAnchorPlate } from "../engine/boardLayout.ts";
import { DEFAULT_CALIBRATION_OPTIONS } from "../engine/calibration.ts";
import { currentLevel, gameReducer, initialGameState, readyBlockers, type GameEvent, type GameState, type Phase } from "../engine/gameState.ts";
import { applyHomography, dist, wrapAngle } from "../engine/geometry.ts";
import { LEVELS, type Level } from "../engine/levels.ts";
import { checkPlacement, evaluatePlacement, PROBLEM_TEXT, RULES } from "../engine/rules.ts";
import { compassName, sunFor, type SunInfo } from "../engine/solar.ts";
import { makeVirtualCamera, simulateFrame } from "../engine/simulator.ts";
import {
  MovementDetector, boardZonePolygon, gazeRay, inPolygonZone, isAdjacent, isBetween, leftRightZone, shieldAim, sideOfBuilding,
  type Half, type MovementEvent, type NamedZone,
} from "../engine/spatial.ts";
import { TrackingPipeline, type PipelineSnapshot } from "../engine/tracking.ts";
import type { Pose, Vec2 } from "../engine/types.ts";
import { GameSocket } from "../net/client.ts";
import { autoReloadOnNewBuild } from "../net/autoReload.ts";
import type { BoardStatus, ServerInfo } from "../net/protocol.ts";
import { render, toWorld, type View, type WorkshopLayer } from "./renderer.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const params = new URLSearchParams(location.search);
const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem("dracula." + k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem("dracula." + k, JSON.stringify(v));
    } catch { /* ignore */ }
  },
};

/**
 * Fire button actions on pointer DOWN (plus keyboard clicks). Panels re-render while tracking updates; with plain
 * "click", a button replaced between mousedown and mouseup never receives the click, so presses got lost.
 */
function onPress(container: HTMLElement, fn: (button: HTMLButtonElement) => void) {
  container.addEventListener("pointerdown", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b || b.disabled || e.button !== 0) return;
    e.preventDefault();
    fn(b);
  });
  container.addEventListener("click", (e) => {
    if (e.detail !== 0) return; // mouse/touch already handled on pointerdown; this is Enter/Space on a focused button
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (b && !b.disabled) fn(b);
  });
}

// ------------------------------------------------------------------ core state

const pipeline = new TrackingPipeline();
setAnchorPlate(store.get("anchorPlate", DEFAULT_ANCHOR_PLATE));
// Always start in AUTO calibration (older builds could persist a stale manual corner offset).
pipeline.calOptions = { ...DEFAULT_CALIBRATION_OPTIONS };
pipeline.dracula.offsets = store.get("draculaOffsets", { forward: 0, right: 0 });
let shieldWallOffset = store.get("shieldWallOffset", 0.75);

let game: GameState = initialGameState();
let snap: PipelineSnapshot = pipeline.snapshot();
let sessionCode = "";
let serverInfo: ServerInfo | null = null;
let cameras = 0;
let revealStart = 0;
let debugOn = params.has("debug");
let workshopOn = params.has("workshop");
let simOn = params.has("sim");
let started = false;

const voice = new Voice();
const sfx = new Sfx();
voice.setMuted(store.get("muted", false));
sfx.muted = voice.muted;

function levelOf(): Level {
  const l = currentLevel(game);
  return l.shield ? { ...l, shield: { ...l.shield, wallOffsetMarkerUnits: shieldWallOffset } } : l;
}
const sunCache = new Map<number, SunInfo>();
function sunOf(l: Level): SunInfo {
  if (!sunCache.has(l.id)) sunCache.set(l.id, sunFor(l.place, l.dateISO, l.time));
  return sunCache.get(l.id)!;
}

// ------------------------------------------------------------------ networking

const sock = new GameSocket();
sock.onOpen = () => sock.send({ t: "host", code: sessionStorage.getItem("dracula.session") ?? undefined });
sock.onState = () => updateStatusSoon();
sock.onMessage = (m) => {
  switch (m.t) {
    case "hosted":
      sessionCode = m.code;
      serverInfo = m.info;
      sessionStorage.setItem("dracula.session", m.code);
      $("#p-session").textContent = m.code;
      renderCard();
      break;
    case "peer": {
      const prev = cameras;
      cameras = m.cameras;
      if (cameras > prev) {
        toast("📱 Phone camera connected", "ok");
        sfx.play("connect");
        if (started || voice.unlocked) void say("Camera connected. Let's find Dracula!", "narrator");
      } else if (cameras < prev) {
        toast("Phone camera disconnected", "bad");
      }
      renderCard();
      break;
    }
    case "frame":
      if (!simOn) pipeline.ingest(m.frame, Date.now());
      break;
    case "error":
      toast(m.message, "info");
      break;
    case "cameraCmd":
      // Manual rotation only exists in "image" mode; auto mode searches every assignment by itself.
      if (m.cmd.type === "rotateCorners") pipeline.calOptions = { mode: "image", cornerOffset: (pipeline.calOptions.cornerOffset + 1) % 4 };
      if (m.cmd.type === "setMode") pipeline.calOptions = { mode: m.cmd.mode, cornerOffset: 0 };
      if (m.cmd.type === "resetCalibration") pipeline.reset();
      store.set("calOptions", pipeline.calOptions);
      toast(`Calibration: ${pipeline.calOptions.mode}, corner rotation ${pipeline.calOptions.cornerOffset}`, "info");
      break;
  }
};
sock.connect();

setInterval(() => {
  const st: BoardStatus = {
    phase: game.phase,
    level: game.levelIndex + 1,
    calibrated: snap.calibrationFresh,
    anchorCount: snap.calibration?.anchorCount ?? 0,
    dracula: snap.dracula.status,
    shield: snap.shield.status,
    calOptions: pipeline.calOptions,
    usesShield: levelOf().usesShield,
    draculaFixed: !!levelOf().draculaFixed && !workshopOn,
    anchorPlate: anchorPlate(),
    message: statusLine(),
  };
  sock.send({ t: "boardStatus", status: st });
}, 500);

// Normalized world state for Procession / p5.js consumers (GET /api/session/:code/state).
setInterval(() => {
  const obj = (o: typeof snap.dracula) =>
    o.pose && o.status !== "lost"
      ? { status: o.status, x: o.pose.position.x, y: o.pose.position.y, nx: o.pose.position.x / BOARD_W, ny: o.pose.position.y / BOARD_H, headingDeg: (((o.pose.heading * 180) / Math.PI) % 360 + 360) % 360 }
      : null;
  const revealed = game.phase === "SUCCESS" || game.phase === "FAILURE";
  const v = game.verdict;
  sock.send({
    t: "worldState",
    state: {
      code: sessionCode, anchorPlate: anchorPlate(), t: Date.now(), phase: workshopOn ? "WORKSHOP" : game.phase, level: game.levelIndex + 1, calibrated: snap.calibrationFresh, simulated: snap.simulated,
      dracula: obj(snap.dracula), shield: obj(snap.shield),
      result: revealed && v ? { safe: v.safe, coverage: v.coverage, sunAzimuthDeg: v.sun.azimuthDeg, sunAltitudeDeg: v.sun.altitudeDeg } : null,
    },
  });
}, 150);

function statusLine(): string {
  if (!snap.lastFrame) return "waiting for camera frames";
  const cal = snap.calibration;
  const parts = [cal?.ok ? "4 corners ✓" : `${cal?.anchorCount ?? 0}/4 corners`, `Dracula ${snap.dracula.status}`];
  if (levelOf().usesShield) parts.push(`Shield ${snap.shield.status}`);
  parts.push(`L${game.levelIndex + 1} ${game.phase}`);
  return parts.join(" · ");
}

// ------------------------------------------------------------------ simulator (same pipeline)

const simCam = makeVirtualCamera({ rotationDeg: 0, keystone: 0.06, width: 1280, height: 720 });
const sim = {
  dracula: { position: { x: 196, y: 150 }, heading: 0 } as Pose,
  shield: { position: { x: 175, y: 150 }, heading: (339 * Math.PI) / 180 } as Pose,
  showDracula: true,
  showShield: true,
  selected: "dracula" as "dracula" | "shield",
  dragging: false,
};
setInterval(() => {
  if (!simOn) return;
  const lvlShield = levelOf().usesShield || workshopOn;
  const f = simulateFrame(simCam, {
    dracula: sim.showDracula ? sim.dracula : null,
    shield: lvlShield && sim.showShield ? sim.shield : null,
    markerSize: 32,
    jitterPx: 0.4,
  }, sessionCode || "SIM");
  pipeline.ingest(f, Date.now());
}, 70);

function setSim(on: boolean) {
  simOn = on;
  pipeline.reset();
  $("#sim-badge").classList.toggle("hidden", !on);
  $("#t-sim").classList.toggle("on", on);
  toast(on ? "Simulator ON — drag Dracula, wheel/Q/E rotates, 2 selects shield, H hides marker" : "Simulator OFF — using the phone camera", "info");
  renderCard();
}

// ------------------------------------------------------------------ dispatch + phase side-effects

function dispatch(e: GameEvent) {
  const prev = game.phase;
  const prevLevel = game.levelIndex;
  game = gameReducer(game, e);
  if (game.levelIndex !== prevLevel) sessionStorage.setItem("dracula.level", String(game.levelIndex + 1));
  if (game.phase === "GAME_COMPLETE") sessionStorage.removeItem("dracula.level");
  if (game.phase !== prev || game.levelIndex !== prevLevel) onPhase(prev, game.phase);
  if (e.type === "PRESS_READY" && game.phase === "PREDICTION" && game.blockers.length) {
    sfx.play("warn");
    void say(game.blockers[0], "narrator");
  }
  renderPanel();
}

let phaseToken = 0;
async function onPhase(_prev: Phase, next: Phase) {
  const token = ++phaseToken;
  const still = () => token === phaseToken;
  const lvl = levelOf();
  renderCard();
  $("#result").classList.add("hidden");
  switch (next) {
    case "MISSION":
      movement.reset();
      if (lvl.voice.intro) {
        await say(lvl.voice.intro);
        if (!still()) return;
      }
      await say(lvl.voice.mission);
      if (still() && game.phase === "MISSION") dispatch({ type: "MISSION_DONE" });
      break;
    case "PREDICTION":
      predictionSince = performance.now();
      showSubtitle(lvl.usesShield ? "Place Dracula in the golden circle, then build shade with the SHIELD. Press READY." : "Move Dracula where you predict the shadows will be. Press READY.", "narrator", 6000);
      break;
    case "READY":
      sfx.play("ready");
      await say("Ready? Let's see where the sunlight falls!", "narrator");
      if (still() && game.phase === "READY") dispatch({ type: "REVEAL" });
      break;
    case "REVEAL":
      revealStart = performance.now();
      sfx.play("reveal");
      void say("The sun is coming!", "narrator");
      setTimeout(() => still() && dispatch({ type: "REVEAL_DONE" }), 3200);
      break;
    case "SUCCESS":
    case "FAILURE": {
      const ok = next === "SUCCESS";
      showResult(ok);
      sfx.play(ok ? "success" : "failure");
      if (!ok && game.submission) spawnSmoke(game.submission.dracula);
      if (ok && game.submission) spawnSparkles(game.submission.dracula);
      await say(ok ? lvl.voice.success : lvl.voice.failure);
      break;
    }
    case "LEVEL_TRANSITION":
      void say(`Level ${lvl.id}. ${lvl.title}.`, "narrator");
      setTimeout(() => still() && dispatch({ type: "TRANSITION_DONE" }), 3800);
      break;
    case "GAME_COMPLETE": {
      const wins = game.results.filter((r) => r === "O").length;
      void say(wins === 3 ? "You survived the whole day! Dracula thanks you!" : `You saved Dracula ${wins} out of 3 times.`);
      break;
    }
  }
}

function say(text: string, speaker: Speaker = "dracula") {
  return voice.say(text, speaker);
}

voice.onSubtitle = (text, speaker) => showSubtitle(text, speaker);
voice.onSubtitleClear = () => $("#subtitle").classList.add("hidden");

let subTimer = 0;
function showSubtitle(text: string, speaker: Speaker, ms = 0) {
  const el = $("#subtitle");
  el.innerHTML = `<span class="who ${speaker}">${speaker === "dracula" ? "🧛 Dracula" : "Narrator"}</span>${escapeHtml(text)}`;
  el.classList.remove("hidden");
  clearTimeout(subTimer);
  if (ms) subTimer = window.setTimeout(() => el.classList.add("hidden"), ms);
}

function startGame() {
  if (!started) {
    voice.unlock();
    sfx.unlock();
    started = true;
  }
  const wasComplete = game.phase === "GAME_COMPLETE";
  dispatch({ type: "START" });
  // Resume the level we were on before a reload (auto-update) or a ?level=N link. Not after finishing the game.
  const want = Number(params.get("level") ?? (wasComplete ? 1 : sessionStorage.getItem("dracula.level") ?? 1)) - 1;
  if (want > 0 && want < LEVELS.length && game.phase === "MISSION") dispatch({ type: "GOTO_LEVEL", levelIndex: want });
}

let predictionSince = 0;
/** READY "locking" window: keep trying for a few seconds so a flickering marker doesn't bounce the player. */
let lockingUntil = 0;
const LOCK_WAIT_MS = 3000;
function pressReady() {
  if (game.phase !== "PREDICTION") return;
  // The READY button replaces BEGIN under the cursor; ignore presses for a moment to prevent accidental submits.
  if (performance.now() - predictionSince < 1500) return;
  if (lockingUntil) return;
  lockingUntil = performance.now() + LOCK_WAIT_MS;
  showSubtitle("Locking Dracula's position… hold still", "narrator", LOCK_WAIT_MS);
  tryLock();
}
/** Called every frame while locking. Submits as soon as all READY conditions hold. */
function tryLock() {
  if (!lockingUntil) return;
  if (game.phase !== "PREDICTION") {
    lockingUntil = 0;
    return;
  }
  const now = Date.now();
  const { blockers } = readyBlockers(levelOf(), pipeline.snapshot(now), now);
  if (!blockers.length) {
    lockingUntil = 0;
    dispatch({ type: "PRESS_READY", tracking: pipeline.snapshot(now), now });
    return;
  }
  // Placement problems (rooftop, outside the circle...) won't fix themselves: report right away.
  const transient = blockers.every((b) => /not visible|Hold Dracula still|No live camera|not calibrated/.test(b));
  if (!transient || performance.now() > lockingUntil) {
    lockingUntil = 0;
    dispatch({ type: "PRESS_READY", tracking: pipeline.snapshot(now), now }); // records + announces the blockers
  }
}

// ------------------------------------------------------------------ canvas + view

const canvas = $<HTMLCanvasElement>("#city");
const ctx = canvas.getContext("2d")!;
let view: View = { scale: 1, ox: 0, oy: 0, dpr: 1 };

function layout() {
  const stage = $("#stage").getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(stage.width * dpr);
  canvas.height = Math.round(stage.height * dpr);
  canvas.style.width = stage.width + "px";
  canvas.style.height = stage.height + "px";
  const pad = 10;
  const s = Math.min((stage.width - pad * 2) / BOARD_W, (stage.height - pad * 2) / BOARD_H);
  view = { scale: s, ox: (stage.width - BOARD_W * s) / 2, oy: (stage.height - BOARD_H * s) / 2, dpr };
  // Overlays live in the QR-free middle band between the anchor plates (anchors occupy the corners).
  const safe = $("#safe");
  const m = anchorPlate() + 4;
  safe.style.left = view.ox + m * s + "px";
  safe.style.top = view.oy + 6 * s + "px";
  safe.style.width = (BOARD_W - 2 * m) * s + "px";
  safe.style.height = (BOARD_H - 12) * s + "px";
  safe.style.setProperty("--u", s + "px");
}
window.addEventListener("resize", layout);
layout();

// ------------------------------------------------------------------ workshop state

const movement = new MovementDetector();
const eventsLog: MovementEvent[] = [];
const workshop = {
  customPoly: store.get<Vec2[]>("customPoly", []),
  customClosed: store.get("customClosed", false),
  drawing: false,
  previewShadows: false,
  half: null as Half | null,
  lastAdjacent: "",
  lastGaze: "",
  lastAim: false,
};

function workshopZones(l: Level): NamedZone[] {
  const z: NamedZone[] = [
    { name: "LEFT ZONE", contains: (p) => leftRightZone(p, workshop.half) === "LEFT" },
    { name: "RIGHT ZONE", contains: (p) => leftRightZone(p, workshop.half) === "RIGHT" },
    { name: "4-QR BOARD ZONE", contains: (p) => inPolygonZone(p, boardZonePolygon()) },
  ];
  if (workshop.customClosed) z.push({ name: "GARLIC MARKET", contains: (p) => inPolygonZone(p, workshop.customPoly) });
  if (l.destination) z.push({ name: "GOLDEN CIRCLE", contains: (p) => dist(p, l.destination!.center) <= l.destination!.radius });
  return z;
}

function computeWorkshop(l: Level, now: number): WorkshopLayer | null {
  if (!workshopOn) return null;
  const d = snap.dracula.status === "tracked" || snap.dracula.status === "held" ? snap.dracula.pose : null;
  const p = d?.position ?? null;
  if (p) workshop.half = leftRightZone(p, workshop.half);
  const evs = movement.update(snap.dracula.status === "tracked" ? p : null, now, workshopZones(l), l.buildings);
  for (const e of evs) {
    eventsLog.unshift(e);
    eventsLog.length = Math.min(eventsLog.length, 10);
    const warn = e.subject === "GARLIC MARKET" && e.type === "ENTER";
    toast(e.message, warn ? "bad" : "info");
    sfx.play(warn ? "warn" : e.type === "ENTER" ? "enter" : e.type === "EXIT" ? "exit" : "tick");
    if (warn) void say("Garlic! Get me out of here!");
  }
  const [A, B] = l.buildings;
  const adjacent = p ? l.buildings.filter((b) => isAdjacent(p, b, RULES.draculaRadius)) : [];
  const adjKey = adjacent.map((b) => b.id).join();
  if (adjKey !== workshop.lastAdjacent) {
    workshop.lastAdjacent = adjKey;
    if (adjacent.length) {
      sfx.play("chime");
      toast(`Next to ${adjacent.map((b) => `${b.name} (${b.displayHeightCategory}, ${b.heightMeters} m)`).join(", ")}`, "info");
    }
  }
  const objs = [snap.dracula, snap.shield].filter((o) => o.pose && o.status !== "lost");
  const shield = snap.shield.pose && snap.shield.status !== "lost" ? snap.shield.pose : null;
  const aim = shield && p ? shieldAim(shield, p, RULES.draculaRadius) : null;
  if (aim && aim.aimed !== workshop.lastAim) {
    workshop.lastAim = aim.aimed;
    if (aim.aimed) {
      sfx.play("chime");
      toast("Shield is aimed toward Dracula", "ok");
    }
  }
  let shadowZone: "SAFE" | "EXPOSED" | null = null;
  if (workshop.previewShadows && p) {
    const v = evaluatePlacement(l, p, shield ? { pose: shield, markerSize: snap.shield.markerSizeMeters } : null);
    shadowZone = v.coverage >= RULES.coverageThreshold ? "SAFE" : "EXPOSED";
  }
  return {
    half: p ? workshop.half : null,
    customPoly: workshop.customPoly,
    customClosed: workshop.customClosed,
    customInside: !!p && workshop.customClosed && inPolygonZone(p, workshop.customPoly),
    boardZoneCount: objs.filter((o) => inPolygonZone(o.pose!.position, boardZonePolygon())).length,
    draculaInBoardZone: !!p && inPolygonZone(p, boardZonePolygon()),
    sideOf: p ? { building: A, side: sideOfBuilding(p, A) } : null,
    between: p && B ? { a: A, b: B, yes: isBetween(p, A, B) } : null,
    adjacent,
    trail: movement.trail(),
    shieldAim: aim ? { aimed: aim.aimed, end: aim.end } : null,
    previewShadows: workshop.previewShadows,
    shadowZone,
  };
}

/** Levels with a fixed Dracula (L3: the fountain) show him there; only the shield marker is tracked. */
function withFixedDracula(s: PipelineSnapshot): PipelineSnapshot {
  const fixed = levelOf().draculaFixed;
  if (!fixed || workshopOn) return s;
  const pose = { position: fixed, heading: 0 };
  return { ...s, dracula: { ...s.dracula, status: "tracked", pose, raw: pose, confidence: 1, stable: true, history: [] } };
}

// ------------------------------------------------------------------ frame loop

let lastPanel = 0;
let lastSource = "";
function frame() {
  const now = Date.now();
  snap = withFixedDracula(pipeline.snapshot(now));
  const l = levelOf();
  const sun = sunOf(l);

  const connected = cameras > 0 || simOn;
  const src = `${connected}|${snap.calibrationFresh}|${snap.dracula.status}`;
  if (src !== lastSource) {
    lastSource = src;
    dispatch({ type: "SOURCE", connected, calibrated: snap.calibrationFresh, draculaSeen: snap.dracula.status === "tracked" });
    renderCard();
  }

  // Directionality #1: Dracula's facing ray (environment info only — never reveals the sun or shadows).
  const showGaze = workshopOn || game.phase === "PREDICTION";
  const gaze = showGaze && snap.dracula.pose && snap.dracula.status === "tracked" ? gazeRay(snap.dracula.pose, l.buildings) : null;
  const gazeKey = gaze?.building?.id ?? "";
  if (gazeKey !== workshop.lastGaze) {
    workshop.lastGaze = gazeKey;
    if (gazeKey) sfx.play("tick");
  }

  tryLock();
  const ws = computeWorkshop(l, now);
  let reveal: number | null = null;
  if (!workshopOn) {
    if (game.phase === "REVEAL") reveal = Math.min(1, (performance.now() - revealStart) / 2600);
    else if (game.phase === "SUCCESS" || game.phase === "FAILURE") reveal = 1;
  }
  let liveShadows = null;
  if (workshopOn && workshop.previewShadows) {
    const sh = snap.shield.pose && snap.shield.status !== "lost" ? { pose: snap.shield.pose, markerSize: snap.shield.markerSizeMeters } : null;
    liveShadows = evaluatePlacement(l, snap.dracula.pose?.position ?? { x: -100, y: -100 }, sh).shadows;
  }

  render(ctx, view, {
    now: performance.now(),
    level: l,
    phase: workshopOn ? "PREDICTION" : game.phase,
    tracking: snap,
    sun,
    submission: workshopOn ? null : game.submission,
    verdict: workshopOn ? null : game.verdict,
    reveal,
    gaze,
    workshop: ws,
    debug: debugOn,
    simSelected: simOn ? sim.selected : null,
    liveShadows,
  });
  drawParticles();

  if (now - lastPanel > 120) {
    lastPanel = now;
    renderPanel();
    if (workshopOn) renderWorkshopPanel(ws);
    if (debugOn) renderDebug(l, sun);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ particles (smoke / sparkles)

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; kind: "smoke" | "spark" }
let particles: Particle[] = [];
function spawnSmoke(p: Vec2) {
  for (let i = 0; i < 70; i++) particles.push({ x: p.x + (Math.random() - 0.5) * 10, y: p.y + (Math.random() - 0.5) * 10, vx: (Math.random() - 0.5) * 6, vy: -8 - Math.random() * 14, life: 0, max: 1.4 + Math.random() * 1.4, kind: "smoke" });
}
function spawnSparkles(p: Vec2) {
  for (let i = 0; i < 50; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 10 + Math.random() * 30;
    particles.push({ x: p.x, y: p.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.8 + Math.random() * 0.8, kind: "spark" });
  }
}
let lastPT = performance.now();
function drawParticles() {
  const t = performance.now();
  const dt = Math.min(0.05, (t - lastPT) / 1000);
  lastPT = t;
  if (!particles.length) return;
  ctx.save();
  ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, view.dpr * view.ox, view.dpr * view.oy);
  particles = particles.filter((p) => (p.life += dt) < p.max);
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const k = 1 - p.life / p.max;
    if (p.kind === "smoke") {
      p.vx *= 0.98;
      ctx.fillStyle = `rgba(${60 + 80 * (1 - k)}, ${50 + 40 * (1 - k)}, ${70}, ${0.5 * k})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2 + (1 - k) * 7, 0, Math.PI * 2);
      ctx.fill();
      if (p.life < 0.4) {
        ctx.fillStyle = `rgba(255, ${120 + Math.random() * 80}, 40, ${0.8 * k})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y + 4, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = `rgba(255, ${200 + 55 * k}, 90, ${k})`;
      ctx.fillRect(p.x - 0.8, p.y - 0.8, 1.6, 1.6);
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------ panel

const fmtDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const tzAbbr = (sun: SunInfo, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(sun.utc).find((p) => p.type === "timeZoneName")?.value ?? "";

function compassSvg(sun: SunInfo | null): string {
  const ticks = Array.from({ length: 16 }, (_, i) => {
    const a = (i * Math.PI) / 8;
    const r0 = i % 4 === 0 ? 40 : 45;
    return `<line x1="${Math.sin(a) * r0}" y1="${-Math.cos(a) * r0}" x2="${Math.sin(a) * 50}" y2="${-Math.cos(a) * 50}" />`;
  }).join("");
  let sunMark = `<text class="q" x="0" y="8">?</text>`;
  if (sun) {
    const a = (sun.azimuthDeg * Math.PI) / 180;
    const sx = Math.sin(a) * 36;
    const sy = -Math.cos(a) * 36;
    sunMark = `<line class="sunray" x1="${sx}" y1="${sy}" x2="${-sx * 0.8}" y2="${-sy * 0.8}" marker-end="url(#arr)"/><circle class="sundot" cx="${sx}" cy="${sy}" r="8"/>`;
  }
  return `
    <defs><marker id="arr" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ffb547"/></marker></defs>
    <circle class="ring" r="54"/><g class="ticks">${ticks}</g>
    <path class="needle-n" d="M0,-34 L7,0 L-7,0 Z"/><path class="needle-s" d="M0,34 L7,0 L-7,0 Z"/>
    <text class="cardinal n" x="0" y="-38">N</text><text class="cardinal" x="41" y="5">E</text>
    <text class="cardinal" x="0" y="48">S</text><text class="cardinal" x="-41" y="5">W</text>
    ${sunMark}`;
}

let lastPanelKey = "";
function renderPanel() {
  const l = levelOf();
  const sun = sunOf(l);
  const revealed = !workshopOn && ["REVEAL", "SUCCESS", "FAILURE"].includes(game.phase);
  const key = `${l.id}|${revealed}|${game.phase}`;
  if (key !== lastPanelKey) {
    lastPanelKey = key;
    $("#p-kicker").textContent = `LEVEL ${l.id} · ${l.subtitle}`;
    $("#p-title").textContent = l.title;
    $("#p-city").textContent = l.place.city;
    $("#p-date").textContent = fmtDate(l.dateISO);
    $("#p-time").innerHTML = `${l.timeLabel} <small>${tzAbbr(sun, l.place.timeZone)}</small>`;
    $("#compass").innerHTML = compassSvg(revealed ? sun : null);
    $("#p-sun").innerHTML = revealed
      ? `<span>Sun</span><b>${compassName(sun.azimuthDeg)} ${Math.round(sun.azimuthDeg)}°</b><em>altitude ${Math.round(sun.altitudeDeg)}° · shadows ×${sun.shadowFactor.toFixed(2)} height</em>`
      : `<span>Sun</span><b class="hidden-sun">?</b><em>hidden until reveal</em>`;
    $("#p-mission").textContent = l.missionText;
  }

  // Status chips
  const chips: string[] = [];
  const conn = sock.state === "open";
  chips.push(chip(simOn ? "sim" : cameras ? "ok" : conn ? "warn" : "bad", simOn ? "SIMULATED input" : cameras ? "Phone camera" : conn ? "Waiting for phone" : "Server offline"));
  const cal = snap.calibration;
  chips.push(chip(cal?.ok ? "ok" : snap.calibrationFresh ? "warn" : "bad", cal?.ok ? "Calibrated" : snap.calibrationFresh ? `Calibration held (${cal?.anchorCount ?? 0}/4)` : (cal?.anchorCount ?? 0) >= 4 ? `Corners 4/4 but not calibrated` : `Corners ${cal?.anchorCount ?? 0}/4`));
  if (!cal?.ok && (cal?.anchorCount ?? 0) >= 4 && cal?.reason) chips.push(`<span class="chip bad" title="calibration">${escapeHtml(cal.reason)}</span>`);
  if (l.draculaFixed && !workshopOn) chips.push(chip("ok", "Dracula waits at the fountain"));
  else chips.push(chip(trackClass(snap.dracula.status), `Dracula ${snap.dracula.status} ${snap.dracula.status !== "none" ? Math.round(snap.dracula.confidence * 100) + "%" : ""}`));
  if (l.usesShield || workshopOn) chips.push(chip(trackClass(snap.shield.status), `Shield ${snap.shield.status}`));
  setHtml($("#p-status"), chips.join(""));

  $("#p-blockers").innerHTML = game.phase === "PREDICTION" && game.blockers.length ? game.blockers.map((b) => `<div>⚠ ${escapeHtml(b)}</div>`).join("") : livePlacementHint(l);

  // Actions
  const a: string[] = [];
  const ph = game.phase;
  if (ph === "SETUP" || ph === "CALIBRATION") a.push(`<button class="primary big" data-act="start">START GAME</button>`);
  if (ph === "MISSION") a.push(`<button class="primary big" data-act="begin">BEGIN ▶</button>`);
  if (ph === "PREDICTION") {
    const { blockers } = readyBlockers(l, snap, Date.now());
    const arming = performance.now() - predictionSince < 1500;
    a.push(lockingUntil
      ? `<button class="primary big" disabled>LOCKING…</button>`
      : `<button class="primary big ${blockers.length ? "soft" : ""}" data-act="ready" ${arming ? "disabled" : ""}>READY</button>`);
  }
  if (ph === "READY") a.push(`<button class="primary big" data-act="reveal">REVEAL ☀</button>`);
  if (ph === "REVEAL") a.push(`<button class="big" disabled>Revealing…</button>`);
  if (ph === "SUCCESS") a.push(`<button class="primary big" data-act="next">${game.levelIndex < LEVELS.length - 1 ? "NEXT LEVEL ▶" : "FINISH ▶"}</button>`, `<button class="ghost" data-act="retry">Play again</button>`);
  if (ph === "FAILURE") a.push(`<button class="primary big" data-act="retry">TRY AGAIN</button>`, `<button class="ghost" data-act="next">Skip level</button>`);
  if (ph === "GAME_COMPLETE") a.push(`<button class="primary big" data-act="start">PLAY AGAIN</button>`);
  const html = a.join("");
  if ($("#p-actions").innerHTML !== html) $("#p-actions").innerHTML = html;

  setHtml($("#p-results"), LEVELS.map((lv, i) => `<div class="res ${game.results[i] ?? ""} ${i === game.levelIndex ? "cur" : ""}"><span>L${lv.id}</span><b>${game.results[i] ?? "·"}</b></div>`).join(""));
  $("#t-mute").textContent = voice.muted ? "🔇" : "🔊";
}

function livePlacementHint(l: Level): string {
  if (game.phase !== "PREDICTION" || !snap.dracula.pose || snap.dracula.status !== "tracked") return "";
  // Uses the same placement rule as READY. It never says anything about sun or shadows.
  const sh = snap.shield.pose && snap.shield.status === "tracked" ? { pose: snap.shield.pose, markerSize: snap.shield.markerSizeMeters } : null;
  return checkPlacement(l, snap.dracula.pose.position, sh)
    .filter((p) => p !== "SHIELD_MISSING")
    .map((p) => `<div class="hint">${PROBLEM_TEXT[p]}</div>`)
    .join("");
}

const trackClass = (s: string) => (s === "tracked" ? "ok" : s === "held" || s === "acquiring" ? "warn" : "bad");
const chip = (cls: string, text: string) => `<span class="chip ${cls}">${escapeHtml(text)}</span>`;

onPress($("#p-actions"), (b) => {
  const act = b.dataset.act;
  if (act === "start") startGame();
  if (act === "begin") dispatch({ type: "MISSION_DONE" });
  if (act === "ready") pressReady();
  if (act === "reveal") dispatch({ type: "REVEAL" });
  if (act === "next") dispatch({ type: "NEXT" });
  if (act === "retry") dispatch({ type: "RETRY" });
});

// ------------------------------------------------------------------ center cards (QR-safe area)

function cameraUrl(): string {
  if (location.protocol === "https:" && !/^(localhost|127\.)/.test(location.hostname)) return `${location.origin}/camera?code=${sessionCode}`;
  if (serverInfo?.publicUrl) return `${serverInfo.publicUrl.replace(/\/$/, "")}/camera?code=${sessionCode}`;
  const ip = serverInfo?.lanIps[0] ?? location.hostname;
  return `https://${ip}:${serverInfo?.httpsPort ?? 5443}/camera?code=${sessionCode}`;
}

let lastCard = "";
function renderCard() {
  const card = $("#card");
  const l = levelOf();
  let html = "";
  const ph = workshopOn ? "WORKSHOP" : game.phase;
  if (ph === "SETUP" || ph === "CALIBRATION") {
    // Static HTML only: the ✓ marks are updated in place by updateSetupChecks(), so the card (and its buttons)
    // is NOT rebuilt every time tracking flickers. Rebuilding it was swallowing START GAME clicks.
    const ok = (key: string) => `<i data-check="${key}">·</i>`;
    const plate = anchorPlate();
    html = `
      <div class="kicker">HOST GAME</div>
      <div class="setup-grid">
        <div>
          <div class="code-label">Session code</div>
          <div class="code">${sessionCode || "····"}</div>
          <ol class="steps">
            <li>${ok("connected")} On your phone open <b class="url">${escapeHtml(cameraUrl())}</b> (or scan →) and accept the certificate warning.</li>
            <li>${ok("frames")} Enter the code, tap <b>Start camera</b>.</li>
            <li>${ok("calibrated")} Mount the phone above the laptop so all 4 corner QR codes are visible.</li>
            <li>${ok("dracula")} Put Dracula on the board.</li>
          </ol>
        </div>
        <canvas id="pair-qr" class="pair-qr"></canvas>
      </div>
      <div class="card-actions">
        <button class="primary" data-act="start">START GAME</button>
        <button class="ghost" data-act="sim">${simOn ? "Use phone camera" : "Try the mouse simulator"}</button>
      </div>
      <div class="plate-row">Corner QR size
        ${(Object.entries(ANCHOR_PLATE_OPTIONS) as [string, number][]).map(([k, v]) => `<button class="ghost ${v === plate ? "on" : ""}" data-act="plate" data-v="${v}">${k}</button>`).join("")}
        <span class="fine">S = smallest (camera close &amp; straight) · M = recommended · L = most robust</span>
      </div>`;
  } else if (ph === "MISSION") {
    html = `
      <div class="kicker">LEVEL ${l.id} · ${l.subtitle}</div>
      <h2 class="title">${l.title}</h2>
      <div class="clue-row"><div><span>City</span><b>${l.place.city}</b></div><div><span>Date</span><b>${fmtDate(l.dateISO)}</b></div><div><span>Local time</span><b>${l.timeLabel}</b></div></div>
      <p>${l.missionText}</p>
      ${l.usesShield ? `<p class="new">NEW: the cardboard <b>SHIELD</b>. Its QR card sets where it stands and which way it faces.</p>` : ""}
      <div class="card-actions"><button class="primary" data-act="begin">BEGIN ▶</button></div>`;
  } else if (ph === "LEVEL_TRANSITION") {
    html = `<div class="kicker">NEXT</div><h2 class="title">Level ${l.id}</h2><p class="big">${l.title}</p><p>${l.subtitle}</p>`;
  } else if (ph === "GAME_COMPLETE") {
    const wins = game.results.filter((r) => r === "O").length;
    html = `<div class="kicker">GAME COMPLETE</div><h2 class="title">${wins === 3 ? "Dracula survived the day!" : `Saved ${wins} / 3`}</h2>
      <div class="final">${game.results.map((r, i) => `<div class="${r ?? ""}"><span>Level ${i + 1}</span><b>${r ?? "–"}</b></div>`).join("")}</div>
      <div class="card-actions"><button class="primary" data-act="start">PLAY AGAIN</button></div>`;
  }
  if (html === lastCard) {
    updateSetupChecks();
    return;
  }
  lastCard = html;
  card.innerHTML = html;
  card.classList.toggle("hidden", !html);
  card.classList.toggle("compact", ph === "CALIBRATION");
  updateSetupChecks();
  const qr = card.querySelector<HTMLCanvasElement>("#pair-qr");
  if (qr && sessionCode) void QRCode.toCanvas(qr, cameraUrl(), { width: 180, margin: 2, color: { dark: "#120d24", light: "#ffffff" } });
}

function updateSetupChecks() {
  const state: Record<string, boolean> = {
    connected: cameras > 0 || simOn,
    frames: !!snap.lastFrame && snap.frameAge < 3000,
    calibrated: snap.calibrationFresh,
    dracula: snap.dracula.status === "tracked" || snap.dracula.status === "held",
  };
  document.querySelectorAll<HTMLElement>("#card [data-check]").forEach((el) => {
    const on = !!state[el.dataset.check!];
    if (el.classList.contains("ok") !== on) {
      el.classList.toggle("ok", on);
      el.textContent = on ? "✓" : "·";
    }
  });
}

function setPlate(m: number) {
  setAnchorPlate(m);
  store.set("anchorPlate", anchorPlate());
  pipeline.reset();
  layout();
  lastCard = "";
  renderCard();
  toast(`Corner QR size ${anchorPlate()} m`, "info");
}

onPress($("#card"), (b) => {
  const act = b.dataset.act;
  if (act === "start") startGame();
  if (act === "begin") dispatch({ type: "MISSION_DONE" });
  if (act === "sim") setSim(!simOn);
  if (act === "plate") setPlate(Number(b.dataset.v));
});

function showResult(ok: boolean) {
  const v = game.verdict!;
  const el = $("#result");
  el.className = `result ${ok ? "win" : "lose"}`;
  el.innerHTML = `
    <svg viewBox="0 0 200 200" class="mark">${ok
      ? `<circle cx="100" cy="100" r="70" />`
      : `<path d="M45,45 L155,155" /><path d="M155,45 L45,155" />`}</svg>
    <div class="verdict title">${ok ? "SURVIVED!" : "BURNED!"}</div>
    <div class="detail">${Math.round(v.coverage * 100)}% of Dracula's footprint in shade (needs ${Math.round(RULES.coverageThreshold * 100)}%)${v.shieldCoverage !== undefined ? ` · shield shade ${Math.round(v.shieldCoverage * 100)}%` : ""}</div>`;
}

// ------------------------------------------------------------------ workshop panel

/** Replace innerHTML only when it changed, so elements (and clicks in progress) are not destroyed needlessly. */
function setHtml(el: Element | null, html: string) {
  if (el && el.innerHTML !== html) el.innerHTML = html;
}
const degOf = (r: number) => `${(Math.round((r * 180) / Math.PI) % 360 + 360) % 360}°`;

let workshopBuilt = false;
function renderWorkshopPanel(w: WorkshopLayer | null) {
  const el = $("#workshop-panel");
  if (!w) return;
  // Static skeleton: buttons are created once and only their state is updated (no lost clicks).
  if (!workshopBuilt) {
    workshopBuilt = true;
    el.innerHTML = `
      <div class="kicker">WORKSHOP DEMO MODE</div>
      <div class="wlevels">${LEVELS.map((lv, i) => `<button class="ghost" data-w="level" data-i="${i}">L${lv.id} map</button>`).join("")}</div>
      <h4>A · Zones</h4><div id="w-zones"></div>
      <div class="wbtns">
        <button class="ghost" data-w="draw">Draw polygon</button>
        <button class="ghost" data-w="close">Close (≥4)</button>
        <button class="ghost" data-w="clear">Clear</button>
        <button class="ghost" data-w="shadows">Shadow preview</button>
      </div>
      <h4>B · Position</h4><div id="w-pos"></div>
      <h4>C · Movement events</h4><div class="wlog" id="w-log"></div>
      <h4>D · Directionality</h4><div id="w-dir"></div>
      <p class="fine">Workshop mode shares the same tracking + geometry as the game. Shadows stay hidden unless “Shadow preview” is on; the game itself never shows them before Reveal.</p>`;
  }
  el.querySelectorAll<HTMLButtonElement>("[data-w=level]").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === game.levelIndex));
  const bDraw = el.querySelector<HTMLButtonElement>("[data-w=draw]")!;
  bDraw.classList.toggle("on", workshop.drawing);
  bDraw.textContent = workshop.drawing ? `Click board to add points (${workshop.customPoly.length})` : "Draw polygon";
  el.querySelector<HTMLButtonElement>("[data-w=close]")!.disabled = !(workshop.customPoly.length >= 4 && !workshop.customClosed);
  el.querySelector<HTMLButtonElement>("[data-w=shadows]")!.classList.toggle("on", workshop.previewShadows);

  const l = levelOf();
  const p = snap.dracula.pose;
  const shield = snap.shield.pose;
  const gaze = p && snap.dracula.status === "tracked" ? gazeRay(p, l.buildings) : null;
  const row = (label: string, value: string, on = false) => `<div class="wrow ${on ? "on" : ""}"><span>${label}</span><b>${value}</b></div>`;
  const [A, B] = l.buildings;
  setHtml(el.querySelector("#w-zones"), `
    ${row("1 Left / Right", w.half ?? "—", !!w.half)}
    ${row("2 Custom polygon", w.customClosed ? (w.customInside ? "INSIDE ⚠" : "outside") : workshop.drawing ? `drawing… ${w.customPoly.length} pts` : "not drawn", w.customInside)}
    ${row("3 Four-QR board zone", `${w.draculaInBoardZone ? "Dracula inside" : "Dracula outside"} · ${w.boardZoneCount} object(s)`, w.draculaInBoardZone)}
    ${row("4 Shadow zone", w.previewShadows ? (w.shadowZone ?? "—") : "preview off", w.shadowZone === "SAFE")}`);
  setHtml(el.querySelector("#w-pos"), `
    ${row(`1 vs ${A.name}`, w.sideOf ? `${w.sideOf.side}` : "—", !!w.sideOf && w.sideOf.side !== "ALIGNED")}
    ${B ? row(`2 Between ${A.name} & ${B.name}`, w.between?.yes ? "YES" : "no", !!w.between?.yes) : ""}
    ${row("3 Adjacent to", w.adjacent.length ? w.adjacent.map((b) => `${b.name} · ${b.displayHeightCategory} ${b.heightMeters} m`).join(", ") : "none", w.adjacent.length > 0)}`);
  setHtml(el.querySelector("#w-log"), eventsLog.length ? eventsLog.map((e) => `<div><time>${new Date(e.t).toLocaleTimeString()}</time> ${escapeHtml(e.message)}</div>`).join("") : "<em>Move Dracula into / out of a zone or toward a building…</em>");
  setHtml(el.querySelector("#w-dir"), `
    ${row("1 Dracula facing", p ? `${degOf(p.heading)} → ${gaze?.building ? `${gaze.building.name} (${gaze.building.heightMeters} m)` : "open sky"}` : "—", !!gaze?.building)}
    ${row("2 Shield aim", shield && snap.shield.status !== "lost" ? (w.shieldAim?.aimed ? "AIMED AT DRACULA" : `${degOf(shield.heading)} — not at Dracula`) : "shield not visible", !!w.shieldAim?.aimed)}`);
}

onPress($("#workshop-panel"), (b) => {
  const w = b.dataset.w;
  if (w === "draw") {
    workshop.drawing = !workshop.drawing;
    if (workshop.drawing && workshop.customClosed) {
      workshop.customPoly = [];
      workshop.customClosed = false;
    }
  }
  if (w === "close" && workshop.customPoly.length >= 4) {
    workshop.customClosed = true;
    workshop.drawing = false;
    toast("Custom polygon zone created: GARLIC MARKET", "ok");
  }
  if (w === "clear") {
    workshop.customPoly = [];
    workshop.customClosed = false;
  }
  if (w === "shadows") workshop.previewShadows = !workshop.previewShadows;
  if (w === "level") {
    game = { ...game, levelIndex: Number(b.dataset.i) };
    movement.reset();
  }
  store.set("customPoly", workshop.customPoly);
  store.set("customClosed", workshop.customClosed);
});

function setWorkshop(on: boolean) {
  workshopOn = on;
  $("#workshop-panel").classList.toggle("hidden", !on);
  $("#game-panel").classList.toggle("hidden", on);
  $("#t-workshop").classList.toggle("on", on);
  if (on) {
    sfx.unlock();
    voice.unlock();
  }
  movement.reset();
  lastPanelKey = "";
  renderCard();
}

// ------------------------------------------------------------------ debug panel

let debugBuilt = false;
function renderDebug(l: Level, sun: SunInfo) {
  const el = $("#debug");
  if (!debugBuilt) {
    debugBuilt = true;
    el.innerHTML = `
      <div class="dbg-head"><b>DEBUG</b><button class="ghost" data-d="close">✕</button></div>
      <div id="d-top"></div>
      <div class="dbg-btns"><button class="ghost" data-d="rot">Rotate corners</button><button class="ghost" data-d="mode">Mode</button><button class="ghost" data-d="reset">Reset tracking</button></div>
      <canvas id="dbg-cam" class="dbg-cam"></canvas>
      <div class="dbg-sec"><b>Offsets</b>
        Dracula contact fwd <input type="number" step="0.1" data-d="dfwd" value="${pipeline.dracula.offsets.forward}"/> right <input type="number" step="0.1" data-d="dright" value="${pipeline.dracula.offsets.right}"/> (marker units) ·
        shield wall offset <input type="number" step="0.05" data-d="wall" value="${shieldWallOffset}"/></div>
      <div id="d-rest"></div>`;
  }
  el.querySelector<HTMLButtonElement>("[data-d=rot]")!.textContent = `Rotate corners (${pipeline.calOptions.cornerOffset})`;
  el.querySelector<HTMLButtonElement>("[data-d=mode]")!.textContent = `Mode: ${pipeline.calOptions.mode}`;
  const s = snap;
  const cal = s.calibration;
  const f = s.lastFrame;
  const pt = (p?: Vec2 | null) => (p ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}` : "—");
  const obj = (o: typeof s.dracula) => `${o.status} · pos ${pt(o.pose?.position)} · raw ${pt(o.raw?.position)} · hdg ${o.pose ? degOf(o.pose.heading) : "—"} · conf ${(o.confidence * 100).toFixed(0)}% · stable ${o.stable} · marker ${o.markerSizeMeters.toFixed(1)} m`;
  const markers = f?.markers.map((m) => {
    const w = s.lastGoodCalibration?.H ? applyHomography(s.lastGoodCalibration.H, m.center) : null;
    return `<tr><td>${escapeHtml(m.payload)}</td><td>${m.center.x.toFixed(0)},${m.center.y.toFixed(0)}</td><td>${m.rotationRadians !== undefined ? degOf(m.rotationRadians) : "—"}</td><td>${pt(w)}</td><td class="mono">${m.corners.map((c) => `${c.x.toFixed(0)},${c.y.toFixed(0)}`).join(" ")}</td></tr>`;
  }).join("") ?? "";
  const shadows = game.verdict?.shadows.map((sh) => `${sh.sourceId}: ${sh.poly.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`).join("<br/>") ?? "(after READY)";
  setHtml(el.querySelector("#d-top"), `
    <div class="dbg-sec"><b>Game</b> ${game.phase} · level ${l.id} · attempts ${game.attempts}${workshopOn ? " · WORKSHOP" : ""}</div>
    <div class="dbg-sec"><b>Connection</b> ws ${sock.state} · cameras ${cameras} · rtt ${sock.rtt.toFixed(0)} ms · session ${sessionCode}</div>
    <div class="dbg-sec"><b>Frames</b> ${s.decoder ?? "—"} · ${s.fps.toFixed(1)} fps · age ${isFinite(s.frameAge) ? s.frameAge.toFixed(0) + " ms" : "—"} · decode ${f?.decodeMs?.toFixed(0) ?? "—"} ms · seq ${f?.seq ?? "—"} · ${f ? `${f.frameWidth}×${f.frameHeight}` : ""} · unknown QR ${s.unknownMarkers}</div>
    <div class="dbg-sec"><b>Calibration</b> ${cal?.ok ? "OK" : cal?.reason ?? "—"} · anchors ${cal?.anchorCount ?? 0} · ${cal?.orientationSource ?? ""} · mirrored ${cal?.mirrored ?? "—"} · ambiguous ${cal?.ambiguous ?? "—"} · reproj ${cal?.reprojErrorMeters?.toFixed(2) ?? "—"} m · held age ${isFinite(s.calibrationAge) ? (s.calibrationAge / 1000).toFixed(1) + " s" : "—"}</div>`);
  setHtml(el.querySelector("#d-rest"), `
    <div class="dbg-sec"><b>Markers (camera px → world m)</b><table><tr><th>payload</th><th>center px</th><th>rot</th><th>world</th><th>corners</th></tr>${markers}</table></div>
    <div class="dbg-sec"><b>Dracula</b> ${obj(s.dracula)}</div>
    <div class="dbg-sec"><b>Shield</b> ${obj(s.shield)}</div>
    <div class="dbg-sec"><b>Sun</b> az ${sun.azimuthDeg.toFixed(1)}° (${compassName(sun.azimuthDeg)}) · alt ${sun.altitudeDeg.toFixed(1)}° · shadow ×${sun.shadowFactor.toFixed(2)} · UTC ${sun.utc.toISOString()}</div>
    <div class="dbg-sec"><b>Verdict</b> ${game.verdict ? `safe ${game.verdict.safe} · coverage ${(game.verdict.coverage * 100).toFixed(1)}% · problems ${game.verdict.problems.join(",") || "none"}` : "—"}</div>
    <div class="dbg-sec mono"><b>Shadow polygons</b><br/>${shadows}</div>
    <div class="dbg-sec"><b>Workshop events</b> ${eventsLog.slice(0, 5).map((e) => escapeHtml(e.message)).join(" · ") || "—"}</div>`);
  drawDebugCamera();
}

function drawDebugCamera() {
  const c = document.querySelector<HTMLCanvasElement>("#dbg-cam");
  const f = snap.lastFrame;
  if (!c || !f) return;
  const w = c.clientWidth || 300;
  const h = Math.round((w * f.frameHeight) / f.frameWidth);
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const k = w / f.frameWidth;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  for (const m of f.markers) {
    g.strokeStyle = m.payload.startsWith("zone") ? "#7fe7ff" : m.payload.includes("dracula") ? "#ff5a6a" : "#ffb547";
    g.beginPath();
    m.corners.forEach((p, i) => (i ? g.lineTo(p.x * k, p.y * k) : g.moveTo(p.x * k, p.y * k)));
    g.closePath();
    g.stroke();
  }
  const q = snap.calibration?.imageQuad;
  if (q) {
    g.strokeStyle = snap.calibration?.ok ? "#3ddc84" : "#e5484d";
    g.beginPath();
    q.forEach((p, i) => (i ? g.lineTo(p.x * k, p.y * k) : g.moveTo(p.x * k, p.y * k)));
    g.closePath();
    g.stroke();
  }
}

onPress($("#debug"), (b) => {
  const d = b.dataset.d;
  if (d === "close") setDebug(false);
  if (d === "rot") pipeline.calOptions = { mode: "image", cornerOffset: (pipeline.calOptions.cornerOffset + 1) % 4 };
  if (d === "mode") pipeline.calOptions = { mode: pipeline.calOptions.mode === "auto" ? "image" : "auto", cornerOffset: 0 };
  if (d === "reset") pipeline.reset();
  store.set("calOptions", pipeline.calOptions);
});
$("#debug").addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  const v = Number(t.value);
  if (!Number.isFinite(v)) return;
  if (t.dataset.d === "dfwd") pipeline.dracula.offsets.forward = v;
  if (t.dataset.d === "dright") pipeline.dracula.offsets.right = v;
  if (t.dataset.d === "wall") shieldWallOffset = v;
  store.set("draculaOffsets", pipeline.dracula.offsets);
  store.set("shieldWallOffset", shieldWallOffset);
});

function setDebug(on: boolean) {
  debugOn = on;
  $("#debug").classList.toggle("hidden", !on);
  $("#t-debug").classList.toggle("on", on);
}


// ------------------------------------------------------------------ input: simulator + polygon drawing

canvas.addEventListener("pointerdown", (e) => {
  const w = toWorld(view, e.offsetX, e.offsetY);
  if (workshopOn && workshop.drawing) {
    workshop.customPoly.push(w);
    sfx.play("tick");
    return;
  }
  if (!simOn) return;
  const dd = dist(w, sim.dracula.position);
  const ds = dist(w, sim.shield.position);
  const shieldAvail = levelOf().usesShield || workshopOn;
  sim.selected = shieldAvail && ds < dd && ds < 30 ? "shield" : "dracula";
  sim.dragging = true;
  sim[sim.selected].position = w;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!simOn || !sim.dragging) return;
  sim[sim.selected].position = toWorld(view, e.offsetX, e.offsetY);
});
canvas.addEventListener("pointerup", () => (sim.dragging = false));
canvas.addEventListener("dblclick", () => {
  if (workshopOn && workshop.drawing && workshop.customPoly.length >= 4) {
    workshop.customClosed = true;
    workshop.drawing = false;
  }
});
canvas.addEventListener("wheel", (e) => {
  if (!simOn) return;
  e.preventDefault();
  const o = sim[sim.selected];
  o.heading = wrapAngle(o.heading + Math.sign(e.deltaY) * (Math.PI / 36));
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "d") setDebug(!debugOn);
  else if (k === "w") setWorkshop(!workshopOn);
  else if (k === "s") setSim(!simOn);
  else if (k === "m") toggleMute();
  else if (k === "f") toggleFull();
  else if (simOn && (k === "q" || k === "e")) sim[sim.selected].heading = wrapAngle(sim[sim.selected].heading + (k === "e" ? 1 : -1) * (Math.PI / 24));
  else if (simOn && k === "1") sim.selected = "dracula";
  else if (simOn && k === "2") sim.selected = "shield";
  else if (simOn && k === "h") {
    if (sim.selected === "dracula") sim.showDracula = !sim.showDracula;
    else sim.showShield = !sim.showShield;
  } else if (k === " " || k === "enter") {
    e.preventDefault();
    if (game.phase === "PREDICTION") pressReady();
    else if (game.phase === "MISSION") dispatch({ type: "MISSION_DONE" });
    else if (game.phase === "READY") dispatch({ type: "REVEAL" });
    else if (game.phase === "SUCCESS" || game.phase === "FAILURE") dispatch({ type: game.phase === "SUCCESS" ? "NEXT" : "RETRY" });
    else if (game.phase === "SETUP" || game.phase === "CALIBRATION" || game.phase === "GAME_COMPLETE") startGame();
  }
});

function toggleMute() {
  voice.setMuted(!voice.muted);
  sfx.muted = voice.muted;
  store.set("muted", voice.muted);
  renderPanel();
}
function toggleFull() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
}

$("#t-mute").onclick = toggleMute;
$("#t-workshop").onclick = () => setWorkshop(!workshopOn);
$("#t-sim").onclick = () => setSim(!simOn);
$("#t-debug").onclick = () => setDebug(!debugOn);
$("#t-full").onclick = toggleFull;
document.addEventListener("fullscreenchange", () => setTimeout(layout, 50));

// ------------------------------------------------------------------ toasts / util

function toast(text: string, kind: "ok" | "bad" | "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").prepend(el);
  setTimeout(() => el.classList.add("out"), 2600);
  setTimeout(() => el.remove(), 3100);
  while ($("#toasts").children.length > 4) $("#toasts").lastElementChild?.remove();
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

let statusQueued = false;
function updateStatusSoon() {
  if (statusQueued) return;
  statusQueued = true;
  requestAnimationFrame(() => {
    statusQueued = false;
    renderPanel();
  });
}

// ------------------------------------------------------------------ boot

// Pick up new builds automatically, but never in the middle of a reveal/result.
autoReloadOnNewBuild(() => !["READY", "REVEAL", "SUCCESS", "FAILURE"].includes(game.phase));

if (simOn) setSim(true);
if (workshopOn) setWorkshop(true);
setDebug(debugOn);
renderPanel();
renderCard();
requestAnimationFrame(frame);
