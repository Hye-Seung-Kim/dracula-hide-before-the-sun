# Setup — one laptop + one smartphone

## 1. Run the server (laptop)

```bash
cd dracula-hide-before-the-sun
npm install
npm run build && npm start
```

The terminal prints:

```
Laptop board :  http://localhost:5173/board
Phone camera :  https://192.168.x.x:5443/camera   (accept the certificate warning once)
```

- The **board** uses plain HTTP on `localhost`, which browsers treat as a secure context, so no certificate is needed.
- The **phone** must use **HTTPS**. Mobile browsers block `getUserMedia` on `http://<LAN-IP>`. The server makes a
  self-signed certificate for `localhost` and every LAN IP (`.cert/`, regenerated when your IP changes).
- Both devices must be on the **same Wi-Fi**. Guest/campus networks with "client isolation" block device-to-device
  traffic. If the phone can't load the page, use a hotspot or a tunnel (below).

### Option B: HTTPS tunnel (no certificate warning, works across networks)

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:5173
# then restart the server with the printed URL so the board shows it:
PUBLIC_URL=https://<random>.trycloudflare.com npm start
```

Open the board at `http://localhost:5173/board` and the phone at `https://<random>.trycloudflare.com/camera`.
WebSockets work through the tunnel, but latency is higher than on the LAN.

## 2. Pair

**Laptop**
1. Open `http://localhost:5173/board` (or Home → *Host Game*). Press **F** for fullscreen. A bigger board means bigger QR codes.
2. The card shows a 4-letter **session code**, the phone URL, and a QR code of that URL.

**Phone**
1. Scan the QR on the board card, or type the `https://…:5443/camera` URL.
2. Accept the certificate warning. iOS Safari: *Show Details → visit this website*. Chrome: *Advanced → Proceed*.
3. The code is pre-filled from the QR (or type it), then tap **Join**. The laptop shows "📱 Phone camera connected".
4. Tap **Start camera** and allow camera access. The phone screen stays awake (Wake Lock) while the camera runs.
5. Mount the phone (next section). The phone shows `4/4 corners` and **CALIBRATED** with the green board outline, and
   the laptop shows **Calibrated**.
6. Put Dracula on the board. Both screens show *Dracula tracked*. Press **START GAME** on the laptop. This also unlocks audio.

Reloading the laptop keeps the same code, and the phone reconnects automatically. You don't need to restart the
camera between levels.

## 3. Physical setup

### Laying the screen flat (it must be horizontal to place objects on it)
- Open the lid as far as it goes and rest the **lid flat on the table, screen up**, on a soft cloth. Prop the keyboard
  half up behind it with books so the hinge isn't strained. Or use a laptop stand that tilts the display to horizontal.
- Turn off auto-sleep/screen dimming, plug in power, set brightness to **70–100%**, and turn off Night Shift / True Tone
  if the QR codes look washed out.

### Protect the display
- Lay a **thin clear sheet** on the screen: an overhead-projector transparency, a clear document sleeve, or a matte
  screen-protector film. A matte film also reduces glare.
- Give tokens a **felt pad** underneath. Keep them light (< 20 g). Never press on the display.

### Phone mount
- **Height: about 28–35 cm** above the screen, rear (1×) camera pointing straight down, phone in **landscape**.
  Avoid the ultra-wide (0.5×) lens: its distortion bends straight lines.
- The board should fill **at least 70% of the camera frame width**. All four corner QR codes must be fully visible, with a
  little margin.
- Use a gooseneck phone holder, a ring-light arm, or a stack of books with a ruler sticking out. Keep the camera fixed.
  If a hand briefly covers an anchor, calibration is held for a few seconds, but the camera shouldn't move.
- Tilting up to ~20° is fine. Perspective is corrected by the homography. Tilting the camera slightly can also remove a
  reflection of the ceiling light.

### QR sizes (13" laptop, fullscreen)
| Marker | Size | Notes |
| --- | --- | --- |
| Board anchors (on screen) | ~2.5 cm | Drawn automatically; 25 modules (ECC M) on a white 40 m plate with a 2-module quiet zone |
| Dracula | **25 mm** printed (min 22 mm) | ECC L, 21 modules. Print at 100% from `/markers` |
| Shield | **25 mm** printed | Same, with a "WALL" line printed at exactly 0.75 × QR size from the QR centre |

