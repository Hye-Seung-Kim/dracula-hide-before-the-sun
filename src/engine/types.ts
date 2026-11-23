// Shared data types for the tracking pipeline and game engine.
// World coordinates: meters on the city map. +x = EAST (screen right), +y = SOUTH (screen down).
// So NORTH is the top of the board, matching the on-screen compass.

export interface Vec2 {
  x: number;
  y: number;
}

/** One decoded QR instance in CAMERA PIXEL coordinates (phone frame). */
export interface MarkerDetection {
  payload: string;
  center: Vec2;
  /** Corners in the QR symbol's own orientation: [topLeft, topRight, bottomRight, bottomLeft]. */
  corners: Vec2[];
  /** Image-space rotation of the symbol's "up" direction, 0 = image up, clockwise positive. */
  rotationRadians?: number;
  timestamp: number;
}

export type DecoderName = "zxing-wasm" | "barcode-detector" | "jsqr-multipass" | "simulator";

/** One processed camera frame, sent phone -> laptop. Raw pixels only, never pre-normalized. */
export interface TrackingFrame {
  sessionId: string;
  frameWidth: number;
  frameHeight: number;
  markers: MarkerDetection[];
  timestamp: number;
  /** Which decoder produced the frame. "simulator" frames are always labelled as such on screen. */
  decoder: DecoderName;
  /** Milliseconds the phone spent decoding this frame. */
  decodeMs?: number;
  /** Monotonic counter from the sender, for dropped-frame diagnostics. */
  seq?: number;
}

export type CornerName = "TL" | "TR" | "BR" | "BL";

export type Homography = number[]; // 3x3 row-major, length 9

export interface Pose {
  position: Vec2;
  /** Compass bearing of the marker's facing direction in WORLD space, radians. 0 = north, PI/2 = east. */
  heading: number;
}

export type TrackStatus = "none" | "acquiring" | "tracked" | "held" | "lost";

export interface Building {
  id: string;
  name: string;
  footprint: Vec2[];
  heightMeters: number;
  displayHeightCategory: "LOW" | "MEDIUM" | "HIGH";
}
