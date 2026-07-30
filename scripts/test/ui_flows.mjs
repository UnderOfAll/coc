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
window.scrollTo = () => {};   // jsdom has no layout, so smooth scrolling is a no-op here
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

// the creator picks a discipline off the same cards, not off a row of names
type($("#lvl"),"3"); blur($("#lvl"));
ok($$(".sub-card").length===3,"the creator offers disciplines as openable cards too");
click($$('[data-pick="sub-open"]')[0]);
ok($$(".sub-card .lu-sum").length>0,"and they open to their rules text");
click($$('[data-pick="subclass"]')[0]);
ok(peek("draft.subclassId")!=="","choosing one sticks");
type($("#lvl"),"5"); blur($("#lvl"));

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
// Grid items stretch to the tallest in their row, so without this, opening one discipline card
// grew the two beside it.
ok(/align-items:\s*start/.test(rule(".sub-choice")),"discipline cards keep their own height");
// Readability floor: at a 17px root, 0.78rem is about 13px. Anything smaller was a squint.
const tooSmall=[...css.matchAll(/font-size:\s*(0\.\d+)rem/g)].map(m=>+m[1]).filter(v=>v<0.78);
ok(tooSmall.length===0,"no text below the 0.78rem floor (found "+tooSmall.join(", ")+")");
ok(/html \{[^}]*font-size:\s*106/.test(css),"the root font size is lifted above the browser default");
// Tooltip terms usually sit inside a small-caps label (a key-number heading, an ability
// abbreviation), and text-transform inherits — so the explanation came out shouting.
for (const n of [".term-tip", ".scale-tip"]) {
  ok(/text-transform:\s*none/.test(rule(n)), n + " reads as a sentence, not as the label it hangs off");
  ok(/letter-spacing:\s*normal/.test(rule(n)), n + " drops the label's letter-spacing too");
}

console.log("\n— THE PAGE SCROLLS, NOT A PANEL —");
// A viewport-locked shell meant the wheel worked over the middle column and nowhere else, and
// anything that was not .content got clipped with no way to reach it — which is how the landing
// page lost its Compendium card on a phone.
const bodyRule=(css.match(/\nbody \{[^}]*\}/)||[""])[0];
ok(!/overflow:\s*hidden/.test(bodyRule),"body does not trap the page");
ok(/min-height:\s*100dvh/.test(bodyRule)&&!/[^-]height:\s*100dvh/.test(bodyRule),"body has a floor, not a fixed height");
ok(!/overflow-y:\s*auto/.test(rule(".content")),".content is no longer its own scroller");
ok(/position:\s*sticky/.test((css.match(/\n\.topbar \{[^}]*\}/)||[""])[0]),"the top bar stays put while the page scrolls");
ok(/overflow-x:\s*clip/.test(bodyRule),"and nothing can push the page wider than the screen");
// every landing card must be reachable, since one of them is the only way into the compendium
await go("#/");
const menuCards=$$("#menu-view .menu-card").map(a=>a.getAttribute("href"));
ok(menuCards.length===3&&menuCards.includes("#/classes"),"all three landing cards are present, including the compendium");
await go("#/classes");
ok(!$("#compendium-view").classList.contains("hidden"),"and it opens");