With the camera above 40 cm, print 30 mm markers or raise *Processing size* to 1600–1920 px on the phone
(*Camera & decoder settings*).

### Marker contrast (most common cause of unstable Dracula tracking)
- The code needs **black on white with a white border** (quiet zone) of at least 2 squares all around.
- **Paper is best.** A QR shown on another phone lying on the laptop is often dark grey on grey, without a border,
  and with glare. That is hard to read even for the improved scanner. If you must use a phone, set its brightness to
  max and show `markers-png/dracula.png` (which has a white border) without zooming in.
- The phone scanner reads each frame three ways: full frame; a native-resolution crop around Dracula's last position
  (tight crop + contrast stretch); and, when Dracula is missing, a periodic native-resolution full scan.

### The Dracula token
- Glue the printed QR **flat and as low as possible**, e.g. on top of a 5–10 mm tall token (bottle cap, wooden disc,
  coin stack), with the ▲ arrow pointing where Dracula "looks". Put a small vampire drawing or figure next to it, but it
  must not cover the code from above.
- **Why low?** The camera sees the marker, not the token's feet. A marker 3 cm above the screen and 10 cm off-centre
  appears shifted by about 1 cm (about 13 m in the city). If you use a taller figure, compensate with
  *Debug → Dracula contact fwd/right* (in marker-size units), or keep Dracula near the middle of the board.

### The shield (Level 3)
- Cut a cardboard wall about **3.4 cm wide × 6 cm tall** (the game models it as 44 m × 80 m).
- Glue it standing up along the brown **WALL** line of the printed shield card. The ▲ arrow points *through* the wall
  toward Dracula. The QR card lies flat behind the wall, so the camera can see it.
- The shield's simulated shadow uses the wall's position and orientation, the same sun as the buildings, and its
  simulated height.

### Lighting
- Diffuse room light. Avoid a bright lamp directly above: it reflects off the glossy screen and blinds the anchors.
- If the phone shows `0/4 corners` while the codes are clearly visible, look at the phone preview for a white glare
  blob, then tilt the camera or move the lamp.

## 4. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Phone: "Camera blocked: this page is not HTTPS" | Use `https://<IP>:5443/camera` (not `http://` or port 5173), or the tunnel URL. |
| Phone: permission denied | iOS: Settings → Safari → Camera → Allow, then reload. Android Chrome: lock icon → Permissions → Camera. |
| Phone can't open the URL at all | Not on the same network, or client isolation. Use a hotspot or `cloudflared`. On a macOS firewall prompt, allow `node`. |
| Certificate warning keeps coming back | The IP changed and the server regenerated the cert, so accept it again. Or use the tunnel. |
| `3/4 corners` | One anchor is cut off or has glare. Move the phone up or center it. Fullscreen the board (F). |
| "Corner check failed" / "Ambiguous" | Tap **Rotate corners ↻** on the phone (manual corner-assignment fallback) until the green outline labels TL/TR/BR/BL match the screen. Use **Orientation: image** only if auto keeps failing. |
| Dracula flickers between *tracked* and *held* | Marker too small or too blurry: print 30 mm, raise Processing size, add light, hold still. |
| Dracula position is offset | Marker is too high above the screen (parallax). Lower it or set the contact offset in Debug. |
| No voice | Press START GAME (a click is needed to unlock audio). Check the 🔊 button and the laptop volume. |
| READY says "Hold Dracula still…" | The position must be stable (< 3.5 m spread) for 0.6 s. Let go of the token. |

The **Debug** drawer (press **D**) shows raw marker corners, the camera-space view, frame age, fps, decode time,
calibration status and reprojection error, sun azimuth/altitude, and the shadow polygons.

## 5. Developing without hardware
`/board?sim=1` drives the **same** pipeline with a virtual overhead camera. It produces camera-pixel TrackingFrames that
go through calibration → homography → smoothing → game rules. Simulated input is always labelled **SIMULATED** on screen.
