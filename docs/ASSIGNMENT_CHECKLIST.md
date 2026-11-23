# Assignment checklist

**Status legend**
- **TESTED**: covered by automated tests (`npm test`, 71 tests).
- **BROWSER-VERIFIED**: exercised in Chrome on the laptop board with the mouse simulator. The simulator emits real
  camera-pixel TrackingFrames through the same calibration/tracking/game code.
- **NEEDS DEVICE TEST**: depends on the real phone camera, lighting and printed markers. It has *not* been run on a
  physical phone yet. Confirm it during your hardware session before you claim it.

Open the workshop demo with `http://localhost:5173/board?workshop=1` (add `&sim=1` to rehearse with the mouse).
For the real demo, use the phone camera and the physical Dracula/Shield.

## Core system

| Requirement | Implemented behavior | How to demonstrate | Capture | Status |
| --- | --- | --- | --- | --- |
| Laptop board with 4 QR anchors + city map | `/board`: 4 × `zone:dracula-board` anchors on white plates in the corners, map, buildings with LOW/MEDIUM/HIGH + metres, compass, clock | Open the board fullscreen | Screenshot of the full board | BROWSER-VERIFIED |
| Phone camera companion | `/camera`: rear camera, session code, Start/Stop, connection chip, QR count, corners x/4, Dracula/Shield seen, fps, decode ms, CALIBRATED, board polygon overlay | Phone mounted above the laptop | Phone screen recording | Page BROWSER-VERIFIED; camera NEEDS DEVICE TEST |
| Multiple QRs per frame, identical payloads kept separate | ZXing-WASM `maxNumberOfSymbols:16`; tested on rendered perspective/rotated/blurred/noisy frames with 4 identical anchors + Dracula + Shield | Phone HUD shows `QR seen 5–6`, `Corners 4/4` | Phone screenshot | TESTED (rendered pixels); NEEDS DEVICE TEST |
| Phone → laptop sync | WSS relay with 4-letter session code; auto-reconnect; laptop reload keeps the code | Move Dracula; the board updates | Side-by-side video | TESTED (server e2e); NEEDS DEVICE TEST |
| Four-QR calibration + homography | Orientation from the anchors' QR corners, clockwise ordering, 16-corner verification, manual "Rotate corners" fallback, mirror detection | Rotate the phone 90°/180°: still calibrated | Phone overlay with TL/TR/BR/BL labels | TESTED (0°, 37°, 90°, 145°, 180°, 270°, −60°, keystone) |
| Physical Dracula tracking | World pose + heading, smoothing, no-teleport gate, held/lost states, confidence | Slide the token around | Video | TESTED + BROWSER-VERIFIED (sim); NEEDS DEVICE TEST |
| Hidden sun before Reveal | Compass shows "?", no shadows, no verdict until REVEAL | Prediction phase | Screenshot | BROWSER-VERIFIED |
| Real solar geometry | SunCalc 2.1.4 (degrees, north-based azimuth, verified), DST-aware time zones | Debug panel shows az/alt | Screenshot | TESTED |
| Shadows from height + footprint | Convex prism shadows, length = h / tan(alt), away from the sun | Reveal | Screenshot of reveal | TESTED + BROWSER-VERIFIED |
| O / X verdict | ≥ 75% of a 7 m footprint (−1 m tolerance) in shade; rooftop / off-map refused | Levels 1–3 | Video of O and X | TESTED + BROWSER-VERIFIED |
| Voice + SFX + subtitles + mute | Web Speech lines on events only; synthesized SFX; subtitles; 🔊 button / M | Play a level with sound | Video with audio | Subtitles BROWSER-VERIFIED (muted); **audio output NEEDS DEVICE TEST** on your laptop speakers |
| Three levels | L1 5:00 PM (sun W 270°, alt 37°), L2 10:30 AM (ESE 108°, alt 55°), L3 12:30 PM (SSE 159°, alt 72°) + shield | Play through | Game footage L1→L3 | TESTED (each solvable + trap spots) + BROWSER-VERIFIED (O on all three) |
| Level 3 physical shield | Shield QR → wall segment → simulated shadow; READY requires the shield to be tracked | Place the shield south-southeast of Dracula | Video | TESTED + BROWSER-VERIFIED (sim); NEEDS DEVICE TEST |
| Moving after READY can't change the result | Placement snapshot at READY | Move Dracula during reveal | Video | TESTED + BROWSER-VERIFIED |
| No success when tracking fails | READY refused without live frames / calibration / visible marker | Cover the marker, press READY | Screenshot of warning | TESTED |

## A. Basic zones (Workshop mode, panel section A)

