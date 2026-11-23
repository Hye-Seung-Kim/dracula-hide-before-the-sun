/** Tiny synthesized sound effects (no audio files). Requires unlock() from a user gesture. */
export class Sfx {
  private ctx: AudioContext | null = null;
  muted = false;

  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.18, glideTo?: number) {
    const c = this.ctx!;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime + start);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, c.currentTime + start + dur);
    g.gain.setValueAtTime(0.0001, c.currentTime + start);
    g.gain.exponentialRampToValueAtTime(gain, c.currentTime + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + start);
    o.stop(c.currentTime + start + dur + 0.05);
  }

  private noise(start: number, dur: number, from: number, to: number, gain = 0.2, type: BiquadFilterType = "bandpass") {
    const c = this.ctx!;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(from, c.currentTime + start);
    f.frequency.exponentialRampToValueAtTime(to, c.currentTime + start + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime + start);
    g.gain.exponentialRampToValueAtTime(gain, c.currentTime + start + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(c.currentTime + start);
  }

  play(name: "success" | "failure" | "reveal" | "ready" | "tick" | "chime" | "warn" | "connect" | "enter" | "exit") {
    if (this.muted || !this.ctx) return;
    switch (name) {
      case "success":
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.11, 0.35, "triangle", 0.2));
        this.tone(1568, 0.5, 0.6, "sine", 0.08);
        break;
      case "failure":
        this.noise(0, 1.4, 4000, 600, 0.25, "highpass"); // sizzle
        this.tone(330, 0.05, 0.9, "sawtooth", 0.08, 90);
        break;
      case "reveal":
        this.noise(0, 1.6, 300, 5000, 0.18);
        this.tone(220, 0, 1.6, "sine", 0.06, 880);
        break;
      case "ready":
        for (let i = 0; i < 8; i++) this.tone(140, i * 0.09, 0.07, "square", 0.05);
        break;
      case "tick":
        this.tone(1200, 0, 0.05, "sine", 0.06);
        break;
      case "chime":
        this.tone(988, 0, 0.25, "sine", 0.1);
        this.tone(1319, 0.08, 0.3, "sine", 0.08);
        break;
      case "warn":
        this.tone(220, 0, 0.18, "square", 0.08);
        this.tone(196, 0.2, 0.22, "square", 0.08);
        break;
      case "connect":
        this.tone(660, 0, 0.12, "triangle", 0.12);
        this.tone(880, 0.12, 0.18, "triangle", 0.12);
        break;
      case "enter":
        this.tone(740, 0, 0.12, "triangle", 0.08, 990);
        break;
      case "exit":
        this.tone(740, 0, 0.12, "triangle", 0.08, 520);
        break;
    }
  }
}