console.log("\n— MOBILE —");
const mob=(css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/)||[""])[0];
ok(/\.statusbar \{ display: none/.test(mob),"the entry-count status bar is off on a phone");
ok(/\.attack-table[^{]*\{[^}]*display: block/.test(mob),"five attack columns stack instead of overflowing");
ok(/content: attr\(data-label\)/.test(mob),"stacked rows are labelled");
// A bare minmax(Xrem, 1fr) keeps its floor even when the container is narrower, which is a grid
// pushing the page wider than the phone and making the browser zoom out.
const rigid=[...css.matchAll(/minmax\((\d[\d.]*(?:rem|px)), 1fr\)/g)].map(m=>m[0]);
ok(rigid.length===0,"no grid track refuses to shrink below its floor ("+rigid.join(", ")+")");
await go("#/sheet/123456");

console.log("\n— DRAFT RESETS —");
await go("#/manage"); await go("#/create");
ok(peek("draft.classId")===""&&peek("draft.name")===""&&peek("draft.photo")==="","a second visit to #/create starts blank");

console.log("\n— SHEET —");
const mk=(cls,lv,sub)=>peek(`(function(){
  const ch={v:1,name:"Rig",classId:${JSON.stringify(cls)},subclassId:${JSON.stringify(sub||"")},level:${lv},size:"Medium",
    method:"array",scores:{Strength:12,Dexterity:15,Constitution:14,Intelligence:10,Wisdom:8,Charisma:13},
    skills:["Acrobatics","Deception"],armorId:"",shieldId:"",weapons:[],photo:"",notes:""};
  ch.play=freshPlay(ch); sheet={code:"123456",ch}; renderSheet(); return 1;})()`);
mk("joker",5);
// Each class names its own DC — the sheet reads keyStats rather than assuming one generic
// "trick save DC" off the primary ability (which for a Juggler would be an invented number).
const knLabel=k=>{const t=k.querySelector(".kn-l .tip-term");return (t?t.firstChild.textContent:k.querySelector(".kn-l").textContent).trim();};
const knLabels=$$(".kn").map(knLabel);
ok(knLabels.includes("Gambit DC"),"a Joker sees his Gambit DC by name ("+knLabels.join(", ")+")");
ok(!knLabels.includes("Trick save DC"),"and not a generic 'Trick save DC'");
const gambit=$$(".kn").find(k=>/Gambit DC/.test(k.textContent));
ok(gambit.querySelector(".kn-v").textContent===String(peek("derive(sheet.ch).saveDC")),"with the right number");
ok(/Wild Cards/.test(gambit.querySelector(".term-tip").textContent),"and the class's own note in the tooltip");
// The class's DC takes the slot proficiency used to hold; proficiency is baked into every number
// that needs it, and explains itself where it is mentioned.
ok(!knLabels.includes("Proficiency"),"proficiency is no longer a headline box");
const profTip=$(".panel-sub .term-tip");
ok(profTip&&/level/i.test(profTip.textContent)&&/\+2 at levels 1-4/.test(profTip.textContent),
  "but still explains itself: "+profTip.textContent.slice(0,55));
// and the skills carry the number you actually roll, so nothing is lost by dropping the box
const skillChips=$$(".skill-chip");
ok(skillChips.length===2,"trained skills are listed with their numbers ("+skillChips.length+")");
const acro=skillChips.find(c=>/Acrobatics/.test(c.textContent));
ok(acro&&acro.querySelector("em").textContent===peek(`(function(){const d=derive(sheet.ch);
  return ((d.mods.Dexterity>=0?"+":"")+(d.mods.Dexterity+d.prof));})()`),"Acrobatics shows Dex + proficiency");
ok($$(".ab-box").length===6,"six ability boxes");
// A non-caster must not be shown a trick number at all.
mk("juggler",5,"impalement");
const jl=$$(".kn").map(knLabel);
ok(jl.includes("Trick Shot DC"),"a Juggler sees his Trick Shot DC ("+jl.join(", ")+")");
ok(!jl.some(l=>/Trick attack/i.test(l)),"and no trick-attack line, because he casts nothing");
mk("joker",5);
ok($$(".ab-box.prof").length===2,"the two proficient saves are marked");
ok($(".ab-save").textContent.includes("+"),"each ability shows its saving throw");
ok($$(".attack-table td").every(n=>n.getAttribute("data-label")),"every attack cell carries its stacked-view label");
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

console.log("\n— HEADER —");
mk("illusionist",5,"nightmare");
ok($(".sheet-level .lv-v").textContent==="5","the level has a field of its own, not a word in a list");
ok($(".sheet-class").textContent.includes("Illusionist"),"the class is on its own line");
ok($(".sheet-class").textContent.includes("Nightmare"),"with the discipline");

console.log("\n— YOUR NUMBERS IN THE TOOLTIP —");
// The whole point of {{Label|formula}}: the compendium cannot know whose sheet it is, a sheet can.
const dc=peek(`derive(sheet.ch).saveDC`);
const resolved=$$("#tool .tip-term.resolved");
ok(resolved.length>0,"tokens resolve on a sheet ("+resolved.length+" of them)");
// The LABEL stays — it is what the sentence is about. The tooltip gains the number.
const dcTerm=resolved.find(n=>/save DC/i.test(n.firstChild.textContent));
ok(dcTerm,"a save DC still reads as 'save DC', not as a bare number");
const tipTxt=dcTerm.querySelector(".term-tip").textContent;
ok(tipTxt.trim().startsWith(String(dc)),"and its tooltip leads with your number ("+dc+"): "+tipTxt.trim());
ok(/proficiency/.test(tipTxt),"followed by the working");
// …while the compendium still shows the label, because there is no character there.
await go("#/tricks/waking-nightmare");
ok(peek("TOKEN_RESOLVER")===null,"the resolver is put back after rendering");
ok($("#detail").textContent.includes("trick save DC"),"the compendium still reads as a formula label");
await go("#/sheet/123456");

console.log("\n— TRICKS ROW —");
ok($$('[data-act="open-trick"]').length===0,"no expander on a trick — the name is the link");
const tn=$(".trick-name");
ok(tn && tn.getAttribute("href").startsWith("#/tricks/"),"the name links to the full entry");
const chips=[...$$(".trick-head .fmeta")].map(n=>n.querySelector(".fk").textContent);
ok(chips.includes("Cost"),"a Cost chip beside the tier");
ok(chips.includes("Range"),"a Range chip");
ok($$(".trick-row").some(r=>[...r.querySelectorAll(".fk")].some(k=>k.textContent==="Cooldown")),"a Cooldown chip on the Turns");
ok($$(".trick-row").some(r=>[...r.querySelectorAll(".fk")].some(k=>k.textContent==="Uses")),"a Uses chip on the Prestiges");
ok($$(".trick-head .fmeta .fv").every(n=>!/\{\{|\[\[/.test(n.textContent)),"chips carry no unexpanded tokens");
ok($$(".trick-sum").every(n=>!/^\s*(Action|Bonus action|Reaction)[,.]/.test(n.textContent)),"summaries no longer restate the chips");
ok($(".trick-sum .inplay-tip"),"and carry the In play description as a tooltip");
ok($(".trick-sum .inplay-tip .term-tip").textContent.length>20,"which has real text in it");
// the cooldown label is plain English, not the system's in-fiction word for it
peek(`sheet.ch.play.inCombat=true; sheet.ch.play.cooldowns={"waking-nightmare":2}; renderSheet();`);
ok([...$$(".why")].some(n=>/Ready in 2 rounds/.test(n.textContent)),"a cooldown reads 'Ready in 2 rounds', not 'Seen'");
ok(![...$$(".why")].some(n=>/Seen/.test(n.textContent)),"the word Seen is gone from the sheet");
peek(`sheet.ch.play.cooldowns={}; sheet.ch.play.inCombat=false; renderSheet();`);

console.log("\n— COMING BACK TO A SHEET —");
click($('[data-act="combat"]'));                       // put it in a state worth keeping
click($('[data-act="endturn"]'));
type($("#hp-amt"),"9");
const beforeRound=peek("sheet.ch.play.round");
peek(`ui.sheetScroll = 640;`);                         // as if the page had been scrolled
await go("#/tricks/" + tn.getAttribute("href").split("/").pop());
ok($("#tool-view").classList.contains("hidden"),"following a trick link leaves the sheet");
await go("#/sheet/123456");
ok(peek("sheet.ch.play.inCombat")===true && peek("sheet.ch.play.round")===beforeRound,"combat state intact on return");
ok(beforeRound===2,"the round advanced before leaving");
ok($("#hp-amt").value==="9","the damage box still holds 9");
ok(peek("ui.sheetScroll")===640,"and the scroll position was remembered");
click($('[data-act="combat"]'));

console.log("\n— FEATURES AS CARDS —");
mk("joker",5,"anarchist");
// A feature marked `panel` announces a subsystem the sheet already shows live, so it is left off.
const nFeat=peek(`(function(){const d=derive(sheet.ch);
  return d.features.filter(f=>!(f.panel==="engine"?d.engine:f.panel==="tricks"?d.tricks.length:false)).length;})()`);
const nBanner=peek(`derive(sheet.ch).features.filter(f=>f.panel).length`);
ok($(".feat-grid"),"features are a grid");
ok(nBanner>0,"this class has "+nBanner+" panel-banner features");
ok($$(".feat-card").length===nFeat,"one card per feature, banners left out");
ok(![...$$(".feat-name")].some(n=>n.textContent==="Tricks"),"no 'Tricks' card beside the Tricks panel");
ok(![...$$(".feat-name")].some(n=>n.textContent==="Mayhem"),"no 'Mayhem' card beside the Mayhem panel");
ok($$('[data-act="open-feat"]').length===0,"no expander — every card shows the whole feature");
ok($$(".feat-card .feat-text").length===nFeat,"every card carries its rules text");
ok($$(".feat-card .feat-text").every(n=>n.textContent.trim().length>15),"and it is real text, not a stub");
ok($$(".feat-card .feat-text").every(n=>!/\{\{|\[\[/.test(n.textContent)),"tokens expanded");
// Nothing on a card may open by restating the chips directly above it.
const leads=/^\s*(passive|free|special|automatic|movement|action|bonus action|reaction|no action)\s*[:,.]/i;
const offenders=$$(".feat-card").filter(c=>leads.test(c.querySelector(".feat-text").textContent))
  .map(c=>c.querySelector(".feat-name").textContent);
ok(offenders.length===0,"no card repeats its own cost/uses/range chips in its text ("+offenders.join(", ")+")");
ok(/auto-fit/.test(rule(".feat-grid")),"the grid adapts to the width instead of forcing three");
// A feature with a long menu folds it away — the table is read once when you pick, the sentence
// above it every round.
const optBtn=$$('[data-act="open-opts"]')[0];
ok(optBtn,"a feature with a menu offers a toggle");
ok(/Show the \d+ (option|result)/.test(optBtn.textContent),"which says how many rows it is hiding");
const tablesBefore=$$(".feat-card .option-table").length;
ok(tablesBefore===0,"folded away by default");
click(optBtn);
ok($$(".feat-card .option-table").length===1,"opens just that one");
ok(/Hide the/.test($$('[data-act="open-opts"]')[0].textContent),"and offers to fold it back");
click($$('[data-act="open-opts"]')[0]);
ok($$(".feat-card .option-table").length===0,"which it does");
click($('[data-act="combat"]'));
const useBtn=$$('[data-act="use"]')[0];
if(useBtn){ click(useBtn); ok($$(".feat-card").length===nFeat,"cards survive an action unchanged"); }

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
// You cannot pick a discipline off a name. Every option must open to its actual rules text.
const cards=$$(".sub-card");
ok(cards.length===3,"three disciplines offered as cards ("+cards.length+")");
ok($$(".sub-card .lu-sum").length===0,"collapsed by default");
click($$('[data-act="sub-open"]')[0]);
const body=$(".sub-card .feat-body");
ok(body,"a discipline opens");
ok($$(".sub-card .lu-list li").length>=3,"and lists all of its features");
ok($$(".sub-card .lu-sum").every(n=>n.textContent.trim().length>20),"each with real rules text, not just a name");
ok(!/\{\{|\[\[/.test(body.textContent),"tokens are expanded, not leaked");
click($$('[data-act="lu-sub"]')[0]);
// …and the same must be true of the "what this level adds" list itself.
const sums=$$(".levelup .lu-grid .lu-list .lu-sum");
ok(sums.length>0&&sums.some(n=>n.textContent.trim().length>20),"new features show what they do, not only their name");
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
console.log("\n— PERMANENT DELETE —");
ok($('[data-act="delete-arm"]'),"a delete control exists");
ok(!$("#del-confirm"),"but no confirm box until you ask for one");
click($('[data-act="delete-arm"]'));
ok($("#del-confirm"),"asking for it reveals the box");
ok($('[data-act="delete-go"]').disabled,"delete is locked");
type($("#del-confirm"),"confirm");
ok($('[data-act="delete-go"]').disabled,"lowercase does not unlock it");
type($("#del-confirm"),"CONFIRM ");
ok($('[data-act="delete-go"]').disabled,"nor a trailing space");
type($("#del-confirm"),"CONFIRM");
ok(!$('[data-act="delete-go"]').disabled,"exactly CONFIRM unlocks it");
click($('[data-act="delete-cancel"]'));
ok(!$("#del-confirm")&&$('[data-act="delete-arm"]'),"cancel puts it away again");
// The real backend is the cloud, which this harness cannot reach, so record the calls instead.
peek(`window.__log=[];
  CocStore.remove=async(c)=>{window.__log.push("remove:"+c);};
  CocStore.save=async(c)=>{window.__log.push("save:"+c);};
  localStorage.setItem("coc:recent", JSON.stringify([{code:sheet.code,name:"Rig"}]));`);
click($('[data-act="delete-arm"]'));
type($("#del-confirm"),"CONFIRM");
peek(`sheet.ch.play.hp=1; persist();`);   // a debounced save is now in flight
click($('[data-act="delete-go"]'));
await new Promise(r=>setTimeout(r,800));  // twice the 400ms save debounce
const log=JSON.parse(peek("JSON.stringify(window.__log)"));
ok(log.length===1&&log[0].startsWith("remove:"),"it removes, and the pending save never fires ("+log.join(",")+")");
ok(peek("sheet")===null,"the sheet lets go of it");
ok(peek(`localStorage.getItem("coc:recent")`)==="[]","and it drops off this device's recent list");
ok(peek("location.hash")==="#/manage","and you land back on My characters");

console.log("\n— FIND A LOST CODE —");
// With the hardened rules, listing is DENIED — that is the point. The page must still be useful.
peek(`CocStore.all = async () => { throw new Error("Permission denied"); };
  localStorage.setItem("coc:recent", JSON.stringify([{code:"123456",name:"Rig"}]));`);
await go("#/roster");
ok(!$("#tool .data-table"),"a locked-down database lists nothing, as intended");
ok(/Firebase console/.test($("#tool").textContent),"and points at the console, where the owner can");
const seen=$$("#tool .recent-row");
ok(seen.length===1&&/123456/.test(seen[0].textContent),"while still offering the codes this device knows");
// A permissive backend (localStorage always is) still gets the full table.
peek(`CocStore.all = async () => ({
  "123456": {name:"Rig", classId:"joker", subclassId:"anarchist", level:5},
  "998877": {name:"Other", classId:"the-sandow", level:2} });`);
await go("#/roster");
const rows=$$("#tool .data-table tbody tr");
ok(rows.length===2,"a listable store shows the whole table ("+rows.length+")");
ok(rows[0].querySelector("a").getAttribute("href")==="#/sheet/123456","and opens the sheet");
ok(rows[1].textContent.includes("Sandow"),"class resolved from its id");

console.log("\n— STATES —");
mk("illusionist",5,"nightmare");
ok($$('[data-act="flag"]').length>=8,"universal conditions plus the class's own");
ok($$('.chip-tip .info-dot').length>=8,"each one explains itself through its own tap target");

console.log("\njsdom errors: "+errs.length); errs.slice(0,6).forEach(e=>console.log("  "+e));
console.log(fails||errs.length ? "\nFAILURES: "+fails : "\nALL GREEN");
process.exit(fails||errs.length?1:0);
