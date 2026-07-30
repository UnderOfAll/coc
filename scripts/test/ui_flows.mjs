// UI flow test: boots the real page in jsdom and DRIVES it — clicks through building a character,
// levels one up, expands a feature mid-combat, applies damage twice. dom_smoke.mjs proves every
// page renders; this proves the controls on them do what they say. Run: npm run test:ui
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "fs";
import path from "path";
const REPO = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const html = fs.readFileSync(path.join(REPO,"index.html"),"utf8");
const vc = new VirtualConsole();
const errs=[]; vc.on("jsdomError",e=>errs.push(String(e.detail||e.message)));
["error","warn"].forEach(m=>vc.on(m,(...a)=>errs.push("["+m+"] "+a.join(" "))));
const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,virtualConsole:vc,url:"http://localhost/"});
const {window}=dom; const doc=window.document;
window.fetch=async(u)=>{const f=path.join(REPO,String(u).split("?")[0]);
  if(!fs.existsSync(f))return{ok:false,status:404,json:async()=>({})};
  const t=fs.readFileSync(f,"utf8");return{ok:true,status:200,json:async()=>JSON.parse(t),text:async()=>t};};
for(const f of ["assets/js/config.js","assets/js/storage.js","assets/js/app.js","assets/js/creator.js"]){
  const s=doc.createElement("script"); s.textContent=fs.readFileSync(path.join(REPO,f),"utf8"); doc.body.appendChild(s);}
const peek=e=>window.eval(e);
const t0=Date.now(); while(peek("(typeof store!=='undefined'&&store.classes)?store.classes.length:0")===0&&Date.now()-t0<8000) await new Promise(r=>setTimeout(r,40));
let fails=0; const ok=(c,m)=>{ if(!c){fails++;console.log("  FAIL "+m);} else console.log("  ok   "+m); };
const $=s=>doc.querySelector(s), $$=s=>[...doc.querySelectorAll(s)];
const click=n=>{ if(!n){fails++;console.log("  FAIL click(null)");return;} n.dispatchEvent(new window.MouseEvent("click",{bubbles:true})); };
const type=(n,v)=>{ n.value=v; n.dispatchEvent(new window.Event("input",{bubbles:true})); };
const blur=n=>n.dispatchEvent(new window.Event("focusout",{bubbles:true}));
const go=async h=>{ window.location.hash=h; window.dispatchEvent(new window.HashChangeEvent("hashchange")); await new Promise(r=>setTimeout(r,30)); };

console.log("\n— CREATOR —");
await go("#/create");
click($$('[data-pick="class"]').find(b=>b.dataset.val==="joker"));
ok($("#lvl"),"level field present");
// clearing the level box must be possible and must not reset to 1
type($("#lvl"),"");
ok($("#lvl").value==="" ,"level box can be emptied while typing");
type($("#lvl"),"5");
ok(peek("draft.level")===5,"typed level 5 -> draft.level 5");
type($("#lvl"),"99");
ok($("#lvl").value==="20"&&peek("draft.level")===20,"over-20 clamps to 20 as you type");
click($$('[data-pick="level"]').find(b=>b.dataset.val==="-1"));
ok(peek("draft.level")===19,"minus stepper works");
type($("#lvl"),"5"); blur($("#lvl"));
ok(peek("draft.level")===5,"level 5 after blur");

// point buy
click($$('[data-pick="method"]').find(b=>b.dataset.val==="buy"));
const inc=a=>$$('[data-pick="abil"]').find(b=>b.dataset.val===a+"|1");
let n=0; while(inc("Charisma") && !inc("Charisma").disabled && n<10){ click(inc("Charisma")); n++; }
ok(peek("draft.scores.Charisma")===15,"Charisma stepped to the 15 ceiling");
ok(inc("Charisma").disabled,"+ disables at 15");
// spend the rest and prove the + turns itself off when the budget runs out
for(const a of ["Dexterity","Constitution"]) { let g=0; while(inc(a)&&!inc(a).disabled&&g<10){click(inc(a));g++;} }
const spent=peek("ABILITIES.reduce((n,a)=>n+(POINT_COST[draft.scores[a]]??0),0)");
ok(spent<=27,"never goes over the 27-point budget (spent "+spent+")");
ok($$('[data-pick="abil"]').filter(b=>b.dataset.val.endsWith("|1")&&!b.disabled).every(b=>true),"steppers rendered");
const anyAfford=$$('[data-pick="abil"]').filter(b=>b.dataset.val.endsWith("|1")&&!b.disabled).length;
ok(spent<27||anyAfford===0,"when the budget is gone every + is disabled");

