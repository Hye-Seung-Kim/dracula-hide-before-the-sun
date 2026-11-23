import type { ClientMsg, ServerMsg } from "./protocol.ts";

export type ConnState = "connecting" | "open" | "closed";

/** WebSocket with auto-reconnect. `onOpen` re-sends host/join so pairing survives Wi-Fi blips. */
export class GameSocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  state: ConnState = "closed";
  rtt = 0;
  onMessage: (m: ServerMsg) => void = () => {};
  onState: (s: ConnState) => void = () => {};
  onOpen: () => void = () => {};
  private pingTimer = 0;

  private url: string;

  constructor(url = defaultWsUrl()) {
    this.url = url;
  }

  connect() {
    this.closedByUser = false;
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setState("open");
      this.onOpen();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: "ping", at: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as ServerMsg;
      if (m.t === "pong") this.rtt = performance.now() - m.at;
      this.onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.setState("closed");
      if (this.closedByUser) return;
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }

  send(m: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    // Drop frames if the socket is congested rather than building latency.
    if (m.t === "frame" && this.ws.bufferedAmount > 64 * 1024) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  private setState(s: ConnState) {
    this.state = s;
    this.onState(s);
  }
}

export function defaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
