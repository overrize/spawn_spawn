/**
 * Demo: spawn agents → print ANSI snapshot.
 * npx tsx tui/demo.ts
 */
import { spawnBridge } from "../omo-bridge/index.js";
import { AgentStatus, AgentType } from "../src/core/types.js";

const ANSI = {
  rst:"\x1b[0m",bld:"\x1b[1m",dim:"\x1b[2m",
  red:"\x1b[31m",grn:"\x1b[32m",ylw:"\x1b[33m",blu:"\x1b[34m",cyn:"\x1b[36m",gry:"\x1b[90m",
};
const B={tl:"┌",tr:"┐",bl:"└",br:"┘",h:"─",v:"│",lt:"├",rt:"┤"};
const W=74,I=W-2;

function cs(s:AgentStatus){switch(s){case AgentStatus.RUNNING:return ANSI.grn;case AgentStatus.PAUSED:return ANSI.ylw;case AgentStatus.TERMINATED:case AgentStatus.ERROR:return ANSI.red;case AgentStatus.IDLE:return ANSI.gry;default:return ANSI.blu;}}
function hdr(t:string){return`${B.tl}${B.h} ${t} `+B.h.repeat(Math.max(0,I-t.length-3))+B.tr;}
function sep(){return B.lt+B.h.repeat(I)+B.rt;}
function sub(t:string){return`${B.lt}${B.h} ${t} `+B.h.repeat(Math.max(0,I-t.length-3))+B.rt;}
function ft(){return B.bl+B.h.repeat(I)+B.br;}
function ss(s:string){return s.replace(/\x1b\[\d*(;\d+)*m/g,"");}
function ln(c:string){const v=ss(c);return B.v+c+" ".repeat(Math.max(0,I-v.length))+B.v;}
function tid(id:string,n=20){return id.length<=n?id:id.slice(0,n-1)+"…";}
function tvl(v:any,n=40){const s=typeof v==="object"?JSON.stringify(v):String(v??"");return s.length<=n?s:s.slice(0,n-1)+"…";}

async function demo(){
const s1=await spawnBridge.spawnAgent("Auth service",["use-oauth2"]);
const s2=await spawnBridge.spawnAgent("Database layer",["postgres-only"]);
spawnBridge.memorySet(s1.spawnId,"auth.provider","jwt");
spawnBridge.memorySet(s1.spawnId,"token.ttl",3600);
spawnBridge.memorySet(s1.spawnId,"endpoint.url","https://auth.example.com");
spawnBridge.memorySet(s2.spawnId,"db.host","localhost");
spawnBridge.memorySet(s2.spawnId,"db.port",5432);
const f1=await spawnBridge.forkAgent(s1.spawnId,"Login handler");
const f2=await spawnBridge.forkAgent(s1.spawnId,"Token refresh");
await spawnBridge.forkAgent(s2.spawnId,"Query builder");
await spawnBridge.pauseAgent(f2.forkId);
spawnBridge.memorySet(s1.spawnId,"cache.strategy","redis");
spawnBridge.memoryDelete(s1.spawnId,"token.ttl");

const agents=spawnBridge.getAllAgents();
const spawns=agents.filter(a=>a.type===AgentType.SPAWN);
const forks=agents.filter(a=>a.type===AgentType.FORK);
const fm=new Map<string,typeof forks>();
for(const f of forks){const p=f.parentId??"";if(!fm.has(p))fm.set(p,[]);fm.get(p)!.push(f);}
const mk=spawns.reduce((n,s)=>{try{n+=Object.keys(spawnBridge.getMemorySnapshot(s.id).entries).length}catch{}return n},0);
const total=agents.length+1;
const actv=1+agents.filter(a=>a.status===AgentStatus.RUNNING||a.status===AgentStatus.INITIALIZING||a.status===AgentStatus.RESUMING).length;
const paus=agents.filter(a=>a.status===AgentStatus.PAUSED).length;
const term=agents.filter(a=>a.status===AgentStatus.TERMINATED).length;

const out:string[]=[];
out.push(hdr("Fork-Agent Status"));
out.push(ln(`  ${ANSI.bld}${total}${ANSI.rst} agents │ ${ANSI.grn}${actv} active${ANSI.rst} │ ${ANSI.ylw}${paus} paused${ANSI.rst} │ ${ANSI.red}${term} terminated${ANSI.rst} │ ${ANSI.cyn}${mk} memory keys${ANSI.rst}  `));
out.push(sep());
out.push(ln(`  ◆ MainAgent  (${ANSI.grn}RUNNING${ANSI.rst})`));
out.push(ln(`  │`));
for(let si=0;si<spawns.length;si++){
  const s=spawns[si],ls=si===spawns.length-1;
  const pre=ls?`  └── `:`  ├── `;
  out.push(ln(`${pre}SpawnAgent ${cs(s.status)}(${s.status})${ANSI.rst}  ${ANSI.dim}depth=${s.depth} forks=${s.forkCount}${ANSI.rst}`));
  const kids=fm.get(s.id)??[];
  for(let fi=0;fi<kids.length;fi++){
    const k=kids[fi],lf=fi===kids.length-1;
    const fp=ls?(lf?`      └── `:`      ├── `):(lf?`  │   └── `:`  │   ├── `);
    out.push(ln(`${fp}ForkAgent ${cs(k.status)}(${k.status})${ANSI.rst}  ${ANSI.dim}depth=${k.depth}${ANSI.rst}`));
  }
  if(!ls&&kids.length>0)out.push(ln(`  │`));
}
out.push(ln(""));
const sid=spawns[0]?.id;
out.push(sub(sid?`SpawnAgent ${tid(sid,12)} SharedMemory`:`SharedMemory`));
if(sid)try{
  const snap=spawnBridge.getMemorySnapshot(sid);
  const ents=Object.values(snap.entries);
  if(ents.length===0)out.push(ln(`  ${ANSI.gry}(empty)${ANSI.rst}`));
  else{for(const e of ents.slice(0,10))out.push(ln(`  ${ANSI.cyn}${e.key.padEnd(14)}${ANSI.rst} → ${ANSI.bld}${tvl(e.value)}${ANSI.rst}`));if(ents.length>10)out.push(ln(`  ${ANSI.gry}(${ents.length-10} more...)${ANSI.rst}`));}
}catch{out.push(ln(`  ${ANSI.gry}(unavailable)${ANSI.rst}`));}
else out.push(ln(`  ${ANSI.gry}(no spawn)${ANSI.rst}`));
out.push(sub("Events (last 10)"));
out.push(ln(`  ${ANSI.gry}(run more operations to see events)${ANSI.rst}`));
out.push(ft());
process.stdout.write(out.join("\n")+"\n");
process.exit(0);
}
demo().catch(e=>{process.stderr.write("Error: "+String(e)+"\n");process.exit(1);});
