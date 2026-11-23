import { BOARD_H, BOARD_W } from "./boardLayout.ts";
import { rectPoly } from "./geometry.ts";
import type { ShieldSpec } from "./shadows.ts";
import { NEW_YORK, type Place } from "./solar.ts";
import type { Building, Vec2 } from "./types.ts";

export interface Street {
  /** Polyline centre-line (world m) */
  path: Vec2[];
  width: number;
  name?: string;
}

export interface Level {
  id: 1 | 2 | 3;
  title: string;
  subtitle: string;
  place: Place;
  dateISO: string;
  /** Local wall-clock time in place.timeZone */
  time: string;
  timeLabel: string;
  buildings: Building[];
  streets: Street[];
  /** Decorative open areas (plaza, courtyard, park) */
  areas: { name: string; poly: Vec2[]; kind: "plaza" | "courtyard" | "park" }[];
  missionText: string;
  voice: { mission: string; success: string; failure: string; intro?: string };
  usesShield: boolean;
  shield?: ShieldSpec;
  /** Level 3: Dracula must stand inside this zone. */
  destination?: { name: string; center: Vec2; radius: number };
  /**
   * If set, Dracula stands here for the whole level (no Dracula marker needed). Level 3: he waits at the fountain and
   * only the physical SHIELD is tracked — fewer markers = faster, more reliable recognition.
   */
  draculaFixed?: Vec2;
  /** Known solution, used by tests to prove the level is solvable. */
  referenceSolution: { dracula: Vec2; shield?: { position: Vec2; heading: number } };
}

const b = (id: string, name: string, x: number, y: number, w: number, h: number, heightMeters: number): Building => ({
  id,
  name,
  footprint: rectPoly(x, y, w, h),
  heightMeters,
  displayHeightCategory: heightMeters >= 55 ? "HIGH" : heightMeters >= 25 ? "MEDIUM" : "LOW",
});

const H = (y: number, x0 = 0, x1 = BOARD_W) => [{ x: x0, y }, { x: x1, y }];
const V = (x: number, y0 = 0, y1 = BOARD_H) => [{ x, y: y0 }, { x, y: y1 }];

export const LEVELS: Level[] = [
  {
    id: 1,
    title: "The First Hiding Spot",
    subtitle: "FIND THE SHADOW",
    place: NEW_YORK,
    dateISO: "2026-06-21",
    time: "17:00",
    timeLabel: "5:00 PM",
    buildings: [
      b("tower", "Empire Needle", 72, 40, 38, 40, 80),
      b("hall", "Brick Hall", 74, 132, 50, 34, 35),
      b("deli", "Corner Deli", 210, 118, 34, 28, 12),
    ],
    streets: [
      { path: H(104), width: 22, name: "W 34th St" },
      { path: V(150, 0, BOARD_H), width: 22, name: "5th Ave" },
      { path: H(184, 60, 260), width: 14 },
      { path: V(256, 60, 220), width: 12 },
    ],
    areas: [{ name: "Bryant Lawn", poly: rectPoly(170, 30, 70, 50), kind: "park" }],
    missionText: "It's a summer afternoon in New York. Study the clock, the compass and the building heights. Move Dracula where you think the shadows will fall, then press READY.",
    voice: {
      mission: "Dracula! The sun is coming. Find somewhere to hide! You're in New York. It's five PM. Where should Dracula hide?",
      success: "Phew! You saved me!",
      failure: "Nooo! I'm burning!",
    },
    usesShield: false,
    referenceSolution: { dracula: { x: 150, y: 60 } },
  },
  {
    id: 2,
    title: "The Wrong Side of the Street",
    subtitle: "TRICKY SHADOWS",
    place: NEW_YORK,
    dateISO: "2026-06-21",
    time: "10:30",
    timeLabel: "10:30 AM",
    buildings: [
      b("harbor", "Harbor Tower", 148, 62, 40, 38, 62),
      b("gallery", "Gallery Lofts", 202, 62, 42, 38, 30),
      b("rows", "Row Houses", 120, 114, 22, 56, 15),
      b("water", "Water Tower Flats", 194, 114, 50, 56, 40),
    ],
    streets: [
      { path: H(107, 60, 260), width: 14, name: "Bleecker St" },
      { path: V(195, 20, 107), width: 14, name: "Mercer St" },
      { path: V(134, 20, 107), width: 14 },
      { path: H(184, 60, 260), width: 12 },
    ],
    areas: [{ name: "Courtyard", poly: rectPoly(142, 114, 52, 56), kind: "courtyard" }],
    missionText: "Same summer, but now it's late morning. The streets are narrow and the courtyard looks cosy... but which side of each building is really in shade?",
    voice: {
      mission: "It's ten thirty in the morning. Careful! Some shadows are not where they look. Where should Dracula hide?",
      success: "You found the perfect shadow!",
      failure: "Wrong side! I'm turning into toast!",
    },
    usesShield: false,
    referenceSolution: { dracula: { x: 136, y: 76 } },
  },
  {
    id: 3,
    title: "Nowhere to Hide",
    subtitle: "MAKE YOUR OWN SHADE",
    place: NEW_YORK,
    dateISO: "2026-06-21",
    time: "12:30",
    timeLabel: "12:30 PM",
    buildings: [
      b("kiosk", "Ticket Kiosk", 76, 66, 26, 22, 10),
      b("cafe", "Plaza Cafe", 222, 64, 30, 24, 14),
      b("library", "Little Library", 74, 150, 34, 22, 12),
      b("station", "Subway Entrance", 220, 150, 28, 20, 8),
    ],
    streets: [
      { path: H(18, 60, 260), width: 14 },
      { path: H(202, 60, 260), width: 14 },
    ],
    areas: [{ name: "Fountain Plaza", poly: rectPoly(62, 40, 196, 140), kind: "plaza" }],
    missionText: "High noon over a wide-open plaza. Dracula is stuck at the fountain in the middle — and there is no shade there. Only the SHIELD moves this time: place and turn it so its shadow covers him, then press READY.",
    voice: {
      intro: "Oh no! There's nowhere to hide! Build me some shade!",
      mission: "It's twelve thirty. I'm stuck at the fountain. Use the shield to make me some shade!",
      success: "You made your own shade! Brilliant!",
      failure: "The shield is on the wrong side!",
    },
    usesShield: true,
    shield: { widthMeters: 44, heightMeters: 80, wallOffsetMarkerUnits: 0.75 },
    destination: { name: "Fountain Plaza", center: { x: 160, y: 112 }, radius: 28 },
    draculaFixed: { x: 160, y: 112 },
    // Shield south-south-east of Dracula (toward the sun, bearing ~159 deg), facing him (heading ~339 deg).
    // Marker 40 m from Dracula (toward the sun) -> wall 16 m from his centre: room for a ~2 cm-wide figurine.
    referenceSolution: { dracula: { x: 160, y: 112 }, shield: { position: { x: 174.3, y: 149.4 }, heading: (339 * Math.PI) / 180 } },
  },
];
