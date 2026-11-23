// p5.js sketch: mirrors the DRACULA board's tracked objects from the game server.
// Set CODE to the session code shown on the laptop board.
const CODE = "ABCD";
const URL = `http://localhost:5173/api/session/${CODE}/state`;
let state = null;

function setup() {
  createCanvas(640, 440); // same 320:220 aspect as the board
  setInterval(async () => {
    try {
      const r = await fetch(URL);
      if (r.ok) state = await r.json();
    } catch (e) { /* server not running */ }
  }, 100);
}

function draw() {
  background(243, 226, 189);
  fill(40); noStroke(); textSize(14);
  if (!state) return text("waiting for " + URL, 10, 20);
  text(`Level ${state.level} · ${state.phase} · calibrated ${state.calibrated}`, 10, 20);
  for (const [name, o, c] of [["Dracula", state.dracula, color(229, 72, 77)], ["Shield", state.shield, color(255, 181, 71)]]) {
    if (!o) continue;
    const x = o.nx * width, y = o.ny * height, a = radians(o.headingDeg);
    stroke(c); strokeWeight(3); noFill(); circle(x, y, 30);
    line(x, y, x + sin(a) * 40, y - cos(a) * 40);
    noStroke(); fill(c); text(name, x + 18, y - 18);
  }
  if (state.result) {
    textSize(48); fill(state.result.safe ? color(61, 220, 132) : color(229, 72, 77));
    text(state.result.safe ? "SAFE" : "BURNED", width / 2 - 80, height / 2);
  }
}