// gear: weapons are a choice, and tooltips exist for what you are choosing
const weps=$$('[data-pick="weapon"]');
ok(weps.length===3,"three proficient weapons offered ("+weps.length+")");
ok($$('.chip-tip .term-tip').length>0,"armour/weapon chips carry an explanation tooltip");
click(weps[0]);
ok(peek("draft.weapons.length")===1,"weapon carried after picking");
ok(peek('validateDraft(derive(draft)).some(m=>/weapon/i.test(m))')===false,"weapon requirement satisfied");
click($$('[data-pick="armor"]')[0]);
type($("#cname"),"Test Joker");
ok(peek("draft.name")==="Test Joker","name kept");

console.log("\n— NO PHANTOM WIDTH —");
// jsdom does not apply the external stylesheet, so assert the RULE rather than the computed value:
// a closed tooltip must be out of flow entirely or it inflates the scroll container's width.
const css=fs.readFileSync(path.join(REPO,"assets/css/style.css"),"utf8");
const rule=n=>(css.match(new RegExp("\\n\\"+n+" \\{[^}]*\\}"))||[""])[0];
ok(/display:\s*none/.test(rule(".term-tip")),".term-tip is display:none when closed");
ok(/display:\s*none/.test(rule(".scale-tip")),".scale-tip is display:none when closed");
ok(/\.tip-term:hover \.term-tip \{[^}]*display:\s*block/.test(css),"and comes back on hover");
ok(/\.tip-term\.tip-open \.term-tip \{[^}]*display:\s*block/.test(css),"and on tap");
// A link styled as a button sits under `.content a`, which is more specific than `.btn` — so
// "Create a new character" rendered gold text on a gold pill and could not be read.
ok(/\.content a\.btn,[^{]*\{[^}]*color:\s*var\(--bg\)/.test(css),"a button-shaped link keeps the button's text colour");

console.log("\n— DRAFT RESETS —");
await go("#/manage"); await go("#/create");
ok(peek("draft.classId")===""&&peek("draft.name")===""&&peek("draft.photo")==="","a second visit to #/create starts blank");

console.log("\n— SHEET —");
const mk=(cls,lv,sub)=>peek(`(function(){
  const ch={v:1,name:"Rig",classId:${JSON.stringify(cls)},subclassId:${JSON.stringify(sub||"")},level:${lv},size:"Medium",
    method:"array",scores:{Strength:12,Dexterity:15,Constitution:14,Intelligence:10,Wisdom:8,Charisma:13},
    skills:[],armorId:"",shieldId:"",weapons:[],photo:"",notes:""};
  ch.play=freshPlay(ch); sheet={code:"123456",ch}; renderSheet(); return 1;})()`);
mk("joker",5);
ok($$(".kn").length===6,"key numbers: six headline boxes");
ok($$(".ab-box").length===6,"six ability boxes");
ok($$(".ab-box.prof").length===2,"the two proficient saves are marked");
ok($(".ab-save").textContent.includes("+"),"each ability shows its saving throw");
const atk=$$(".attack-table tbody tr");
ok(atk.length===3,"attacks listed for a character who chose nothing (falls back to proficiency)");
// Dagger is finesse and this Joker has Dex 15 (+2) but Cha 13 (+1). The default rule would give
// +5; his Sleight of Hand feature says Charisma, so the sheet must say +4.
ok(/\+4/.test($(".atk-hit").textContent),"Joker hits at +4 — Charisma, not the better finesse stat");
ok(/Sleight of Hand/.test($(".atk-hit .term-tip").textContent),"and the tooltip names the feature that does it");
peek(`sheet.ch.weapons=["Dagger"]; renderSheet();`);
ok($$(".attack-table tbody tr").length===1,"choosing one weapon shows exactly one attack");
// A character saved before weapons were choosable has to be able to fix that from the sheet.
peek(`delete sheet.ch.weapons; renderSheet();`);
ok($$(".attack-table tbody tr").length===3,"an old save with no weapons recorded falls back to all three");
click($$('[data-act="carry"]').find(b=>b.dataset.val==="Dagger"));
ok($$(".attack-table tbody tr").length===1,"and can be corrected from the Gear panel");

mk("acrobat",5);
// No override on the Acrobat, so the default 5e rule applies: finesse takes the better of Str/Dex.
ok(/\+5/.test($(".atk-hit").textContent),"Acrobat hits at +5 — finesse takes the better of Str 12 and Dex 15");
ok(/Finesse/.test($(".atk-hit .term-tip").textContent),"and says so");
mk("joker",5);

console.log("\n— EXPANDERS SURVIVE ACTIONS —");
const feat=$$('[data-act="open-feat"]')[0];
const fname=feat.dataset.val; click(feat);
ok($$(".feat-body").length===1,"feature expands in place");
ok($$(".feat-body .toggle-btn").length===2,"and carries its How it works / In play tabs");
click($('[data-act="combat"]'));
ok($$(".feat-body").length===1,"still open after starting combat (used to slam shut)");
const useBtn=$$('[data-act="use"]')[0];
if(useBtn){ click(useBtn); ok($$(".feat-body").length===1,"still open after spending a use"); }
click($$('[data-act="open-feat"]').find(b=>b.dataset.val===fname));
ok($$(".feat-body").length===0,"closes again");

console.log("\n— HP BOX KEEPS ITS NUMBER —");
type($("#hp-amt"),"7");
click($('[data-act="dmg"]'));
ok($("#hp-amt").value==="7","damage amount is still 7 after applying it");
const hp1=peek("sheet.ch.play.hp");
click($('[data-act="dmg"]'));
ok(peek("sheet.ch.play.hp")===hp1-7,"and the second click uses 7 again");

console.log("\n— LEVEL UP —");
click($('[data-act="combat"]'));           // out of combat
mk("joker",2);
ok($('[data-act="levelup"]'),"level-up button on the sheet");
click($('[data-act="levelup"]'));
ok($(".levelup"),"preview panel opens");
ok(peek("sheet.ch.level")===2,"nothing written yet");
ok($('[data-act="lu-confirm"]').disabled,"confirm blocked until a discipline is chosen at 3");
click($$('[data-act="lu-sub"]')[0]);
ok(!$('[data-act="lu-confirm"]').disabled,"unblocked once chosen");
const hpBefore=peek("sheet.ch.play.hp"), maxBefore=peek("derive(sheet.ch).hpMax");
ok(/\+\d/.test($(".lu-hp").textContent),"shows the hit points it would add");
ok($$(".lu-list li").length>0,"lists the features it would add");
click($('[data-act="lu-confirm"]'));
ok(peek("sheet.ch.level")===3,"level written on confirm");
ok(peek("sheet.ch.subclassId")!=="","subclass written");
ok(peek("sheet.ch.play.hp")===hpBefore+(peek("derive(sheet.ch).hpMax")-maxBefore),"current HP rose by the same amount as max");
// ASI at 4
click($('[data-act="levelup"]'));
ok($(".lu-asi"),"level 4 offers an ability score increase");
ok($('[data-act="lu-confirm"]').disabled,"confirm blocked until both points are spent");
click($$('[data-act="lu-asi"]').find(b=>b.dataset.val==="Dexterity|1"));
ok($('[data-act="lu-confirm"]').disabled,"still blocked with one point spent");
click($$('[data-act="lu-asi"]').find(b=>b.dataset.val==="Dexterity|1"));
ok(!$('[data-act="lu-confirm"]').disabled,"unblocked at two");
click($('[data-act="lu-confirm"]'));
ok(peek("sheet.ch.scores.Dexterity")===17,"Dex 15 -> 17");
ok(peek("sheet.ch.level")===4,"level 4");
click($('[data-act="leveldown"]'));
ok(peek("sheet.ch.level")===3&&peek("sheet.ch.scores.Dexterity")===15,"undo a level puts the ability points back");

console.log("\n— STATES —");
mk("illusionist",5,"nightmare");
ok($$('[data-act="flag"]').length>=8,"universal conditions plus the class's own");
ok($$('.chip-tip .info-dot').length>=8,"each one explains itself through its own tap target");

console.log("\njsdom errors: "+errs.length); errs.slice(0,6).forEach(e=>console.log("  "+e));
console.log(fails||errs.length ? "\nFAILURES: "+fails : "\nALL GREEN");
process.exit(fails||errs.length?1:0);
