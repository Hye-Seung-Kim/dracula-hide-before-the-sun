/**
 * DRACULA — HIDE BEFORE THE SUN : pairing + relay server.
 *
 *   HTTP  :5173  -> laptop board (http://localhost is a secure context, no certificate needed)
 *   HTTPS :5443  -> phone camera (mobile browsers only allow getUserMedia on HTTPS)
 *   WS/WSS /ws   -> session pairing with a 4-letter code; phone frames relayed to the board
 *
 * The phone decodes QR codes itself and sends only marker coordinates (a few hundred bytes per frame).
 * Usage:  npm run dev   (Vite middleware, live reload)    |    npm start   (serves the built dist/)
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import selfsigned from "selfsigned";
import { createHash } from "node:crypto";
import type { ClientMsg, ServerInfo, ServerMsg } from "../src/net/protocol.ts";
import type { MarkerDetection } from "../src/engine/types.ts";
import { calibrate } from "../src/engine/calibration.ts";
import { setAnchorPlate } from "../src/engine/boardLayout.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEV = process.argv.includes("--dev");
const HTTP_PORT = Number(process.env.PORT ?? 5173);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 5443);
const PUBLIC_URL = process.env.PUBLIC_URL ?? null;
const CODE_ALPHABET = "ACDEFHJKMNPRTUVWXY347";

function lanIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  return out;
}

async function loadCert(): Promise<{ key: string; cert: string }> {
  const dir = join(ROOT, ".cert");
  const ips = lanIps().sort();
  const metaPath = join(dir, "meta.json");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (JSON.stringify(meta.ips) === JSON.stringify(ips) && new Date(meta.expires) > new Date()) {
      return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
    }
  }
  mkdirSync(dir, { recursive: true });
  const expires = new Date(Date.now() + 300 * 86400000);
  const pems = await selfsigned.generate([{ name: "commonName", value: "dracula.local" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: expires,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2 as const, value: "localhost" }, { type: 7 as const, ip: "127.0.0.1" }, ...ips.map((ip) => ({ type: 7 as const, ip }))] },
    ],
  });
  writeFileSync(join(dir, "key.pem"), pems.private);
  writeFileSync(join(dir, "cert.pem"), pems.cert);
  writeFileSync(metaPath, JSON.stringify({ ips, expires }));
  return { key: pems.private, cert: pems.cert };
}

/** Identifies the deployed build: clients reload themselves when it changes (no stale tabs after an update). */
let versionCache = { mtime: 0, v: "dev" };
function buildVersion(): string {
  if (DEV) return "dev";
  try {
    const files = ["board.html", "camera.html"].map((f) => join(ROOT, "dist", f));
    const mtime = Math.max(...files.map((f) => statSync(f).mtimeMs));
    if (mtime !== versionCache.mtime) {
      const h = createHash("sha1");
      for (const f of files) h.update(readFileSync(f));
      versionCache = { mtime, v: h.digest("hex").slice(0, 12) };
    }
    return versionCache.v;
  } catch {
    return "unknown";
  }
}

// ------------------------------------------------------------------ sessions

interface Session {
  code: string;
  board: WebSocket | null;
  cameras: Set<WebSocket>;
  lastActive: number;
  world: unknown;
  framesRelayed: number;
  lastFrame: unknown;
  lastFrameAt: number;
}
const sessions = new Map<string, Session>();
const role = new WeakMap<WebSocket, { kind: "board" | "camera"; code: string }>();

const send = (ws: WebSocket | null, msg: ServerMsg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};

function newCode(): string {
  for (;;) {
    let c = "";
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!sessions.has(c)) return c;
  }
}

function announce(s: Session) {
  const msg: ServerMsg = { t: "peer", board: !!s.board && s.board.readyState === 1, cameras: [...s.cameras].filter((c) => c.readyState === 1).length };
  send(s.board, msg);
  for (const c of s.cameras) send(c, msg);
}

function info(): ServerInfo {
  return { lanIps: lanIps(), httpPort: HTTP_PORT, httpsPort: HTTPS_PORT, publicUrl: PUBLIC_URL };
}

