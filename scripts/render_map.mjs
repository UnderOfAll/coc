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

// Any number of in/out pairs, because launching a browser per token costs more than every token put
// together: `render_map.mjs a.svg a.jpg b.svg b.jpg …`.
const args = process.argv.slice(2);
if (!args.length || args.length % 2) {
  console.error("usage: node scripts/render_map.mjs <in.svg> <out.jpg|out.png> [<in> <out> …]");
  process.exit(1);
}
const jobs = [];
for (let i = 0; i < args.length; i += 2) jobs.push({ src: args[i], dest: args[i + 1] });
const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
for (const { src, dest } of jobs) {
  const svg = fs.readFileSync(path.resolve(REPO, src), "utf8");
  const w = Number((svg.match(/width="(\d+)"/) || [])[1] || 1820);
  const h = Number((svg.match(/height="(\d+)"/) || [])[1] || 1260);
  // A battlemap is a photograph of sawdust, not a diagram: JPEG is a tenth of the size at no visible
  // cost. A token needs its corners TRANSPARENT, though — it is a disc on a board — so a .png keeps its
  // alpha and gets no background painted behind it.
  const jpeg = /\.jpe?g$/i.test(dest);
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  // `networkidle0` HANGS on the second call: the page it is waiting on has no requests to go idle from,
  // so the first render passes and every one after it times out at thirty seconds. Nothing here is
  // fetched — the SVG is inline — so `load` is both correct and instant.
  await page.setContent(`<style>html,body{margin:0;padding:0;background:${jpeg ? "#000" : "transparent"}}` +
    `svg{display:block}</style>${svg}`, { waitUntil: "load" });
  // Filters (turbulence, blurs) are rasterised on a later frame than the DOM settles on.
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot(Object.assign(
    { path: path.resolve(REPO, dest), type: jpeg ? "jpeg" : "png", omitBackground: !jpeg },
    jpeg ? { quality: 88 } : {}));
  const kb = (fs.statSync(path.resolve(REPO, dest)).size / 1024).toFixed(0);
  console.log(`wrote ${dest}  ${w}x${h}  ${kb} KB`);
}
await browser.close();
