# DRACULA — HIDE BEFORE THE SUN

*Can you predict where the shadows will fall?*

**Play in the browser (mouse mode):** https://dracula-hide-before-the-sun.netlify.app/board?sim=1  
The phone-camera mode needs the local Node server (see Quick start).

A physical–digital tabletop game for the SVA Spatial Computing course. The **laptop screen is the board**: a miniature
New York with buildings, a clock, a date and a compass. A **phone mounted above** is the overhead camera. You move a
**physical Dracula** (with a QR marker) to where you *predict* the shadows will be, press **READY**, and the game reveals
the real sun direction (computed with SunCalc for that city, date and time) and the building shadows. In shade → **O**.
In sunlight → **X**, and Dracula burns.

```
 ┌──────────── phone (rear camera, ~30 cm above) ────────────┐
 │  getUserMedia → ZXing-WASM multi-QR → TrackingFrame (px)  │──WSS──┐
 └───────────────────────────────────────────────────────────┘       │
                                                                     ▼
 ┌──────────── laptop screen = board (/board) ───────────────┐   Node server
 │ 4 QR anchors · city · compass · clock                     │◀──(pairing code,
 │ TrackingPipeline: calibrate (4-QR homography) → world m   │    relay, HTTPS)
 │ → smoothing → game state machine → shadows → O / X        │
 └───────────────────────────────────────────────────────────┘
```

## Quick start

```bash
npm install
npm run build && npm start      # production build (recommended for play)
# or: npm run dev               # Vite live-reload while developing
npm test                        # 71 automated tests
```

| Device | URL |
| --- | --- |
| Laptop board | `http://localhost:5173/board` |
| Phone camera | `https://<laptop-LAN-IP>:5443/camera` (accept the self-signed certificate once). The board shows this URL and a QR to scan |
| Printable markers | `http://localhost:5173/markers` |
| Workshop demo | `http://localhost:5173/board?workshop=1&sim=1` |
| Mouse-only play | `http://localhost:5173/board?sim=1` |
| Procession / p5.js state feed | `http://localhost:5173/api/session/<CODE>/state` |

Keyboard on the board: **Space** = primary action (Start / Begin / READY / Reveal / Next) · **W** workshop · **S** simulator ·
**D** debug · **M** mute · **F** fullscreen. In simulator: drag objects, wheel or **Q/E** rotate, **1/2** select Dracula/Shield, **H** hide marker.

## Documentation

- [docs/SETUP.md](docs/SETUP.md): hardware, pairing, camera placement, troubleshooting
- [docs/ASSIGNMENT_CHECKLIST.md](docs/ASSIGNMENT_CHECKLIST.md): every assignment requirement → implementation → how to demo → status
- [docs/PROCESSION_INTEGRATION.md](docs/PROCESSION_INTEGRATION.md): what Procession can / can't do, and how to connect it
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, coordinate systems, tracking and shadow model

## Project layout

```
server/index.ts            HTTP :5173 + HTTPS :5443 (self-signed, auto-generated), WebSocket pairing + relay
src/engine/                shared spatial engine (pure TypeScript, unit-tested)
  boardLayout.ts           world size, QR anchor positions, payloads
  geometry.ts              vectors, polygons, rays, homography
  calibration.ts           four-QR calibration (orientation from QR corners, 16-corner check)
  tracking.ts              world poses, smoothing, no-teleport gate, loss handling, stability
  solar.ts                 SunCalc 2.x wrapper, time-zone conversion
  shadows.ts               2.5D prism + shield shadows
  rules.ts                 placement validity, coverage verdict
  levels.ts                the three levels
  spatial.ts               zones, position, movement, directionality (workshop)
  gameState.ts             state machine (SETUP → … → GAME_COMPLETE)
  simulator.ts             virtual overhead camera that emits real TrackingFrames
src/camera/                phone page + multi-QR decoders (ZXing-WASM, BarcodeDetector, jsQR tiled)
src/board/                 laptop board page, canvas renderer, styles
src/audio/                 speech synthesis + synthesized sound effects
src/net/                   protocol types + reconnecting WebSocket client
tests/                     unit, rendered-pixel decoder tests, server end-to-end test
```
