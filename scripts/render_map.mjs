// Turn a drawn map into the picture a scene takes.
//
//   node scripts/render_map.mjs maps/midway.svg maps/midway.jpg
//
// SVG straight into the app would be simpler and is not what it wants: a scene's picture is squeezed
// through a canvas on upload (tblShrinkImage), and a canvas will not read an SVG that has no intrinsic
// size, nor will it read one at all in some engines once it carries a filter. So it is rendered ONCE
// here, in the same Chromium the gate already uses, and what lands in the repo is a flat image.
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const [src, dest] = process.argv.slice(2);
if (!src || !dest) { console.error("usage: node scripts/render_map.mjs <in.svg> <out.jpg|out.png>"); process.exit(1); }
// A battlemap is a photograph of sawdust, not a diagram: JPEG is a tenth of the size at no visible cost,
// and this repo is served off GitHub Pages to phones.
const jpeg = /\.jpe?g$/i.test(dest);
const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
const svg = fs.readFileSync(path.resolve(REPO, src), "utf8");
const w = Number((svg.match(/width="(\d+)"/) || [])[1] || 1820);
const h = Number((svg.match(/height="(\d+)"/) || [])[1] || 1260);

const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
await page.setContent(`<style>html,body{margin:0;padding:0;background:#000}svg{display:block}</style>${svg}`,
  { waitUntil: "networkidle0" });
// Filters (turbulence, blurs) are rasterised on a later frame than the DOM settles on.
await new Promise((r) => setTimeout(r, 600));
await page.screenshot(Object.assign({ path: path.resolve(REPO, dest), type: jpeg ? "jpeg" : "png" },
  jpeg ? { quality: 88 } : {}));
await browser.close();
const kb = (fs.statSync(path.resolve(REPO, dest)).size / 1024).toFixed(0);
console.log(`wrote ${dest}  ${w}x${h}  ${kb} KB`);