| # | Requirement | Implemented behavior | How to demonstrate | Capture | Status |
| --- | --- | --- | --- | --- | --- |
| A1 | Left / Right zones | Board split at x = 160 m with 3 m hysteresis; the active half is tinted; ENTER/EXIT events with sound | Slide Dracula across the centre line | Screenshot each side | TESTED + BROWSER-VERIFIED |
| A2 | Custom polygon zone | *Draw polygon* → click ≥ 4 points → *Close*. Becomes "GARLIC MARKET" (restricted); entry → red fill, warning toast, sound, Dracula says "Garlic! Get me out of here!" | Draw around a building, walk Dracula in | Screenshot of the drawn zone + warning | TESTED + BROWSER-VERIFIED |
| A3 | Four-QR zone | Polygon through the four anchor centres (clockwise); "objects inside: N" count; Dracula inside/outside | Move Dracula to a corner outside the dashed cyan polygon | Screenshot | TESTED + BROWSER-VERIFIED. Also shown live on the phone overlay in camera space (NEEDS DEVICE TEST) |
| A4 | Zone functions | Left/right → indicator + event; custom → warning; board zone → object count; shadow zone → SAFE/EXPOSED (game: after Reveal; workshop: *Shadow preview*) | Toggle *Shadow preview* | Screenshot | BROWSER-VERIFIED |

## B. Position (panel section B)

| # | Relationship | Geometric predicate | System response | Status |
| --- | --- | --- | --- | --- |
| B1 | Dracula LEFT / RIGHT of Building A (first building) | Compare with the footprint's x-extent ± 2 m margin | Row highlights LEFT/RIGHT/ALIGNED | TESTED + BROWSER-VERIFIED |
| B2 | Dracula BETWEEN A and B | Inside convex hull(A ∪ B) and outside both footprints | Yellow hull drawn between the buildings, "YES" | TESTED |
| B3 | Dracula ADJACENT to a building | Footprint edge ≤ 8 m from the wall | Building outline glows + **position-triggered** toast with its name and height + chime | TESTED + BROWSER-VERIFIED |

Capture: one screenshot each.

## C. Movement (panel section C, event log + trail)

| # | Condition | Detection | Status |
| --- | --- | --- | --- |
| C1 | Moves INTO a zone | Zone membership change held ≥ 250 ms | TESTED + BROWSER-VERIFIED ("moved INTO LEFT ZONE", "INTO GARLIC MARKET") |
| C2 | Moves OUT OF a zone | Same | TESTED + BROWSER-VERIFIED ("OUT OF RIGHT ZONE") |
| C3 | Moves TOWARD a building (and AWAY) | Distance to footprint drops > 12 m within 0.9 s, motion mostly radial | TESTED + BROWSER-VERIFIED ("moving TOWARD Brick Hall", "AWAY Corner Deli") |

Trajectory trail + velocity arrow are drawn in workshop mode. Capture a short recording of each.

## D. Directionality

| # | Function | Behavior | Status |
| --- | --- | --- | --- |
| D1 | Dracula's facing ray | The marker's QR "up" vector (world space) → dashed red ray → first building hit is highlighted with "👀 name · height" + tick sound. Also active in the game's Prediction phase: it gives height information, never sun or shadow information. | TESTED (rotation from real decoded pixels within 6°) + BROWSER-VERIFIED (sim) |
| D2 | Shield's facing ray → Dracula | Ray from the shield marker; when it hits Dracula's footprint: green "SHIELD → DRACULA", toast + chime. The safety verdict still uses the shadow geometry only. | TESTED + BROWSER-VERIFIED (sim) |

Rotation source: ZXing returns corners in the symbol's own orientation (verified in `tests/decoder.test.ts` at 0°, 17°,
90° and 180° camera rotations). The native BarcodeDetector option is marked *rotation unverified* in the UI.

## Presentation deliverables (to capture)
1. **Cover page:** "DRACULA — HIDE BEFORE THE SUN", your name, live simulation URL (the board with `?sim=1`, or your
   deployed/tunnel URL).
2. **Four Basic Zones:** A1–A4 screenshots (workshop mode).
3. **Three Position:** B1–B3 screenshots.
4. **Three Movement:** C1–C3 short recordings (event log visible).
5. **Two Directionality:** D1 (rotate the Dracula token, highlighted building changes), D2 (rotate the shield until
   "SHIELD → DRACULA").
6. **Hardware video:** phone mount, laptop board, token moving, phone HUD showing CALIBRATED.
7. **Game footage:** Level 1 → Level 3, including one X and one O, and the shield in Level 3.

Tip: the board's **Debug** drawer (D) is useful for a "how it works" slide: camera-space quads, the
camera px → world m table, reprojection error, sun az/alt.
