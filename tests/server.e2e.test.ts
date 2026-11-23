// Spawns the real server and checks: board hosts -> phone joins over WSS (HTTPS port) with the code ->
// frames reach the board, board status reaches the phone, camera commands reach the board, reconnect keeps the code.
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { makeVirtualCamera, simulateFrame } from "../src/engine/simulator.ts";
import { TrackingPipeline } from "../src/engine/tracking.ts";
import type { ServerMsg } from "../src/net/protocol.ts";

const HTTP = 5281;
const HTTPS = 5781;
let srv: ChildProcess;

beforeAll(async () => {
  srv = spawn(process.execPath, ["server/index.ts"], { env: { ...process.env, PORT: String(HTTP), HTTPS_PORT: String(HTTPS) }, stdio: "pipe" });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 15000);
    srv.stdout!.on("data", (d) => String(d).includes("Laptop board") && (clearTimeout(t), resolve()));
  });
}, 20000);
afterAll(() => srv?.kill());

function client(url: string) {
  const ws = new WebSocket(url, { rejectUnauthorized: false });
  const inbox: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as ServerMsg;
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.res(m));
  });
  const open = new Promise<void>((r) => ws.on("open", () => r()));
  const next = (pred: (m: ServerMsg) => boolean, ms = 3000) =>
    new Promise<ServerMsg>((res, rej) => {
      const found = inbox.find(pred);
      if (found) return res(found);
      waiters.push({ pred, res });
      setTimeout(() => rej(new Error("timeout waiting for message")), ms);
    });
  return { ws, open, next, send: (m: object) => ws.send(JSON.stringify(m)) };
}

describe("pairing + relay server", () => {
  it("phone -> laptop tracking relay over WSS with a session code", async () => {
    const board = client(`ws://localhost:${HTTP}/ws`);
    await board.open;
    board.send({ t: "host" });
    const hosted = (await board.next((m) => m.t === "hosted")) as Extract<ServerMsg, { t: "hosted" }>;
    expect(hosted.code).toMatch(/^[A-Z0-9]{4}$/);

    const phone = client(`wss://localhost:${HTTPS}/ws`);
    await phone.open;
    phone.send({ t: "join", code: "ZZZZ" });
    expect(((await phone.next((m) => m.t === "error")) as { message: string }).message).toMatch(/No game/);
    phone.send({ t: "join", code: hosted.code });
    await phone.next((m) => m.t === "joined");
    await board.next((m) => m.t === "peer" && m.cameras === 1);

    // A frame detected "on the phone" produces a coordinate update on the laptop.
    const cam = makeVirtualCamera({ rotationDeg: 30, keystone: 0.1 });
    const pipeline = new TrackingPipeline();
    let t = 1000;
    for (let i = 0; i < 6; i++, t += 80) {
      phone.send({ t: "frame", frame: simulateFrame(cam, { dracula: { position: { x: 140, y: 120 }, heading: 0 } }, hosted.code, t) });
      const m = (await board.next((x) => x.t === "frame" && x.frame.timestamp === t)) as Extract<ServerMsg, { t: "frame" }>;
      pipeline.ingest(m.frame, t);
    }
    const s = pipeline.snapshot(t);
    expect(s.calibration?.ok).toBe(true);
    expect(Math.hypot(s.dracula.pose!.position.x - 140, s.dracula.pose!.position.y - 120)).toBeLessThan(0.5);

    // laptop -> phone status, phone -> laptop calibration command
    board.send({ t: "boardStatus", status: { phase: "PREDICTION", level: 1, calibrated: true, anchorCount: 4, dracula: "tracked", shield: "none", calOptions: { mode: "auto", cornerOffset: 0 }, usesShield: false, message: "ok" } });
    await phone.next((m) => m.t === "boardStatus");
    phone.send({ t: "cameraCmd", cmd: { type: "rotateCorners" } });
    await board.next((m) => m.t === "cameraCmd");

    // Procession / p5.js read-only state feed
    board.send({ t: "worldState", state: { code: hosted.code, t: 1, phase: "PREDICTION", level: 1, calibrated: true, simulated: false, dracula: { status: "tracked", x: 160, y: 110, nx: 0.5, ny: 0.5, headingDeg: 0 }, shield: null, result: null } });
    await new Promise((r) => setTimeout(r, 100));
    const st = await fetch(`http://localhost:${HTTP}/api/session/${hosted.code}/state`);
    expect(st.headers.get("access-control-allow-origin")).toBe("*");
    expect((await st.json()).dracula.nx).toBe(0.5);

    // Laptop reload: re-host with the same code; the phone stays paired.
    board.ws.close();
    await phone.next((m) => m.t === "peer" && !m.board);
    const board2 = client(`ws://localhost:${HTTP}/ws`);
    await board2.open;
    board2.send({ t: "host", code: hosted.code });
    const h2 = (await board2.next((m) => m.t === "hosted")) as Extract<ServerMsg, { t: "hosted" }>;
    expect(h2.code).toBe(hosted.code);
    phone.send({ t: "frame", frame: simulateFrame(cam, {}, hosted.code, 99) });
    await board2.next((m) => m.t === "frame");
    phone.ws.close();
    board2.ws.close();
  }, 20000);

  it("serves the camera page over HTTPS and the board over HTTP", async () => {
    const r = await fetch(`http://localhost:${HTTP}/board`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Dracula Board");
    const info = await (await fetch(`http://localhost:${HTTP}/api/info`)).json();
    expect(info.httpsPort).toBe(HTTPS);
  });
});
