/** Decorative pixel artwork only. No game state, hit areas, sun or shadow rules live here. */
import { bbox } from "../engine/geometry.ts";
import type { Building, Vec2 } from "../engine/types.ts";

const bitmaps = new Map<string, HTMLCanvasElement>();
function bitmap(key: string, w: number, h: number, paint: (c: CanvasRenderingContext2D) => void) {
  let image = bitmaps.get(key);
  if (!image) {
    image = document.createElement("canvas"); image.width = w; image.height = h;
    paint(image.getContext("2d")!); bitmaps.set(key, image);
  }
  return image;
}
function box(c: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) {
  c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
function pattern(c: CanvasRenderingContext2D, kind: "grass" | "stone") {
  const image = bitmap(kind, kind === "grass" ? 32 : 16, kind === "grass" ? 32 : 12, p => {
    if (kind === "grass") {
      box(p, "#8bbf72", 0, 0, 32, 32);
      box(p, "#86b96d", 0, 0, 12, 12); box(p, "#90c477", 18, 16, 14, 16);
      box(p, "#71a45d", 4, 8, 1, 2); box(p, "#a6d488", 5, 7, 1, 2);
      box(p, "#79ad64", 22, 24, 2, 1); box(p, "#a1cf81", 23, 22, 1, 2);
      box(p, "#83b56b", 14, 4, 2, 1);
    } else {
      box(p, "#8ca6a2", 0, 0, 16, 12);
      for (const [x,y] of [[0,0],[8,0],[-4,6],[4,6],[12,6]]) {
        box(p, "#bacdc4", x+1, y+1, 7, 5); box(p, "#d5e0cf", x+2, y+1, 5, 1);
        box(p, "#a3bdb4", x+2, y+5, 5, 1); box(p, "#c9d8c8", x+2, y+2, 5, 2);
      }
    }
  });
  const pat = c.createPattern(image, "repeat")!;
  pat.setTransform(new DOMMatrix().scale(.5));
  return pat;
}
function polygon(c: CanvasRenderingContext2D, points: Vec2[]) {
  c.beginPath(); points.forEach((p,i)=> i ? c.lineTo(p.x,p.y) : c.moveTo(p.x,p.y)); c.closePath();
}

export function drawMeadow(c: CanvasRenderingContext2D, w: number, h: number) {
  c.save(); c.fillStyle=pattern(c,"grass"); c.fillRect(0,0,w,h);
  // Small clusters, rather than a noisy texture covering every pixel.
  const flower = bitmap("flowers", 11, 10, p => {
    box(p,"#649352",3,4,1,5); box(p,"#649352",8,6,1,4);
    box(p,"#fff1b2",2,2,3,3); box(p,"#e3b05c",3,3,1,1);
    box(p,"#f3bac0",7,4,3,3); box(p,"#b87487",8,5,1,1);
    box(p,"#accf7a",1,7,2,1); box(p,"#accf7a",9,8,2,1);
  });
  c.imageSmoothingEnabled=false;
  for (const [x,y] of [[48,49],[62,88],[54,148],[134,198],[274,162],[273,47],[185,198],[276,118],[55,202],[119,20]]) c.drawImage(flower,x,y,5.5,5);
  c.restore();
}
export function drawTownTiles(c: CanvasRenderingContext2D, poly: Vec2[]) {
  c.save(); polygon(c,poly); c.clip(); const b=bbox(poly);
  c.fillStyle=pattern(c,"stone"); c.fillRect(b.minX,b.minY,b.maxX-b.minX,b.maxY-b.minY); c.restore();
}
export function drawTownStreet(c: CanvasRenderingContext2D, pts: Vec2[], width: number) {
  c.save(); c.lineCap="butt"; c.lineJoin="miter";
  c.beginPath(); pts.forEach((p,i)=>i ? c.lineTo(p.x,p.y) : c.moveTo(p.x,p.y));
  c.strokeStyle="#6c945d"; c.lineWidth=width+1.8; c.stroke();
  c.strokeStyle=pattern(c,"stone"); c.lineWidth=width; c.stroke();
  c.restore();
}
function treeImage() {
  return bitmap("tree", 26, 34, c => {
    box(c,"#729c5e",3,29,20,3);
    box(c,"#76533d",11,22,5,10); box(c,"#ad8051",12,23,2,8);
    box(c,"#365e49",7,2,12,3); box(c,"#365e49",4,5,18,4); box(c,"#365e49",2,9,22,13); box(c,"#365e49",5,22,16,5); box(c,"#365e49",8,27,10,2);
    box(c,"#4e8555",6,6,14,15); box(c,"#4e8555",4,10,3,10); box(c,"#4e8555",8,21,10,3);
    box(c,"#70a263",8,4,9,4); box(c,"#70a263",5,9,4,6); box(c,"#8db877",9,5,5,2);
    box(c,"#60945b",13,12,6,5); box(c,"#426e4b",17,20,3,3);
  });
}
export function drawTownTrees(c: CanvasRenderingContext2D, poly: Vec2[]) {
  const b=bbox(poly); c.save(); polygon(c,poly); c.clip(); c.imageSmoothingEnabled=false;
  // More breathing room between tree canopies; all decoration stays inside the existing park.
  for(let x=b.minX+10;x<b.maxX-6;x+=19) for(let y=b.minY+13;y<b.maxY-4;y+=25) c.drawImage(treeImage(),x-6.5,y-13,13,17);
  // A small wooden park bench.
  const x=b.minX+9, y=b.maxY-7;
  c.fillStyle="#73523b";c.fillRect(x,y,12,3);c.fillRect(x+1,y+3,1,2);c.fillRect(x+10,y+3,1,2);
  c.fillStyle="#c49a60";c.fillRect(x+.5,y+.5,11,1);c.fillRect(x+.5,y+2,11,1);
  c.restore();
}
export function drawTownFountain(c: CanvasRenderingContext2D, center: Vec2) {
  c.save();c.translate(center.x,center.y);c.imageSmoothingEnabled=false;
  const image=bitmap("fountain",26,24,p=>{
    box(p,"#687a7c",5,8,16,14);box(p,"#687a7c",2,11,22,8);
    box(p,"#b3c0ad",5,7,16,13);box(p,"#cbd1b8",3,10,20,7);
    box(p,"#5dabc0",6,10,14,8);box(p,"#86d4d6",7,11,12,5);
    box(p,"#e3f1da",8,13,4,1);box(p,"#e3f1da",15,15,3,1);
    box(p,"#7c9590",11,4,4,11);box(p,"#bfcdb7",12,3,2,10);
    box(p,"#79ccd5",10,2,6,3);box(p,"#c7eee0",11,1,4,1);
  });
  c.drawImage(image,-6.5,-6,13,12);c.restore();
}
const shopRoofs: Record<string, string[]> = {
  kiosk: ["#bc785b", "#d69b76", "#925b48"],
  cafe: ["#ba777e", "#d49a9b", "#925c69"],
  library: ["#6b93a1", "#91b7bf", "#4e7384"],
  station: ["#748b69", "#9caf87", "#536d51"],
};
const roofs={LOW:["#639278","#7dac89","#466956"],MEDIUM:["#bb635c","#d48273","#8e4d49"],HIGH:["#896ba6","#a98dc2","#69517f"]};
export function drawTownBuilding(c: CanvasRenderingContext2D, b: Building, extrusion: number) {
  const bounds=bbox(b.footprint), w=bounds.maxX-bounds.minX,h=bounds.maxY-bounds.minY;
  const left=extrusion*.35, totalW=w+left,totalH=h+extrusion;
  const image=bitmap(`house:${b.id}:${w}:${h}:${b.displayHeightCategory}`,Math.ceil(totalW*2),Math.ceil(totalH*2),p=>{
    // Paint at a fixed two-pixels-per-world-unit grid, then cache the static sprite.
    const W=p.canvas.width,H=p.canvas.height,cat=b.displayHeightCategory;
    const roof=cat === "LOW" ? shopRoofs[b.id] ?? roofs.LOW : roofs[cat]; const roofH=Math.round(H*(cat==="HIGH"?.38:cat==="MEDIUM"?.49:.5));
    box(p,"#555044",0,0,W,H);
    box(p,"#f1e4bc",2,roofH,W-4,H-roofH-2);
    box(p,"#d6cfa9",W-7,roofH,5,H-roofH-2);
    // Masonry is sparse and warm. Windows and doors carry the detail.
    for(let y=roofH+5;y<H-5;y+=9) for(let x=4+((y%2)*4);x<W-7;x+=16) box(p,"#d8d1b0",x,y,7,2);
    const floor=cat==="HIGH"?2:1, winW=Math.max(7,Math.round(W*.14)),winH=Math.max(10,Math.round((H-roofH)*.25));
    const window=(x:number,y:number)=>{
      box(p,"#776951",x-2,y-2,winW+4,winH+4);box(p,"#f9efcf",x-1,y-1,winW+2,winH+2);
      box(p,"#5296ad",x,y,winW,winH);box(p,"#8ad0d5",x+1,y+1,winW-2,winH-2);
      box(p,"#c4e8db",x+1,y+1,2,winH-4);box(p,"#e4f1d8",x+1,y+2,winW-2,1);
      box(p,"#e4f1d8",x+Math.floor(winW/2),y,1,winH);box(p,"#ac956a",x-2,y+winH+2,winW+4,2);
    };
    for(let f=0;f<floor;f++) {
      const y=roofH+7+f*(winH+7);window(7,y);window(W-7-winW,y);
    }
    const doorW=Math.max(10,Math.round(W*.22)),doorH=Math.min(H-roofH-7,Math.round(H*.29));
    const dx=Math.round((W-doorW)/2),dy=H-doorH-3;
    box(p,"#66503b",dx-2,dy-3,doorW+4,doorH+6);box(p,"#bf8b55",dx,dy,doorW,doorH);
    box(p,"#d3a36a",dx+1,dy+1,doorW-2,2);
    for(let x=dx+3;x<dx+doorW;x+=4)box(p,"#a57349",x,dy+3,1,doorH-4);
    box(p,"#f5da87",dx+doorW-4,dy+Math.round(doorH*.55),2,2);
    box(p,"#c6b28c",dx-3,H-3,doorW+6,3);
    // Shingled roof. A bright ridge and dark eaves make the silhouette readable.
    box(p,roof[0],2,2,W-4,roofH-3);box(p,roof[1],3,2,W-6,2);
    for(let x=5;x<W-3;x+=8) {
      box(p,roof[2],x,5,1,roofH-8);box(p,roof[1],x+1,5,1,roofH-9);
    }
    for(let y=12;y<roofH-3;y+=11)box(p,roof[2],3,y,W-6,1);
    box(p,roof[2],1,roofH-3,W-2,3);box(p,"#d6b78b",1,roofH,W-2,2);
    // Small brick chimney; it stays inside the original visual silhouette.
    box(p,"#675b50",W-17,4,8,12);box(p,"#b58d76",W-16,5,6,10);box(p,"#dfba90",W-17,4,8,2);
    if(cat==="LOW") {
      // A little shop awning, with two discreet planters on the stoop.
      const ay=roofH+3;box(p,roof[2],W*.28,ay,W*.44,5);
      for(let x=Math.round(W*.28);x<W*.72;x+=5)box(p,"#f0e3b6",x,ay,2,5);
      for(const x of [3,W-8]){box(p,"#9b6650",x,H-8,5,6);box(p,"#4d8051",x-1,H-12,7,5);box(p,"#81ab65",x,H-13,4,3);}
    }
  });
  c.save();c.imageSmoothingEnabled=false;
  c.drawImage(image,bounds.minX-left,bounds.minY-extrusion,totalW,totalH);c.restore();
}
export function drawDraculaSprite(c: CanvasRenderingContext2D, p: Vec2) {
  const image=bitmap("dracula",32,40,p=>{
    box(p,"#6c845d",6,36,20,2);
    // Cloak, lined with raspberry red.
    box(p,"#42364f",8,23,16,13);box(p,"#42364f",5,28,22,8);box(p,"#744868",9,25,14,11);
    box(p,"#b56278",12,25,8,9);box(p,"#cf8190",13,26,3,7);
    box(p,"#303345",10,35,5,3);box(p,"#303345",18,35,5,3);
    // Ears, cream face, and lavender fringe.
    box(p,"#d6ab91",6,14,20,6);box(p,"#f5d4ad",8,10,16,12);box(p,"#eabf9d",9,21,14,3);
    box(p,"#443752",7,6,19,7);box(p,"#443752",6,10,4,6);box(p,"#443752",23,10,4,7);
    box(p,"#775c89",9,5,13,6);box(p,"#9a7ca5",10,5,9,3);box(p,"#775c89",7,9,7,4);
    box(p,"#443752",16,10,4,4);box(p,"#775c89",20,8,4,5);
    box(p,"#343548",11,16,2,3);box(p,"#343548",20,16,2,3);box(p,"#ffffff",11,16,1,1);box(p,"#ffffff",20,16,1,1);
    box(p,"#e4a395",9,20,3,1);box(p,"#e4a395",21,20,3,1);
    box(p,"#a46472",15,21,4,1);box(p,"#fff9dc",15,21,1,2);box(p,"#fff9dc",18,21,1,2);
    box(p,"#fff1d1",11,24,4,3);box(p,"#fff1d1",19,24,4,3);box(p,"#d29c62",16,27,2,2);
  });
  c.save();c.imageSmoothingEnabled=false;c.drawImage(image,p.x-8,p.y-18,16,20);c.restore();
}

export function drawTownSun(c: CanvasRenderingContext2D, center: Vec2, reveal: number) {
  const image=bitmap("sun",32,32,p=>{
    for(const [x,y,w,h] of [[15,0,2,4],[15,28,2,4],[0,15,4,2],[28,15,4,2],[4,4,3,3],[25,4,3,3],[4,25,3,3],[25,25,3,3]])box(p,"#dcab52",x,y,w,h);
    box(p,"#bf944b",9,5,14,22);box(p,"#bf944b",5,9,22,14);
    box(p,"#f1ce77",9,6,14,20);box(p,"#f1ce77",6,9,20,14);
    box(p,"#ffe7a3",10,7,11,3);box(p,"#ffe7a3",7,11,3,8);
    box(p,"#916a43",11,14,2,3);box(p,"#916a43",20,14,2,3);box(p,"#916a43",15,20,4,1);
    box(p,"#eeb280",9,19,3,1);box(p,"#eeb280",22,19,3,1);
  });
  c.save();c.translate(center.x,center.y);c.scale(reveal,reveal);c.imageSmoothingEnabled=false;c.drawImage(image,-16,-16,32,32);c.restore();
}
