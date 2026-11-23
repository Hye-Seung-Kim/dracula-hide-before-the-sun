# Procession integration

## What I verified about Procession (spatialpixel.com/procession)
Read from the public pages (`/procession/learn/`, `/procession/`, the app shell) on 2026-11-12:

- Procession is a **natural-language programming environment** in the browser. You write prompts and it generates code
  (the learn page links the p5.js reference, so the output is most likely p5.js). It needs an OpenAI API key.
- Documented inputs: **the laptop webcam** ("show my webcam"), microphone, mouse, uploaded media, and
  hand/body/face/object tracking. There is a *PubSub* tab and an IFTTT example.
- **Not documented anywhere on those pages:** QR-code detection (single or multiple), identical-payload handling, QR
  corners or rotation, polygon zones, using a **phone or remote camera**, multi-device sync, WebSockets, or loading
  external libraries.

So I did **not** assume Procession can do the phone-camera, multi-QR, or sync parts. Those run in this standalone app,
which is a superset of what the game needs.

## Integration path: Procession / p5.js reads the game's tracked world state

The board publishes a read-only, CORS-enabled JSON feed:

```
GET http://localhost:5173/api/session/<CODE>/state
{
  "code": "44VV", "t": 1731400000000, "phase": "PREDICTION", "level": 1,
  "calibrated": true, "simulated": false,
  "dracula": { "status": "tracked", "x": 150.2, "y": 60.1, "nx": 0.469, "ny": 0.273, "headingDeg": 270 },
  "shield": null,
  "result": null          // only filled after Reveal: { safe, coverage, sunAzimuthDeg, sunAltitudeDeg }
}
```

`nx, ny` are normalized board coordinates (0..1, north = top). Multiply by your canvas size.

### Prompt to try in Procession
> Every 100 milliseconds, fetch JSON from `http://localhost:5173/api/session/ABCD/state`. If `dracula` is not null,
> draw a red circle at `dracula.nx * width`, `dracula.ny * height` and a line in the direction `dracula.headingDeg`
> (0 = up, 90 = right). If `result` is not null, write "SAFE" in green or "BURNED" in red.

If Procession runs on an HTTPS origin and blocks `http://localhost` (mixed content), use the HTTPS endpoint
`https://localhost:5443/api/session/ABCD/state` after accepting its certificate once in the same browser, or the
`cloudflared` tunnel URL.

### Plain p5.js equivalent (tested logic, paste into the Procession code editor or editor.p5js.org)
See [`procession/dracula-feed.p5.js`](procession/dracula-feed.p5.js).

## Other options
- **Run the game inside Procession:** not practical. The phone camera, WSS pairing and WASM decoder need a server
  and HTTPS, and Procession documents neither.
- **Use Procession's laptop webcam instead of the phone:** possible in principle, but the assignment setup has the
  webcam facing the user, not the screen, and Procession's QR support is undocumented. Not pursued.
- **PubSub:** if Procession's PubSub tab turns out to be MQTT/WebSocket based, a small bridge could forward
  `worldState` messages. This isn't built, because the API isn't documented.
