import { classifyPayload } from "./boardLayout.ts";
import { calibrate, markerWorldPose, type CalibrationOptions, type CalibrationResult, DEFAULT_CALIBRATION_OPTIONS } from "./calibration.ts";
import { add, bearingToVec, centroid, dist, scale, vecToBearing } from "./geometry.ts";
import type { DecoderName, MarkerDetection, Pose, TrackingFrame, TrackStatus, Vec2 } from "./types.ts";

export const TRACKING = {
  /** Frames older than this are "held" (last known position, ghosted). */
  freshMs: 1000, // phone scans ~4–10 fps; tolerate a few missed frames before "held"
  /** After this the object is "lost". */
  holdMs: 2500,
  /** Jumps larger than this are not applied until confirmed (prevents teleporting). */
  teleportMeters: 45,
  /** Jumps larger than this (but below teleport) are held back one frame until a second frame agrees (glitch filter). */
  glitchMeters: 10,
  confirmFrames: 2,
  /** Stability window used by READY. */
  stableWindowMs: 1000,
  /** Inliers must lie within this distance (m) of the median position (~0.5 cm on a 13" screen). */
  stableMaxDeviation: 6,
  stableMinSamples: 3,
  /** Share of samples in the window that must be inliers (tolerates a few jittery / glitch frames). */
  stableInlierRatio: 0.7,
  /** Calibration may be "held" while a hand covers an anchor, but READY needs it this fresh. */
  calibrationFreshMs: 5000,
};

export interface ObjectOffsets {
  /** Contact-point offset from QR center in marker-side units (forward along facing, right). */
  forward: number;
  right: number;
}

interface Sample {
  t: number;
  p: Vec2;
}

export interface ObjectTrackState {
  id: "dracula" | "shield";
  status: TrackStatus;
  pose: Pose | null;
  /** Raw (unsmoothed) world pose of the last accepted detection. */
  raw: Pose | null;
  markerSizeMeters: number;
  lastSeen: number;
  /** 0..1 fraction of recent frames that contained this marker. */
  confidence: number;
  stable: boolean;
  history: Sample[];
}

/**
 * Time windows scaled to the phone's ACTUAL frame interval. A slow phone (e.g. 1–2 fps while decoding) must not be
 * judged by windows tuned for 10 fps: "fresh" needs a couple of frames, "stable" needs >= 3 samples.
 */
export function adaptiveWindows(frameIntervalMs: number) {
  const iv = Number.isFinite(frameIntervalMs) && frameIntervalMs > 0 ? frameIntervalMs : 100;
  const freshMs = Math.min(5000, Math.max(TRACKING.freshMs, iv * 2.5));
  return {
    freshMs,
    holdMs: Math.max(TRACKING.holdMs, freshMs + 1500),
    stableWindowMs: Math.min(8000, Math.max(TRACKING.stableWindowMs, iv * 4.5)), // >= 3 samples even if READY lands between frames
    frameStaleMs: Math.min(6000, Math.max(1500, iv * 3)),
  };
}

export class ObjectTracker {
  readonly id: "dracula" | "shield";
  /** Set by the pipeline from the measured frame interval. */
  freshMs = TRACKING.freshMs;
  holdMs = TRACKING.holdMs;
  stableWindowMs = TRACKING.stableWindowMs;
  pose: Pose | null = null;
  raw: Pose | null = null;
  markerSizeMeters = 0;
  lastSeen = 0;
  rawAt = 0;
  private acquiring = 0;
  private candidate: { p: Vec2; n: number } | null = null;
  private seenFlags: { t: number; seen: boolean }[] = [];
  history: Sample[] = [];
  offsets: ObjectOffsets = { forward: 0, right: 0 };

  constructor(id: "dracula" | "shield") {
    this.id = id;
  }

  reset() {
    this.pose = null;
    this.raw = null;
    this.lastSeen = 0;
    this.acquiring = 0;
    this.candidate = null;
    this.history = [];
    this.seenFlags = [];
  }

