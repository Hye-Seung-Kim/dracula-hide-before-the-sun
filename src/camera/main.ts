/**
 * PHONE CAMERA COMPANION (/camera) — a fixed overhead camera, nothing else.
 * Rear camera -> multi-pass multi-QR scan on the phone -> TrackingFrame (native pixel corners) -> laptop via WSS.
 * The UI is just the camera view + one status pill. Settings/diagnostics live behind the ⋯ button.
 */
import "../styles/base.css";
import "./camera.css";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule } from "zxing-wasm/reader";
import { classifyPayload, CORNER_ORDER, setAnchorPlate } from "../engine/boardLayout.ts";
import { calibrate, type CalibrationOptions, DEFAULT_CALIBRATION_OPTIONS } from "../engine/calibration.ts";
import type { DecoderName, MarkerDetection, TrackingFrame } from "../engine/types.ts";
import { GameSocket } from "../net/client.ts";
import { autoReloadOnNewBuild } from "../net/autoReload.ts";
import { normalizeCode, type BoardStatus } from "../net/protocol.ts";
import { DECODER_LABEL, decodeJsQRMultipass, decodeNative, decodeZXing, nativeDetectorAvailable, type ImageLike } from "./decoders.ts";
import { MarkerScanner, type FrameSource } from "./scanner.ts";

prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) } });

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const params = new URLSearchParams(location.search);

document.querySelector("#app")!.innerHTML = `
  <section class="stage">
    <video id="video" playsinline muted></video>
    <canvas id="overlay"></canvas>
  </section>

  <div class="pill" id="pill"><span class="dot"></span><span id="pill-text">Offline</span></div>
  <button class="more" id="more" aria-label="Settings">⋯</button>

  <section class="sheet center" id="pair">
    <div class="title cam-title">Dracula <span>Camera</span></div>
    <label for="code">Code shown on the laptop</label>
    <div class="pair-row">
      <input id="code" inputmode="text" autocapitalize="characters" autocomplete="off" maxlength="4" placeholder="ABCD" />
      <button class="primary" id="join">Join</button>
    </div>
    <p class="msg" id="pair-msg"></p>
  </section>

  <section class="sheet center hidden" id="start-sheet">
    <p>Mount the phone above the laptop, rear camera down, so all four corner QR codes are visible.</p>
    <button class="primary big" id="start">Start camera</button>
    <p class="msg err" id="cam-err"></p>
  </section>

  <section class="sheet drawer hidden" id="drawer">
    <div class="drawer-head"><b>Camera settings</b><button class="ghost" id="close-drawer">Done</button></div>
    <div class="stats" id="stats"></div>
    <button class="primary" id="snapshot" style="width:100%;margin-bottom:8px">📸 Send diagnostic snapshot to laptop</button>
    <p class="fine" id="snap-msg"></p>
    <div class="controls">
      <button class="ghost" id="brighten">Brighten paper (exposure +)</button>
      <button class="ghost" id="rotate" title="Manual fallback: switches to manual mode">Manual rotate ↻</button>
      <button class="ghost" id="mode">Orientation: auto</button>
      <button class="danger" id="stop">Stop camera</button>
    </div>
    <label>Decoder <select id="decoder">
      <option value="zxing-wasm">ZXing WASM (recommended)</option>
      <option value="barcode-detector">Native BarcodeDetector</option>
      <option value="jsqr-multipass">jsQR multipass (fallback)</option>
    </select></label>
    <p class="fine" id="exposure-msg"></p>
    <label>Processing size <select id="res">
      <option value="960">960 px (fast)</option>
      <option value="1280">1280 px</option>
      <option value="1600">1600 px</option>
      <option value="1920" selected>1920 px (native, recommended)</option>
    </select></label>
    <label><input type="checkbox" id="showvid" checked /> Show camera preview</label>
    <p class="fine" id="decoder-info"></p>
  </section>
`;

// ------------------------------------------------------------------ state

