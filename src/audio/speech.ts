/**
 * Event-driven voice. Lines are spoken only when the game dispatches them (never per frame).
 * Every line is mirrored as a subtitle. Browsers block audio until a user gesture: call unlock()
 * from the START click.
 */
export type Speaker = "dracula" | "narrator";

export class Voice {
  muted = false;
  unlocked = false;
  onSubtitle: (text: string, speaker: Speaker) => void = () => {};
  onSubtitleClear: () => void = () => {};
  private voices: SpeechSynthesisVoice[] = [];
  private clearTimer = 0;

  constructor() {
    if (!("speechSynthesis" in window)) return;
    const load = () => (this.voices = speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener?.("voiceschanged", load);
  }

  unlock() {
    this.unlocked = true;
    if (!("speechSynthesis" in window)) return;
    // A silent utterance inside the click handler unlocks speech on Safari/Chrome.
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  private pick(speaker: Speaker): SpeechSynthesisVoice | undefined {
    const en = this.voices.filter((v) => v.lang.startsWith("en"));
    const prefs = speaker === "dracula" ? ["Daniel", "Google UK English Male", "Arthur", "Fred", "Alex", "Male"] : ["Samantha", "Google US English", "Karen", "Female"];
    for (const p of prefs) {
      const v = en.find((x) => x.name.includes(p));
      if (v) return v;
    }
    return en[0];
  }

  /** Speak a line (interrupting any current line). Resolves when finished (or after a timeout). */
  say(text: string, speaker: Speaker = "dracula"): Promise<void> {
    this.onSubtitle(text, speaker);
    clearTimeout(this.clearTimer);
    const readMs = 1200 + text.length * 55;
    const done = () => {
      clearTimeout(this.clearTimer);
      this.clearTimer = window.setTimeout(() => this.onSubtitleClear(), 1400);
    };
    if (this.muted || !this.unlocked || !("speechSynthesis" in window)) {
      return new Promise((r) => setTimeout(() => (done(), r()), readMs));
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = this.pick(speaker);
    if (v) u.voice = v;
    u.pitch = speaker === "dracula" ? 0.75 : 1;
    u.rate = speaker === "dracula" ? 0.98 : 1.04;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        done();
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      setTimeout(finish, readMs + 4000); // some browsers never fire onend
      speechSynthesis.speak(u);
    });
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m && "speechSynthesis" in window) speechSynthesis.cancel();
  }
}