  /** Feed one frame's measurement (or null if the marker was not in this frame). */
  update(meas: { center: Vec2; heading: number; size: number } | null, now: number) {
    this.seenFlags.push({ t: now, seen: !!meas });
    this.seenFlags = this.seenFlags.filter((f) => now - f.t < 1000);
    if (!meas) return;

    const f = bearingToVec(meas.heading);
    const r = { x: -f.y, y: f.x };
    const contact = add(meas.center, add(scale(f, this.offsets.forward * meas.size), scale(r, this.offsets.right * meas.size)));
    const rawPose: Pose = { position: contact, heading: meas.heading };
    this.raw = rawPose; // latest measurement, even if not (yet) trusted for the smoothed pose
    this.rawAt = now;

    const stale = !this.pose || now - this.lastSeen > this.holdMs;
    if (stale) {
      // (Re)acquire: need consecutive agreeing detections before showing anything.
      if (this.candidate && dist(this.candidate.p, contact) < 15) this.candidate.n++;
      else this.candidate = { p: contact, n: 1 };
      this.acquiring = this.candidate.n;
      this.lastSeen = now;
      this.markerSizeMeters = meas.size;
      this.raw = rawPose;
      if (this.candidate.n >= TRACKING.confirmFrames) {
        this.pose = rawPose;
        this.candidate = null;
        this.history = [{ t: now, p: contact }];
      } else {
        this.pose = null;
      }
      return;
    }

    const prev = this.pose!;
    const jump = dist(prev.position, contact);
    if (jump > TRACKING.glitchMeters && jump <= TRACKING.teleportMeters) {
      // Single-frame glitch filter: apply only when the next frame lands near the same place.
      const agrees = this.candidate && dist(this.candidate.p, contact) < 8;
      if (!agrees) {
        this.candidate = { p: contact, n: 1 };
        this.lastSeen = now; // the marker WAS seen; just not trusted yet
        return;
      }
    }
    if (jump > TRACKING.teleportMeters) {
      // Don't teleport: only accept a big jump after it is confirmed by consecutive frames.
      if (this.candidate && dist(this.candidate.p, contact) < 15) this.candidate.n++;
      else this.candidate = { p: contact, n: 1 };
      if (this.candidate.n < TRACKING.confirmFrames) return;
      this.candidate = null;
      this.pose = rawPose;
    } else {
      this.candidate = null;
      // Adaptive EMA: heavy smoothing for jitter, light smoothing for real motion.
      const alpha = jump < 1.5 ? 0.3 : jump < 6 ? 0.55 : 0.8;
      const pf = bearingToVec(prev.heading);
      const blended = add(scale(pf, 1 - alpha), scale(f, alpha));
      this.pose = {
        position: add(scale(prev.position, 1 - alpha), scale(contact, alpha)),
        heading: vecToBearing(blended),
      };
    }
    this.raw = rawPose;
    this.markerSizeMeters = this.markerSizeMeters ? this.markerSizeMeters * 0.8 + meas.size * 0.2 : meas.size;
    this.lastSeen = now;
    this.history.push({ t: now, p: this.pose.position });
    this.history = this.history.filter((s) => now - s.t < Math.max(4000, this.stableWindowMs + 1000));
  }

  status(now: number): TrackStatus {
    if (!this.pose) return this.acquiring > 0 && now - this.lastSeen < this.holdMs ? "acquiring" : this.lastSeen ? "lost" : "none";
    const age = now - this.lastSeen;
    if (age < this.freshMs) return "tracked";
    if (age < this.holdMs) return "held";
    return "lost";
  }

  confidence(): number {
    if (!this.seenFlags.length) return 0;
    return this.seenFlags.filter((f) => f.seen).length / this.seenFlags.length;
  }

  /** Mean position over the stability window, or null if not stable / not fresh. */
  stablePosition(now: number): Vec2 | null {
    if (this.status(now) !== "tracked") return null;
    const p = robustStablePosition(this.history, now, this.stableWindowMs);
    // The newest measurement must agree too: otherwise the token was just moved and history is stale.
    if (!p || !this.raw || dist(this.raw.position, p) > TRACKING.stableMaxDeviation * 1.5) return null;
    return p;
  }

  snapshot(now: number): ObjectTrackState {
    const status = this.status(now);
    return {
      id: this.id,
      status,
      pose: status === "lost" ? null : this.pose,
      raw: this.raw,
      markerSizeMeters: this.markerSizeMeters,
      lastSeen: this.lastSeen,
      confidence: this.confidence(),
      stable: this.stablePosition(now) !== null,
      history: this.history,
    };
  }
}

/**
 * Robust "is the object resting here?" test: median of the recent samples, then the mean of the inliers within
 * stableMaxDeviation. Accepts if >= stableInlierRatio of the samples agree. Handheld-camera jitter and the odd
 * glitch frame no longer block READY, but a token that is actually being moved still does.
 */
