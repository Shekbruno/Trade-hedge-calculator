(()=>{"use strict";
const $=id=>document.getElementById(id), q=s=>document.querySelector(s), qa=s=>[...document.querySelectorAll(s)];
let scenarios=[], selected=null;
const ids=["account","risk","p1","p2","daily","maxdd","rr","maxTrades","fee","hedgePerPct","hedgePerLot","share","reward","securePct"];
function cfg(){const o={};ids.forEach(id=>o[id]=parseFloat($(id).value));return o}
function valid(c){return c.account>0&&c.risk>0&&c.p1>0&&c.p2>0&&c.daily>0&&c.maxdd>=c.daily&&c.maxTrades>=1&&c.maxTrades<=12&&c.rr>0&&c.fee>=0&&c.hedgePerPct>=0&&c.hedgePerLot>0&&c.share>=0&&c.share<=100}
function money(n){return "$"+Number(n||0).toFixed(2)}
function pct(n){return Number(n||0).toFixed(2)+"%"}
function makeScenario(c){
 const riskR=c.risk/100, winR=c.rr, p1R=c.p1/c.risk, p2R=c.p2/c.risk, maxDD=c.maxdd/c.risk, dailyDD=c.daily/c.risk;
 const out=[];
 function walk(path,r,stage,dayR,ledger){
   if(stage==="FUNDED"){out.push({path,r,stage,status:"FUNDED",ledger});return}
   if(path.length>=c.maxTrades){out.push({path,r,stage:"Phase "+stage,status:"HORIZON",ledger});return}
   for(const w of [true,false]){
     const nr=r+(w?winR:-1), nd=dayR+(w?winR:-1), np=ledger.concat({result:w?"W":"L",r:nr});
     if(nd<=-dailyDD||nr<=-maxDD){out.push({path:path+(w?"W":"L"),r:nr,stage:"Phase "+stage,status:"DD STOP",ledger:np});continue}
     const target=stage===1?p1R:p2R;
     if(nr>=target){
       if(stage===1)walk(path+(w?"W":"L"),0,2,0,np);
       else walk(path+(w?"W":"L"),nr,"FUNDED",0,np);
     }else walk(path+(w?"W":"L"),nr,stage,nd,np);
   }
 }
 walk("",0,1,0,[]);
 return out;
}
function hedgeForTrade(c,propR){
 const propPct=propR*c.risk;
 const target=Math.max(c.fee, c.fee+Math.max(0,propPct)*c.hedgePerPct);
 const lot=Math.max(0,target/c.hedgePerLot);
 return {target,lot};
}
function render(){
 const c=cfg(); if(!valid(c)){$("validation").textContent="Check inputs";return}
 $("validation").textContent="Ready";
 scenarios=makeScenario(c);
 const funded=scenarios.filter(x=>x.status==="FUNDED").length, dd=scenarios.filter(x=>x.status==="DD STOP").length;
 $("metrics").innerHTML=[
 ["Branches",scenarios.length],["Funded",funded],["DD stopped",dd],["1R",money(c.account*c.risk/100)]
 ].map(x=>`<div class="metric"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join("");
 $("branchCount").textContent=scenarios.length+" generated";
 drawRows();
}
function drawRows(){
 const f=$("filter").value,s=$("search").value.trim().toUpperCase(), rows=scenarios.filter(x=>(f==="all"||x.status===f)&&(!s||x.path.includes(s)));
 $("scenarioRows").innerHTML=rows.slice(0,300).map((x,i)=>{
   const h=hedgeForTrade(cfg(),x.r);
   return `<tr data-path="${x.path}" data-index="${scenarios.indexOf(x)}"><td>${i+1}</td><td>${x.path||"—"}</td><td>${x.path.length}</td><td>${x.r.toFixed(2)}R</td><td>${x.stage}</td><td>${x.status}</td><td>${money(h.target)}</td></tr>`
 }).join("")||`<tr><td colspan="7">No matching scenarios.</td></tr>`;
 qa("#scenarioRows tr[data-index]").forEach(tr=>tr.addEventListener("click",()=>selectScenario(+tr.dataset.index)));
}
function selectScenario(i){
 selected=scenarios[i]; const c=cfg();
 $("scenarioDetail").classList.remove("hidden");
 $("scenarioDetail").innerHTML=`<strong>Selected: ${selected.path||"—"}</strong><div class="status">${selected.status} • ${selected.stage} • ${selected.r.toFixed(2)}R</div>`;
 buildTimeline(selected,c);
}
function buildTimeline(sc,c){
 $("timelineEmpty").classList.add("hidden");$("timelineContent").classList.remove("hidden");
 let propR=0, rows="";
 sc.ledger.forEach((t,i)=>{
   propR=t.r;
   const h=hedgeForTrade(c,propR);
   rows+=`<tr><td>${i+1}</td><td>${t.result}</td><td>${i+1<=sc.path.length?"Active":""}</td><td>${propR.toFixed(2)}R</td><td>${money(propR*c.account*c.risk/100)}</td><td>${money(h.target)}</td><td>${h.lot.toFixed(4)}</td></tr>`;
 });
 const funded=sc.status==="FUNDED", gross= c.account*(c.securePct/100), payout=gross*c.share/100, total=payout+c.reward+c.fee;
 $("timelineSummary").innerHTML=[
 ["Path",sc.path||"—"],["Prop result",money(propR*c.account*c.risk/100)],["Funded",funded?"YES":"NO"],["Illustrative recovery",money(total)]
 ].map(x=>`<div class="metric"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join("");
 $("timelineRows").innerHTML=rows||`<tr><td colspan="7">No trades.</td></tr>`;
}
qa(".tab").forEach(b=>b.addEventListener("click",()=>{qa(".tab").forEach(x=>x.classList.remove("active"));qa(".panel").forEach(x=>x.classList.remove("active"));b.classList.add("active");$(b.dataset.tab).classList.add("active")}));
$("run").addEventListener("click",render);$("filter").addEventListener("change",drawRows);$("search").addEventListener("input",drawRows);
$("demo").addEventListener("click",()=>{ $("rr").value="2.5";$("maxTrades").value="4";$("hedgePerPct").value="2.999";render()});
render();
if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
let deferred=null;window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferred=e;$("installBtn").classList.remove("hidden")});$("installBtn").addEventListener("click",async()=>{if(!deferred)return;deferred.prompt();await deferred.userChoice;deferred=null;$("installBtn").classList.add("hidden")});
})();