let code = normalizeCode(params.get("code") ?? localStorage.getItem("dracula.code") ?? "");
let joined = false;
let running = false;
let stream: MediaStream | null = null;
let decoder: DecoderName = "zxing-wasm";
let seq = 0;
let calOptions: CalibrationOptions = { ...DEFAULT_CALIBRATION_OPTIONS };
let boardStatus: BoardStatus | null = null;
let boardOnline = true;
let lastMarkers: MarkerDetection[] = [];
let lastFrameSize = { w: 1, h: 1 };
let lastCalOk = false;
let lastCalReason = "";
let lastBoardQuad: { x: number; y: number }[] | null = null;
let lastDecodeMs = 0;
const frameTimes: number[] = [];
const seenAt = { dracula: 0, shield: 0 };
let wakeLock: { release(): Promise<void> } | null = null;

const video = $<HTMLVideoElement>("#video");
const overlay = $<HTMLCanvasElement>("#overlay");
const codeInput = $<HTMLInputElement>("#code");
codeInput.value = code;

const show = (id: string, on: boolean) => $(id).classList.toggle("hidden", !on);

// ------------------------------------------------------------------ frame source (native snapshot + crops)

const snap = document.createElement("canvas");
const sctx = snap.getContext("2d", { willReadFrequently: true })!;
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true })!;

function snapshotSource(): FrameSource {
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (snap.width !== W || snap.height !== H) {
    snap.width = W;
    snap.height = H;
  }
  sctx.drawImage(video, 0, 0, W, H); // one consistent frame for all passes
  return {
    width: W,
    height: H,
    getImage(sx, sy, sw, sh, dw, dh): ImageLike {
      if (sx === 0 && sy === 0 && sw === W && sh === H && dw === W && dh === H) return sctx.getImageData(0, 0, W, H);
      if (work.width !== dw || work.height !== dh) {
        work.width = dw;
        work.height = dh;
      }
      wctx.imageSmoothingEnabled = true;
      wctx.imageSmoothingQuality = "high";
      wctx.drawImage(snap, sx, sy, sw, sh, 0, 0, dw, dh);
      return wctx.getImageData(0, 0, dw, dh);
    },
  };
}

async function decodeWith(img: ImageLike, t: number): Promise<MarkerDetection[]> {
  if (decoder === "zxing-wasm") {
    try {
      return await decodeZXing(img, t);
    } catch (e) {
      console.warn("ZXing failed, falling back", e);
      decoder = (await nativeDetectorAvailable()) ? "barcode-detector" : "jsqr-multipass";
      $<HTMLSelectElement>("#decoder").value = decoder;
      $("#decoder-info").textContent = `ZXing failed to load (${(e as Error).message}). Using ${DECODER_LABEL[decoder]}.`;
    }
  }
  if (decoder === "barcode-detector") return decodeNative(img as ImageData, t);
  return decodeJsQRMultipass(img, t);
}

const scanner = new MarkerScanner(decodeWith);

// ------------------------------------------------------------------ socket

const sock = new GameSocket();
sock.onState = () => updatePill();
sock.onOpen = () => {
  if (code.length === 4) sock.send({ t: "join", code });
};
sock.onMessage = (m) => {
  if (m.t === "joined") {
    joined = true;
    localStorage.setItem("dracula.code", m.code);
    $("#pair-msg").textContent = "";
    show("#pair", false);
    if (!running) show("#start-sheet", true);
  } else if (m.t === "error") {
    joined = false;
    $("#pair-msg").textContent = m.message;
    if (running && code.length === 4) {
      // Camera already running: the laptop is probably reconnecting (server restart). Keep retrying quietly.
      setTimeout(() => sock.send({ t: "join", code }), 2000);
    } else {
      show("#pair", true);
      show("#start-sheet", false);
    }
  } else if (m.t === "requestSnapshot") {
    void uploadSnapshot();
  } else if (m.t === "peer") {
    boardOnline = m.board;
  } else if (m.t === "boardStatus") {
    boardStatus = m.status;
    calOptions = m.status.calOptions;
    if (m.status.anchorPlate) setAnchorPlate(m.status.anchorPlate);
    $("#mode").textContent = calOptions.mode === "auto" ? "Orientation: auto" : `Manual (rot ${calOptions.cornerOffset}) → tap for auto`;
  }
  updatePill();
};
sock.connect();

$("#join").onclick = () => {
  code = normalizeCode(codeInput.value);
  codeInput.value = code;
  if (code.length !== 4) {
    $("#pair-msg").textContent = "Enter the 4-letter code shown on the laptop.";
    return;
  }
  sock.send({ t: "join", code });
};
codeInput.addEventListener("keydown", (e) => e.key === "Enter" && $("#join").click());