export function robustStablePosition(history: { t: number; p: Vec2 }[], now: number, windowMs = TRACKING.stableWindowMs): Vec2 | null {
  const win = history.filter((s) => now - s.t <= windowMs);
  if (win.length < TRACKING.stableMinSamples) return null;
  const med = (v: number[]) => {
    const a = [...v].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const m = { x: med(win.map((s) => s.p.x)), y: med(win.map((s) => s.p.y)) };
  const inliers = win.filter((s) => dist(s.p, m) <= TRACKING.stableMaxDeviation);
  if (inliers.length < Math.max(TRACKING.stableMinSamples, Math.ceil(win.length * TRACKING.stableInlierRatio))) return null;
  return centroid(inliers.map((s) => s.p));
}

export interface PipelineSnapshot {
  calibration: CalibrationResult | null;
  /** Last successful calibration (held while an anchor is briefly covered). */
  lastGoodCalibration: CalibrationResult | null;
  calibrationAge: number;
  calibrationFresh: boolean;
  dracula: ObjectTrackState;
  shield: ObjectTrackState;
  frameAge: number;
  lastFrame: TrackingFrame | null;
  decoder: DecoderName | null;
  fps: number;
  /** Median interval between camera frames (ms); drives the adaptive time windows. */
  frameIntervalMs: number;
  unknownMarkers: number;
  simulated: boolean;
}

/** Frame -> calibration -> world poses -> smoothed object tracks. Same code for real and simulated frames. */
export class TrackingPipeline {
  calOptions: CalibrationOptions = { ...DEFAULT_CALIBRATION_OPTIONS };
  dracula = new ObjectTracker("dracula");
  shield = new ObjectTracker("shield");
  private calibration: CalibrationResult | null = null;
  private lastGood: CalibrationResult | null = null;
  private lastGoodAt = 0;
  private lastFrame: TrackingFrame | null = null;
  private lastFrameAt = 0;
  private frameTimes: number[] = [];
  private unknown = 0;

  ingest(frame: TrackingFrame, now = Date.now()) {
    this.lastFrame = frame;
    this.lastFrameAt = now;
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter((t) => now - t < 8000);
    const w = adaptiveWindows(this.frameInterval());
    for (const tr of [this.dracula, this.shield]) {
      tr.freshMs = w.freshMs;
      tr.holdMs = w.holdMs;
      tr.stableWindowMs = w.stableWindowMs;
    }
    this.unknown = frame.markers.filter((m) => classifyPayload(m.payload) === "unknown").length;

    const cal = calibrate(frame.markers, this.calOptions);
    this.calibration = cal;
    if (cal.ok) {
      this.lastGood = cal;
      this.lastGoodAt = now;
    }
    const H = cal.ok ? cal.H! : this.lastGood && now - this.lastGoodAt < TRACKING.calibrationFreshMs * 4 ? this.lastGood.H! : null;

    const measure = (kind: "dracula" | "shield") => {
      if (!H) return null;
      const m = frame.markers.filter((d: MarkerDetection) => classifyPayload(d.payload) === kind);
      if (!m.length) return null;
      const w = markerWorldPose(H, m[0]);
      return { center: w.center, heading: w.heading, size: w.sizeMeters };
    };
    this.dracula.update(measure("dracula"), now);
    this.shield.update(measure("shield"), now);
  }

  /** Median interval between received frames (ms). */
  frameInterval(): number {
    const d: number[] = [];
    for (let i = 1; i < this.frameTimes.length; i++) d.push(this.frameTimes[i] - this.frameTimes[i - 1]);
    if (!d.length) return NaN;
    d.sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
  }

  snapshot(now = Date.now()): PipelineSnapshot {
    const calibrationAge = this.lastGood ? now - this.lastGoodAt : Infinity;
    return {
      calibration: this.calibration,
      lastGoodCalibration: this.lastGood,
      calibrationAge,
      calibrationFresh: calibrationAge < TRACKING.calibrationFreshMs,
      dracula: this.dracula.snapshot(now),
      shield: this.shield.snapshot(now),
      frameAge: this.lastFrame ? now - this.lastFrameAt : Infinity,
      lastFrame: this.lastFrame,
      decoder: this.lastFrame?.decoder ?? null,
      fps: this.frameTimes.filter((t) => now - t < 2000).length / 2,
      frameIntervalMs: this.frameInterval(),
      unknownMarkers: this.unknown,
      simulated: this.lastFrame?.decoder === "simulator",
    };
  }

  reset() {
    this.calibration = null;
    this.lastGood = null;
    this.lastFrame = null;
    this.dracula.reset();
    this.shield.reset();
  }
}
