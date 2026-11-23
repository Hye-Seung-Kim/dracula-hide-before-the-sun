import type { CalibrationOptions } from "../engine/calibration.ts";
import type { TrackingFrame, TrackStatus } from "../engine/types.ts";

/** Board -> phone: what the authoritative board currently sees (shown on the phone HUD). */
export interface BoardStatus {
  phase: string;
  level: number;
  calibrated: boolean;
  anchorCount: number;
  dracula: TrackStatus;
  shield: TrackStatus;
  calOptions: CalibrationOptions;
  usesShield: boolean;
  /** Dracula is fixed on the board this level: the phone only needs to find the shield. */
  draculaFixed?: boolean;
  message: string;
  /** Corner QR plate size (world m) currently drawn on the laptop; the phone must calibrate with the same value. */
  anchorPlate: number;
}

/** Board -> server: normalized world state, served read-only at GET /api/session/:code/state (for Procession/p5.js). */
export interface WorldObjectState {
  status: TrackStatus;
  /** World meters (board is 320 x 220, north = up) */
  x: number;
  y: number;
  /** Normalized 0..1 board coordinates (multiply by your canvas width/height) */
  nx: number;
  ny: number;
  /** Facing as a compass bearing, degrees (0 = north/up, 90 = east/right) */
  headingDeg: number;
}

export interface WorldState {
  code: string;
  anchorPlate: number;
  t: number;
  phase: string;
  level: number;
  calibrated: boolean;
  simulated: boolean;
  dracula: WorldObjectState | null;
  shield: WorldObjectState | null;
  /** Only present after Reveal (never leaks the answer during Prediction). */
  result: { safe: boolean; coverage: number; sunAzimuthDeg: number; sunAltitudeDeg: number } | null;
}

export type CameraCommand =
  | { type: "rotateCorners" }
  | { type: "setMode"; mode: "auto" | "image" }
  | { type: "resetCalibration" };

export interface ServerInfo {
  lanIps: string[];
  httpPort: number;
  httpsPort: number;
  /** Public HTTPS origin if the server was started with PUBLIC_URL (e.g. a cloudflared tunnel). */
  publicUrl: string | null;
}

export type ClientMsg =
  | { t: "host"; code?: string }
  | { t: "join"; code: string }
  | { t: "frame"; frame: TrackingFrame }
  | { t: "boardStatus"; status: BoardStatus }
  | { t: "cameraCmd"; cmd: CameraCommand }
  | { t: "worldState"; state: WorldState }
  | { t: "ping"; at: number };

export type ServerMsg =
  | { t: "hosted"; code: string; info: ServerInfo }
  | { t: "joined"; code: string }
  | { t: "error"; message: string }
  | { t: "peer"; board: boolean; cameras: number }
  | { t: "frame"; frame: TrackingFrame }
  | { t: "boardStatus"; status: BoardStatus }
  | { t: "cameraCmd"; cmd: CameraCommand }
  | { t: "requestSnapshot" }
  | { t: "pong"; at: number };

export const CODE_ALPHABET = "ACDEFHJKMNPRTUVWXY347";
export const CODE_LENGTH = 4;
export const normalizeCode = (c: string) => c.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