function handleSocket(ws: WebSocket) {
  const alive = { v: true };
  ws.on("pong", () => (alive.v = true));
  const hb = setInterval(() => {
    if (!alive.v) return ws.terminate();
    alive.v = false;
    ws.ping();
  }, 5000);

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const r = role.get(ws);
    const s = r ? sessions.get(r.code) : undefined;
    if (s) s.lastActive = Date.now();
    switch (msg.t) {
      case "host": {
        // Re-hosting with the same code after a reload keeps the phone paired.
        let code = msg.code && /^[A-Z0-9]{4}$/.test(msg.code) ? msg.code : newCode();
        const existing = sessions.get(code);
        if (existing?.board && existing.board !== ws && existing.board.readyState === 1) code = newCode();
        const sess = sessions.get(code) ?? { code, board: null, cameras: new Set(), lastActive: Date.now(), world: null, framesRelayed: 0, lastFrame: null, lastFrameAt: 0 };
        sess.board = ws;
        sessions.set(code, sess);
        role.set(ws, { kind: "board", code });
        send(ws, { t: "hosted", code, info: info() });
        announce(sess);
        break;
      }
      case "join": {
        const code = String(msg.code).toUpperCase();
        const sess = sessions.get(code);
        if (!sess) return send(ws, { t: "error", message: `No game with code ${code}. Check the laptop screen.` });
        sess.cameras.add(ws);
        role.set(ws, { kind: "camera", code });
        send(ws, { t: "joined", code });
        announce(sess);
        break;
      }
      case "frame":
        if (r?.kind === "camera" && s) {
          send(s.board, { t: "frame", frame: msg.frame });
          s.framesRelayed++;
          s.lastFrame = msg.frame;
          s.lastFrameAt = Date.now();
        }
        break;
      case "cameraCmd":
        if (r?.kind === "camera" && s) send(s.board, { t: "cameraCmd", cmd: msg.cmd });
        break;
      case "boardStatus":
        if (r?.kind === "board" && s) for (const c of s.cameras) send(c, { t: "boardStatus", status: msg.status });
        break;
      case "worldState":
        if (r?.kind === "board" && s) s.world = msg.state;
        break;
      case "ping":
        send(ws, { t: "pong", at: msg.at });
        break;
    }
  });

  ws.on("close", () => {
    clearInterval(hb);
    const r = role.get(ws);
    const s = r && sessions.get(r.code);
    if (!s) return;
    if (r.kind === "board" && s.board === ws) s.board = null;
    s.cameras.delete(ws);
    announce(s);
  });
}

// Forget idle sessions after 6 hours.
setInterval(() => {
  for (const [code, s] of sessions) if (!s.board && !s.cameras.size && Date.now() - s.lastActive > 6 * 3600000) sessions.delete(code);
}, 600000).unref();

// ------------------------------------------------------------------ HTTP

const PAGES: Record<string, string> = { "/": "/index.html", "/board": "/board.html", "/camera": "/camera.html", "/markers": "/markers.html" };
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon",
};

type Next = () => void;
let viteMiddleware: ((req: IncomingMessage, res: ServerResponse, next: Next) => void) | null = null;

