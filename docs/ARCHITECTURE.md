# Architecture

## Data flow
1. **Phone** (`src/camera/main.ts`): rear camera → downscale to *Processing size* (default 1280 px) → multi-QR decode →
   `TrackingFrame { markers: [{ payload, center, corners[TL,TR,BR,BL], rotationRadians, timestamp }] }` in **camera pixels**
   → WSS → server → board. Only coordinates are sent (≈1 KB/frame), never video.
2. **Board** (`src/engine/tracking.ts`): every frame →
   - `calibrate()` finds the four `zone:dracula-board` instances. Identical payloads are never merged.
   - **Orientation:** each anchor QR is drawn upright on the laptop, so its decoded corner order shows where board-north
     is in the camera image. The four centres are sorted clockwise in that board-aligned frame (TL, TR, BR, BL).
     Mirrored images are detected from the corner winding.
   - Homography: camera px → world metres (4 centres ↔ known anchor positions).
   - **Verification:** all 16 anchor *symbol corners* are re-projected and compared with their known positions. A wrong
     corner assignment rotates every symbol, which gives an error about the QR size, so it is rejected. A manual
     "rotate corners" offset and an "image axes" mode are the fallback.
   - Object markers (`object:dracula:01`, `object:shield:01`): pose = homography(corners) → centre + heading
     (compass bearing of the symbol's up-vector in world space), plus a configurable contact offset.
   - **Tracker:** confirm on 2 consecutive frames; jumps > 45 m need confirmation (no teleporting); adaptive EMA; "held"
     for up to 2 s after loss (drawn ghosted), then "lost" (removed). Confidence is the share of recent frames with a
     detection. *Stable* means less than 3.5 m spread over 0.6 s.
   - Calibration is held for up to 5 s while an anchor is covered (READY requires it fresh).
3. **Game** (`gameState.ts`): pure reducer. `PRESS_READY` checks `readyBlockers()` (live frames, fresh calibration,
   Dracula *tracked* + *stable*, valid placement, shield present in L3) and **snapshots** the averaged position. The
   verdict is computed from that snapshot only, so moving Dracula after READY can't change it, and losing tracking can
   never auto-succeed.

## Coordinate systems
- Camera: pixels of the phone's processing frame.
- World: metres of the miniature city, **+x = east (right), +y = south (down), north = top**. The board is 320 × 220 m.
  On a 13" laptop in fullscreen, 1 cm on screen ≈ 12.8 m.
- Screen: world × uniform scale + offset (`renderer.ts → View`). Resizing the window changes only this mapping. Tracking
  never depends on it, because the anchors are drawn at fixed *world* positions.

## Sun and shadows
- `suncalc@2.1.4`: **degrees, azimuth clockwise from north**. This differs from SunCalc 1.x, which uses radians measured
  from the south. A test pins this down.
- Local date + time + IANA zone → UTC via `Intl` (DST-aware; tested for EDT and EST).
- Shadow direction = away from the sun; length = height / tan(altitude).
- Buildings are convex prisms: shadow = convex hull(footprint ∪ footprint + offset). Exact for flat ground.
- Shield: a vertical wall segment (44 m × 80 m) standing 0.75 × marker size in front of its QR, perpendicular to the
  marker's facing axis. Shadow = hull(wall ∪ wall + offset).
- Verdict: 240 equal-area samples of Dracula's 7 m footprint (reduced by a 1 m tracking tolerance). **Safe if ≥ 75%**
  are inside the union of shadows. Placement is invalid on a rooftop, off the map, on a QR anchor, or (L3) outside the
  golden circle.

This is a deterministic 2.5D model, not a full 3D simulation: there are no shadows on roofs and no terrain.