$("#more").onclick = () => show("#drawer", true);
$("#close-drawer").onclick = () => show("#drawer", false);
$("#rotate").onclick = () => sock.send({ t: "cameraCmd", cmd: { type: "rotateCorners" } });
$("#mode").onclick = () => sock.send({ t: "cameraCmd", cmd: { type: "setMode", mode: "auto" } });
$("#stop").onclick = () => {
  stopCamera();
  show("#drawer", false);
};
$<HTMLSelectElement>("#decoder").onchange = async (e) => {
  const v = (e.target as HTMLSelectElement).value as DecoderName;
  if (v === "barcode-detector" && !(await nativeDetectorAvailable())) {
    $("#decoder-info").textContent = "BarcodeDetector is not available in this browser (iOS Safari lacks it). Staying on ZXing.";
    (e.target as HTMLSelectElement).value = decoder;
    return;
  }
  decoder = v;
  $("#decoder-info").textContent = DECODER_LABEL[decoder];
};
$<HTMLSelectElement>("#res").onchange = (e) => (scanner.procSize = Number((e.target as HTMLSelectElement).value));
$<HTMLInputElement>("#showvid").onchange = (e) => video.classList.toggle("hidden", !(e.target as HTMLInputElement).checked);
$("#decoder-info").textContent = DECODER_LABEL[decoder];

// ------------------------------------------------------------------ camera

$("#start").onclick = () => startCamera();

async function startCamera() {
  const err = (msg: string) => ($("#cam-err").innerHTML = msg);
  if (!window.isSecureContext) return err(`Camera blocked: this page is not HTTPS.<br/>Open <b>https://${location.hostname}:5443/camera</b> instead.`);
  if (!navigator.mediaDevices?.getUserMedia) return err("This browser has no camera API. Use Safari (iOS) or Chrome (Android).");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === "NotAllowedError") return err("Camera permission denied. iOS: Settings → Safari → Camera → Allow, then reload. Android: lock icon → Permissions → Camera.");
    if (name === "NotFoundError") return err("No camera found on this device.");
    if (name === "NotReadableError") return err("The camera is in use by another app. Close it and try again.");
    return err(`Camera error: ${name} ${(e as Error).message}`);
  }
  const track = stream.getVideoTracks()[0];
  await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
  video.srcObject = stream;
  await video.play();
  running = true;
  err("");
  show("#start-sheet", false);
  try {
    wakeLock = (await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen")) ?? null;
  } catch { /* ignore */ }
  updatePill();
  loop();
}

function stopCamera() {
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  wakeLock?.release().catch(() => {});
  lastMarkers = [];
  drawOverlay(null);
  if (joined) show("#start-sheet", true);
  updatePill();
}

async function loop() {
  while (running) {
    if (video.readyState < 2 || !video.videoWidth) {
      await new Promise((r) => requestAnimationFrame(r));
      continue;
    }
    const src = snapshotSource();
    const t0 = performance.now();
    const ts = Date.now();
    let markers: MarkerDetection[] = [];
    try {
      markers = await scanner.scan(src, ts, lastBoardQuad);
    } catch (e) {
      console.error(e);
    }
    lastDecodeMs = performance.now() - t0;
    lastMarkers = markers;
    lastFrameSize = { w: src.width, h: src.height };
    const frame: TrackingFrame = { sessionId: code, frameWidth: src.width, frameHeight: src.height, markers, timestamp: ts, decoder, decodeMs: lastDecodeMs, seq: seq++ };
    if (joined) sock.send({ t: "frame", frame });
    frameTimes.push(performance.now());
    while (frameTimes.length > 2 && performance.now() - frameTimes[0] > 5000) frameTimes.shift();
    for (const m of markers) {
      const k = classifyPayload(m.payload);
      if (k === "dracula" || k === "shield") seenAt[k] = performance.now();
    }
    const cal = calibrate(markers, calOptions);
    lastCalOk = cal.ok;
    lastCalReason = cal.reason ?? "";
    if (cal.ok && cal.imageQuad) lastBoardQuad = cal.imageQuad;
    drawOverlay(cal);
    updatePill();
    if (!$("#drawer").classList.contains("hidden")) updateStats(markers, cal);
    await new Promise((r) => requestAnimationFrame(r));
  }
}

