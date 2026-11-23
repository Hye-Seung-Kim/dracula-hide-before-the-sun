/**
 * Game state machine. Pure reducer: (state, event) -> state. The board UI dispatches events;
 * audio and animation react to phase changes. The submitted placement is captured at PRESS_READY and
 * never re-read from live tracking afterwards, so moving Dracula after READY cannot change the result.
 */
import { LEVELS, type Level } from "./levels.ts";
import { checkPlacement, evaluatePlacement, PROBLEM_TEXT, type Verdict } from "./rules.ts";
import { adaptiveWindows, robustStablePosition, TRACKING, type PipelineSnapshot } from "./tracking.ts";
import type { Pose, Vec2 } from "./types.ts";

export type Phase =
  | "SETUP" | "CALIBRATION" | "MISSION" | "PREDICTION" | "READY" | "REVEAL" | "SUCCESS" | "FAILURE" | "LEVEL_TRANSITION" | "GAME_COMPLETE";

export interface Submission {
  dracula: Vec2;
  shield: { pose: Pose; markerSize: number } | null;
  at: number;
  simulated: boolean;
}

export interface GameState {
  phase: Phase;
  levelIndex: number;
  submission: Submission | null;
  verdict: Verdict | null;
  /** Why READY was refused (shown to the player). */
  blockers: string[];
  results: ("O" | "X" | null)[];
  attempts: number;
}

export type GameEvent =
  | { type: "SOURCE"; connected: boolean; calibrated: boolean; draculaSeen: boolean }
  | { type: "START" }
  | { type: "MISSION_DONE" }
  | { type: "PRESS_READY"; tracking: PipelineSnapshot; now: number }
  | { type: "REVEAL" }
  | { type: "REVEAL_DONE" }
  | { type: "NEXT" }
  | { type: "RETRY" }
  | { type: "TRANSITION_DONE" }
  | { type: "GOTO_LEVEL"; levelIndex: number }
  | { type: "RESTART" };

export const initialGameState = (): GameState => ({
  phase: "SETUP",
  levelIndex: 0,
  submission: null,
  verdict: null,
  blockers: [],
  results: LEVELS.map(() => null),
  attempts: 0,
});

export const currentLevel = (s: GameState): Level => LEVELS[s.levelIndex];

/** Everything that must be true before a placement can be accepted. Never auto-accepts on lost tracking. */
export function readyBlockers(level: Level, t: PipelineSnapshot, now: number): { blockers: string[]; submission: Submission | null } {
  const blockers: string[] = [];
  const win = adaptiveWindows(t.frameIntervalMs);
  if (!t.lastFrame || t.frameAge > win.frameStaleMs) blockers.push("No live camera frames — check the phone.");
  if (!t.calibrationFresh) blockers.push("Board not calibrated — all four corner QR codes must be visible.");
  let dPos: Vec2 | null;
  if (level.draculaFixed) {
    dPos = level.draculaFixed; // Dracula waits at a fixed spot: only the shield is tracked
  } else {
    dPos = t.dracula.status === "tracked" ? stablePos(t, "dracula", now) : null;
    if (t.dracula.status !== "tracked") blockers.push("Dracula's marker is not visible right now.");
    else if (!dPos) blockers.push("Hold Dracula still for a moment…");
  }
  let shield: Submission["shield"] = null;
  if (level.usesShield) {
    const sPose = t.shield.status === "tracked" ? stableShieldPose(t, now) : null;
    if (t.shield.status !== "tracked" || !t.shield.pose) blockers.push("The shield's marker is not visible right now.");
    else if (!sPose) blockers.push("Hold the shield still for a moment…");
    else shield = { pose: sPose, markerSize: t.shield.markerSizeMeters };
  }
  if (dPos) {
    for (const p of checkPlacement(level, dPos, shield)) {
      if (p === "SHIELD_MISSING" && blockers.some((b) => b.includes("shield"))) continue;
      blockers.push(PROBLEM_TEXT[p]);
    }
  }
  if (blockers.length || !dPos) return { blockers, submission: null };
  return { blockers: [], submission: { dracula: dPos, shield, at: now, simulated: t.simulated } };
}

/** Shield pose to submit: stable position (same robust test as Dracula) + the current smoothed heading. */
function stableShieldPose(t: PipelineSnapshot, now: number): Pose | null {
  const p = stablePos(t, "shield", now);
  return p && t.shield.pose ? { position: p, heading: t.shield.pose.heading } : null;
}

function stablePos(t: PipelineSnapshot, id: "dracula" | "shield", now: number): Vec2 | null {
  const st = t[id];
  const p = robustStablePosition(st.history, now, adaptiveWindows(t.frameIntervalMs).stableWindowMs);
  // Reject if the newest measurement is elsewhere (token just moved; history still shows the old spot).
  if (!p || !st.raw || Math.hypot(st.raw.position.x - p.x, st.raw.position.y - p.y) > TRACKING.stableMaxDeviation * 1.5) return null;
  return p;
}

export function gameReducer(s: GameState, e: GameEvent): GameState {
  switch (e.type) {
    case "SOURCE":
      if (s.phase === "SETUP" && e.connected) return { ...s, phase: "CALIBRATION" };
      if (s.phase === "CALIBRATION" && !e.connected) return { ...s, phase: "SETUP" };
      return s;
    case "START":
      if (s.phase === "SETUP" || s.phase === "CALIBRATION" || s.phase === "GAME_COMPLETE") {
        const fresh = s.phase === "GAME_COMPLETE" ? initialGameState() : s;
        return { ...fresh, phase: "MISSION", submission: null, verdict: null, blockers: [] };
      }
      return s;
    case "MISSION_DONE":
      return s.phase === "MISSION" ? { ...s, phase: "PREDICTION" } : s;
    case "PRESS_READY": {
      if (s.phase !== "PREDICTION") return s;
      const level = currentLevel(s);
      const { blockers, submission } = readyBlockers(level, e.tracking, e.now);
      if (!submission) return { ...s, blockers };
      const verdict = evaluatePlacement(level, submission.dracula, submission.shield);
      return { ...s, phase: "READY", submission, verdict, blockers: [], attempts: s.attempts + 1 };
    }
    case "REVEAL":
      return s.phase === "READY" ? { ...s, phase: "REVEAL" } : s;
    case "REVEAL_DONE": {
      if (s.phase !== "REVEAL" || !s.verdict) return s;
      const results = [...s.results];
      results[s.levelIndex] = s.verdict.safe ? "O" : "X";
      return { ...s, phase: s.verdict.safe ? "SUCCESS" : "FAILURE", results };
    }
    case "NEXT":
      if (s.phase !== "SUCCESS" && s.phase !== "FAILURE") return s;
      if (s.levelIndex >= LEVELS.length - 1) return { ...s, phase: "GAME_COMPLETE" };
      return { ...s, phase: "LEVEL_TRANSITION", levelIndex: s.levelIndex + 1, submission: null, verdict: null, blockers: [] };
    case "RETRY":
      if (s.phase !== "FAILURE" && s.phase !== "SUCCESS") return s;
      return { ...s, phase: "MISSION", submission: null, verdict: null, blockers: [] };
    case "TRANSITION_DONE":
      return s.phase === "LEVEL_TRANSITION" ? { ...s, phase: "MISSION" } : s;
    case "GOTO_LEVEL":
      return { ...s, phase: "MISSION", levelIndex: Math.max(0, Math.min(LEVELS.length - 1, e.levelIndex)), submission: null, verdict: null, blockers: [] };
    case "RESTART":
      return { ...initialGameState(), phase: "MISSION" };
  }
}
