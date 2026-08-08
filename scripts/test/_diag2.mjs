import puppeteer from "puppeteer";
const SITE="https://underofall.github.io/coc/index.html";
const DB="https://circus-of-chaos-78122-default-rtdb.europe-west1.firebasedatabase.app";
const ROOM="999124";
const db=async(p,m,b)=>{const r=await fetch(`${DB}/${p}.json`,m==="GET"?{}:{method:m,headers:{"Content-Type":"application/json"},body:b===undefined?undefined:JSON.stringify(b)});return {status:r.status, body:await r.text()};};
console.log("direct presence write:", JSON.stringify(await db(`tables/${ROOM}/presence/abc`,"PUT",{name:"x",role:"player",at:Date.now()})));
console.log("direct token write:", JSON.stringify(await db(`tables/${ROOM}/tokens/t1`,"PUT",{name:"Rig",charCode:"999321",image:"",x:1,y:1,size:1,kind:"pc",hp:20,hpMax:20,speed:30,initMod:2,color:"#c9a54e"})));
const b=await puppeteer.launch({args:["--no-sandbox"]});
const page=await b.newPage();
page.on("pageerror",e=>console.log("PAGEERROR:",e.message));
page.on("console",m=>{ if(m.type()==="error") console.log("CONSOLE:",m.text()); });
await page.goto(SITE,{waitUntil:"networkidle0"});
const out = await page.evaluate(async (room) => {
  const res = {};
  try { res.presence = await CocLive.put(`tables/${room}/presence/fromPage`, {name:"page",role:"player",at:Date.now()}); }
  catch (e) { res.presenceErr = e.message; }
  try { res.token = await CocLive.put(`tables/${room}/tokens/fromPage`, {name:"Page",charCode:"999321",image:"",x:2,y:2,size:1,kind:"pc",hp:5,hpMax:5,speed:30,initMod:1,color:"#c9a54e"}); }
  catch (e) { res.tokenErr = e.message; }
  try { const ch = await CocStore.load("999321"); res.charLoaded = !!ch; } catch(e) { res.charErr = e.message; }
  return res;
}, ROOM);
console.log("from the page:", JSON.stringify(out));
await b.close();
console.log("readback:", JSON.stringify(await db(`tables/${ROOM}`,"GET")));
await db(`tables/${ROOM}`,"DELETE");