// ------------------------------------------------------------------ diagnostics: snapshot + exposure

$("#snapshot").onclick = () => void uploadSnapshot();

async function uploadSnapshot() {
  const msg = $("#snap-msg");
  if (!running || !snap.width) {
    msg.textContent = "Start the camera first.";
    return;
  }
  msg.textContent = "Uploading…";
  try {
    const image = snap.toDataURL("image/jpeg", 0.92); // the exact native frame the scanner used last
    const track = stream?.getVideoTracks()[0];
    const body = {
      image, code, at: new Date().toISOString(), userAgent: navigator.userAgent,
      video: { width: video.videoWidth, height: video.videoHeight }, settings: track?.getSettings?.() ?? null,
      capabilities: (track as unknown as { getCapabilities?: () => unknown })?.getCapabilities?.() ?? null,
      decoder, procSize: scanner.procSize, scannerStats: scanner.stats, lastDecodeMs,
      fps: frameTimes.length > 1 ? (1000 * (frameTimes.length - 1)) / (frameTimes[frameTimes.length - 1] - frameTimes[0]) : 0,
      markers: lastMarkers, calibration: calibrate(lastMarkers, calOptions),
    };
    const r = await fetch(`/api/snapshot/${code}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    msg.textContent = r.ok ? "Saved on the laptop (snapshots/ folder). Thanks!" : `Upload failed: ${r.status}`;
  } catch (e) {
    msg.textContent = `Upload failed: ${(e as Error).message}`;
  }
}

let brightened = false;
$("#brighten").onclick = async () => {
  const msg = $("#exposure-msg");
  const track = stream?.getVideoTracks()[0];
  if (!track) return (msg.textContent = "Start the camera first.");
  const caps = (track as unknown as { getCapabilities?: () => Record<string, { min: number; max: number }> }).getCapabilities?.() ?? {};
  const ec = caps.exposureCompensation;
  if (!ec) {
    msg.textContent = "This browser can't change camera exposure. Turn on a room/desk light over the paper marker, or lower the laptop brightness to ~50%.";
    return;
  }
  brightened = !brightened;
  const value = brightened ? Math.min(ec.max, ec.max * 0.6) : 0;
  try {
    await track.applyConstraints({ advanced: [{ exposureCompensation: value } as MediaTrackConstraintSet] });
    msg.textContent = brightened ? `Exposure +${value.toFixed(1)} (paper looks brighter; corner QRs must stay readable)` : "Exposure reset";
    $("#brighten").textContent = brightened ? "Exposure: normal" : "Brighten paper (exposure +)";
  } catch (e) {
    msg.textContent = `Exposure change failed: ${(e as Error).message}`;
  }
};

// ------------------------------------------------------------------ status pill (the only always-on UI)

function updatePill() {
  const pill = $("#pill");
  let cls = "bad";
  let text: string;
  if (sock.state !== "open") text = "Reconnecting…";
  else if (!joined) text = "Not paired";
  else if (!boardOnline) text = "Laptop offline";
  else if (!running) {
    cls = "warn";
    text = "Paired · camera off";
  } else {
    const boardOk = lastCalOk || !!boardStatus?.calibrated;
    const iv = frameTimes.length > 1 ? (frameTimes[frameTimes.length - 1] - frameTimes[0]) / (frameTimes.length - 1) : 300;
    const recent = (t: number) => performance.now() - t < Math.max(1500, iv * 2.5);
    const anchors = lastMarkers.filter((m) => classifyPayload(m.payload) === "anchor").length;
    const parts = [boardOk ? "Board ✓" : anchors >= 4 ? `Board ✗ ${lastCalReason.split("(")[0].trim()}` : `Board ${anchors}/4`];
    if (!boardStatus?.draculaFixed) parts.push(recent(seenAt.dracula) ? "Dracula ✓" : "Dracula —");
    if (boardStatus?.usesShield) parts.push(recent(seenAt.shield) ? "Shield ✓" : "Shield —");
    const needed = boardStatus?.draculaFixed ? recent(seenAt.shield) : recent(seenAt.dracula) && (!boardStatus?.usesShield || recent(seenAt.shield));
    cls = boardOk && needed ? "ok" : boardOk ? "warn" : "bad";
    text = parts.join(" · ");
  }
  pill.className = `pill ${cls}`;
  $("#pill-text").textContent = text;
}

function updateStats(markers: MarkerDetection[], cal: ReturnType<typeof calibrate>) {
  const st = scanner.stats;
  $("#stats").innerHTML = `
    <div><b>${markers.length}</b><span>QR seen</span></div>
    <div><b>${markers.filter((m) => classifyPayload(m.payload) === "anchor").length}/4</b><span>corners</span></div>
    <div><b>${cal.ok ? "OK" : "—"}</b><span>calibrated</span></div>
    <div><b>${frameTimes.length > 1 ? ((1000 * (frameTimes.length - 1)) / (frameTimes[frameTimes.length - 1] - frameTimes[0])).toFixed(1) : "0"}</b><span>fps</span></div>
    <div><b>${lastDecodeMs.toFixed(0)}</b><span>ms/frame</span></div>
    <div><b>${st.liftHits}/${st.roiHits}/${st.tileHits}</b><span>lift/roi/tile hits</span></div>
    <div class="wide"><span>${lastFrameSize.w}×${lastFrameSize.h} · full ${st.fullMs.toFixed(0)} ms · roi ${st.roiMs.toFixed(0)} ms · native ${st.nativeMs.toFixed(0)} ms · tiles ${st.tileMs.toFixed(0)} ms${cal.reason ? " · " + cal.reason : ""}</span></div>`;
}

const COLORS = { anchor: "#7fe7ff", dracula: "#ff5a6a", shield: "#ffb547", unknown: "#888" };

function drawOverlay(cal: ReturnType<typeof calibrate> | null) {
  const rect = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (overlay.width !== Math.round(rect.width * dpr) || overlay.height !== Math.round(rect.height * dpr)) {
    overlay.width = Math.round(rect.width * dpr);
    overlay.height = Math.round(rect.height * dpr);
  }
  const ctx = overlay.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!running) return;
  const s = Math.min(rect.width / lastFrameSize.w, rect.height / lastFrameSize.h);
  const ox = (rect.width - lastFrameSize.w * s) / 2;
  const oy = (rect.height - lastFrameSize.h * s) / 2;
  const P = (p: { x: number; y: number }) => [ox + p.x * s, oy + p.y * s] as const;
  const quad = (pts: { x: number; y: number }[]) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
    ctx.closePath();
  };

  if (cal?.imageQuad) {
    quad(cal.imageQuad);
    ctx.lineWidth = 3;
    ctx.strokeStyle = cal.ok ? "#3ddc84" : "#e5484d";
    ctx.stroke();
    if (!$("#drawer").classList.contains("hidden")) {
      ctx.font = "700 13px Space Grotesk, sans-serif";
      cal.imageQuad.forEach((p, i) => {
        const [x, y] = P(p);
        ctx.fillStyle = "#3ddc84";
        ctx.fillText(CORNER_ORDER[i], x + 6, y - 6);
      });
    }
  }
  for (const m of lastMarkers) {
    const kind = classifyPayload(m.payload);
    quad(m.corners);
    ctx.lineWidth = kind === "anchor" ? 2 : 4;
    ctx.strokeStyle = COLORS[kind];
    ctx.stroke();
    if (kind === "dracula" || kind === "shield") {
      const [x, y] = P(m.center);
      ctx.font = "800 15px Space Grotesk, sans-serif";
      ctx.fillStyle = COLORS[kind];
      ctx.fillText(kind === "dracula" ? "DRACULA" : "SHIELD", x + 14, y - 14);
    }
  }
}

window.addEventListener("resize", () => drawOverlay(null));

// New build deployed -> reload and resume the camera automatically.
autoReloadOnNewBuild(() => true, () => sessionStorage.setItem("dracula.resumeCamera", running ? "1" : ""));
if (sessionStorage.getItem("dracula.resumeCamera") === "1") {
  sessionStorage.removeItem("dracula.resumeCamera");
  const resume = () => (joined ? startCamera() : setTimeout(resume, 300));
  setTimeout(resume, 300);
}
if (code.length === 4) $("#pair-msg").textContent = "Connecting…";