function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/api/version") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify({ version: buildVersion() }));
  }
  const reqSnap = url.pathname.match(/^\/api\/session\/([A-Za-z0-9]{4})\/request-snapshot$/);
  if (reqSnap) {
    // Diagnostic: ask the session's phone to upload its current raw camera frame to ./snapshots.
    const sess = sessions.get(reqSnap[1].toUpperCase());
    let n = 0;
    for (const c of sess?.cameras ?? []) if (c.readyState === 1) (send(c, { t: "requestSnapshot" }), n++);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ requested: n }));
  }
  const dbg = url.pathname.match(/^\/api\/session\/([A-Za-z0-9]{4})\/debug$/);
  if (dbg) {
    // Live diagnosis: re-run the board's own calibration on the last frame the phone sent.
    const sess = sessions.get(dbg[1].toUpperCase());
    const f = sess?.lastFrame as { markers: MarkerDetection[]; frameWidth: number; frameHeight: number; decoder: string; decodeMs?: number } | null;
    const plateM = (sess?.world as { anchorPlate?: number } | null)?.anchorPlate;
    if (plateM) setAnchorPlate(plateM);
    const cal = f ? calibrate(f.markers, { mode: "auto", cornerOffset: 0 }) : null;
    const body = sess
      ? {
          boardConnected: !!sess.board && sess.board.readyState === 1,
          cameras: [...sess.cameras].filter((c) => c.readyState === 1).length,
          framesRelayed: sess.framesRelayed,
          lastFrameAgeMs: sess.lastFrameAt ? Date.now() - sess.lastFrameAt : null,
          lastFrame: f ? { size: `${f.frameWidth}x${f.frameHeight}`, decoder: f.decoder, decodeMs: f.decodeMs, payloads: f.markers.map((m) => m.payload) } : null,
          serverCalibration: cal ? { ok: cal.ok, reason: cal.reason ?? null, errM: cal.reprojErrorMeters, anchors: cal.anchorCount } : null,
          board: sess.world,
        }
      : { error: "no such session", sessions: [...sessions.keys()] };
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(body, null, 2));
  }
  if (url.pathname === "/api/info") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(info()));
  }
  if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
    // CORS + Chrome Private Network Access preflight, so sketches on https sites can read the local feed.
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-allow-headers": "*", "access-control-allow-private-network": "true" });
    return res.end();
  }
  const snapMatch = url.pathname.match(/^\/api\/snapshot\/([A-Za-z0-9]{4})$/);
  if (snapMatch && req.method === "POST") {
    // Diagnostic: the phone uploads its raw camera frame + scanner stats; saved to ./snapshots for analysis.
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const dir = join(ROOT, "snapshots");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const base = join(dir, `${stamp}-${snapMatch[1].toUpperCase()}`);
        const b64 = String(body.image ?? "").replace(/^data:image\/\w+;base64,/, "");
        writeFileSync(base + ".jpg", Buffer.from(b64, "base64"));
        delete body.image;
        writeFileSync(base + ".json", JSON.stringify(body, null, 2));
        console.log(`  📸 snapshot saved: ${base}.jpg`);
        const sess = sessions.get(snapMatch[1].toUpperCase());
        if (sess?.board) send(sess.board, { t: "error", message: `Phone snapshot saved: snapshots/${stamp}-${snapMatch[1].toUpperCase()}.jpg` });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, file: base + ".jpg" }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e));
      }
    });
    return;
  }
  const stateMatch = url.pathname.match(/^\/api\/session\/([A-Za-z0-9]{4})\/state$/);
  if (stateMatch) {
    // Read-only, CORS-enabled feed for Procession / p5.js sketches (see docs/PROCESSION_INTEGRATION.md).
    const sess = sessions.get(stateMatch[1].toUpperCase());
    res.writeHead(sess?.world ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-private-network": "true" });
    return res.end(JSON.stringify(sess?.world ?? { error: "no such session or no state yet" }));
  }
  const page = PAGES[url.pathname.replace(/\/$/, "") || "/"];
  if (page) req.url = page + url.search;
  if (viteMiddleware) {
    return viteMiddleware(req, res, () => {
      res.writeHead(404);
      res.end("Not found");
    });
  }
  const dist = join(ROOT, "dist");
  const path = normalize(join(dist, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)));
  if (!path.startsWith(dist) || !existsSync(path)) {
    res.writeHead(404);
    return res.end("Not found — did you run `npm run build`?");
  }
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": path.includes("/assets/") ? "max-age=31536000" : "no-cache" });
  res.end(readFileSync(path));
}

const httpServer = createHttp(handler);
const { key, cert } = await loadCert();
const httpsServer = createHttps({ key, cert }, handler);

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", handleSocket);
for (const srv of [httpServer, httpsServer]) {
  srv.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return; // Vite HMR handles its own upgrades on HTTP
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}

if (DEV) {
  const { createServer } = await import("vite");
  const vite = await createServer({ root: ROOT, appType: "mpa", server: { middlewareMode: true, hmr: { server: httpServer } } });
  viteMiddleware = vite.middlewares as unknown as typeof viteMiddleware;
}

httpServer.listen(HTTP_PORT, () => {
  httpsServer.listen(HTTPS_PORT, () => {
    const ips = lanIps();
    console.log(`\n  🧛 DRACULA — HIDE BEFORE THE SUN  (${DEV ? "dev" : "production build"})\n`);
    console.log(`  Laptop board :  http://localhost:${HTTP_PORT}/board`);
    for (const ip of ips) console.log(`  Phone camera :  https://${ip}:${HTTPS_PORT}/camera   (accept the certificate warning once)`);
    if (PUBLIC_URL) console.log(`  Tunnel       :  ${PUBLIC_URL}/camera`);
    console.log(`  Markers      :  http://localhost:${HTTP_PORT}/markers\n`);
  });
});
