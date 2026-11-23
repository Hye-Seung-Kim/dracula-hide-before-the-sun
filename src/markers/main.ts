import QRCode from "qrcode";
import { DRACULA_PAYLOAD, SHIELD_PAYLOAD } from "../engine/boardLayout.ts";

/** Draw a QR with ECC L (version 1, 21 modules) + 2-module quiet zone at an exact physical size. */
function qrCanvas(payload: string, mm: number): HTMLCanvasElement {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "L" });
  const n = qr.modules.size;
  const quiet = 2;
  const total = n + quiet * 2;
  const c = document.createElement("canvas");
  c.width = c.height = total * 8;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.modules.get(r, col)) g.fillRect((col + quiet) * 8, (r + quiet) * 8, 8, 8);
  // The printed size refers to the QR symbol itself; the quiet zone is extra.
  const full = (mm * total) / n;
  c.style.width = c.style.height = `${full}mm`;
  return c;
}

function build(mm: number) {
  const sheet = document.getElementById("sheet")!;
  sheet.innerHTML = "";
  for (let i = 0; i < 2; i++) {
    const d = document.createElement("div");
    d.className = "card";
    d.innerHTML = `<div class="arrow">▲ FACING</div>`;
    d.append(qrCanvas(DRACULA_PAYLOAD, mm));
    d.insertAdjacentHTML("beforeend", `<h3>DRACULA</h3><div class="note">${DRACULA_PAYLOAD} · ${mm} mm · glue on top of the figure, centered over his feet</div>`);
    sheet.append(d);
  }
  const s = document.createElement("div");
  s.className = "card shield-card";
  // The wall line must sit exactly 0.75 x QR size from the QR centre (= wallOffsetMarkerUnits in levels.ts):
  // symbol half-size (0.5) + quiet zone (2/21 modules) + spacer = 0.75.
  const spacer = mm * 0.25 - (mm * 2) / 21;
  s.innerHTML = `<div class="wall-label">▲ WALL STANDS ON THIS LINE ▲</div><div class="wall"></div><div style="height:${spacer.toFixed(2)}mm"></div>`;
  s.append(qrCanvas(SHIELD_PAYLOAD, mm));
  s.insertAdjacentHTML("beforeend", `<h3>SHIELD</h3><div class="note">${SHIELD_PAYLOAD} · ${mm} mm · arrow/wall side faces Dracula</div>`);
  sheet.append(s);
}

const sel = document.getElementById("size") as HTMLSelectElement;
sel.onchange = () => build(Number(sel.value));
build(Number(sel.value));
