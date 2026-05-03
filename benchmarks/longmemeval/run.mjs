#!/usr/bin/env node
// LongMemEval Benchmark Runner -- MeMesh v4.0.4 -- PUBLIC EVIDENCE PACKAGE
// bench/longmemeval-public-r1 -- Dataset SHA256: 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894
// Usage: node benchmarks/longmemeval/run.mjs --mode A|B|C --dataset /tmp/longmemeval_s.json
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import os from "os";
import { spawnSync } from "child_process";
const __dirname=path.dirname(fileURLToPath(import.meta.url));

async function sha256File(fp){return new Promise((res,rej)=>{const h=createHash("sha256");const s=createReadStream(fp);s.on("data",c=>h.update(c));s.on("end",()=>res(h.digest("hex")));s.on("error",rej);});}
function getEnvInfo(){const cpus=os.cpus();let gitSha="unknown";try{const r=spawnSync("git",["rev-parse","HEAD"],{cwd:path.join(__dirname,"../.."),encoding:"utf8"});gitSha=(r.stdout||"").trim()||"unknown";}catch{}return{node_version:process.version,platform:os.platform(),os_version:os.release(),arch:os.arch(),cpu_model:cpus[0]?.model||"unknown",cpu_cores:cpus.length,memesh_version:"4.0.4",git_sha:gitSha};}

function parseArgs(a){const r={};for(let i=2;i<a.length;i++){if(a[i].startsWith("--")){const k=a[i].slice(2);r[k]=a[i+1]||true;i++;}}return r;}
const args=parseArgs(process.argv);
const mode=args.mode||"A";
const datasetPath=args.dataset||"/tmp/longmemeval_s.json";
const limitArg=parseInt(args.limit||"500",10);
const outputDir=args.output||path.join(__dirname,"results");
const dbDir=args.dbdir||"/tmp";
function sessionToText(s){return s.map(t=>t.role+": "+t.content).join("\n").slice(0,8000);}
function escapeFts(q){
  const c=q.replace(/[^a-zA-Z0-9 ]/g," ").replace(/ +/g," ").trim();
  if(!c)return "\"\"";
  const terms=c.split(" ").filter(t=>t.length>2).slice(0,20);
  if(!terms.length)return "\"\"";
  return terms.map(t=>"\""+t+"\"").join(" OR ");
}
function openDb(p,v){
  const db=new Database(p);
  db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,type TEXT NOT NULL DEFAULT 'session',status TEXT NOT NULL DEFAULT 'active',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,access_count INTEGER DEFAULT 0,last_accessed_at TIMESTAMP,confidence REAL DEFAULT 1.0,valid_from TIMESTAMP,valid_until TIMESTAMP,namespace TEXT DEFAULT 'personal',recall_hits INTEGER DEFAULT 0,recall_misses INTEGER DEFAULT 0,metadata JSON)");
  db.exec("CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT,entity_id INTEGER NOT NULL,content TEXT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_obs ON observations(entity_id)");
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(name,observations,content='',tokenize='unicode61 remove_diacritics 1')");
  db.exec("CREATE TABLE IF NOT EXISTS memesh_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  sqliteVec.load(db);
  if(v){db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(embedding float[384])");
    db.exec("INSERT OR REPLACE INTO memesh_metadata (key,value) VALUES ('embedding_dimension','384')");}
  return db;
}
function insertSess(db,sid,text,date){
  const meta=date?JSON.stringify({session_date:date}):null;
  const res=db.prepare("INSERT OR REPLACE INTO entities (name,type,metadata) VALUES (?,'session',?)").run(sid,meta);
  const eid=res.lastInsertRowid;
  db.prepare("INSERT INTO observations (entity_id,content) VALUES (?,?)").run(eid,text);
  db.prepare("INSERT INTO entities_fts (rowid,name,observations) VALUES (?,?,?)").run(eid,sid,text);
  return eid;
}
let _pipe=null;
async function getPipe(){if(_pipe)return _pipe;const{pipeline}=await import("@huggingface/transformers");_pipe=await pipeline("feature-extraction","Xenova/all-MiniLM-L6-v2",{dtype:"fp32"});return _pipe;}
async function embed(text){try{const p=await getPipe();const r=await p(text.slice(0,2048),{pooling:"mean",normalize:true});return Buffer.from(r.data.buffer);}catch{return null;}}
async function runQ(item,mode,dbDir){
  const dbPath=path.join(dbDir,"bench-"+item.question_id+"-"+mode+".db");
  if(existsSync(dbPath))unlinkSync(dbPath);
  const db=openDb(dbPath,mode!=="A");
  try{
    const eids=new Map();
    for(let i=0;i<item.haystack_sessions.length;i++){
      const sid=item.haystack_session_ids[i];
      const text=sessionToText(item.haystack_sessions[i]);
      const date=item.haystack_dates&&item.haystack_dates[i];
      eids.set(sid,insertSess(db,sid,text,date));
    }
    if(mode!=="A"){
      for(let i=0;i<item.haystack_sessions.length;i++){
        const sid=item.haystack_session_ids[i];
        const emb=await embed(sid+" "+sessionToText(item.haystack_sessions[i]));
        if(!emb)continue;const eid=eids.get(sid);if(eid===undefined)continue;
        try{db.prepare("INSERT OR REPLACE INTO entities_vec (rowid,embedding) VALUES (?,?)").run(BigInt(Number(eid)),emb);}catch{}
      }
    }
    const q=escapeFts(item.question);
    let fts=[];
    try{fts=db.prepare("SELECT e.id,e.name,entities_fts.rank AS rank FROM entities_fts JOIN entities e ON e.id=entities_fts.rowid WHERE entities_fts MATCH ? ORDER BY rank LIMIT 20").all(q);}catch{}
    let vec=[];
    if(mode!=="A"){const qe=await embed(item.question);if(qe){try{vec=db.prepare("SELECT ev.rowid AS id,e.name,ev.distance FROM entities_vec ev JOIN entities e ON e.id=ev.rowid WHERE ev.embedding MATCH ? AND k=20 ORDER BY ev.distance").all(qe);}catch{}}}
    const sm=new Map();const nf=Math.max(fts.length,1);
    for(let i=0;i<fts.length;i++)sm.set(fts[i].name,1-i/nf);
    if(mode!=="A"){for(const vr of vec){const vs=Math.max(0,1-vr.distance);const ex=sm.get(vr.name);if(ex!==undefined){sm.set(vr.name,mode==="C"?0.6*ex+0.4*vs:Math.max(ex,vs));}else{sm.set(vr.name,vs*0.7);}}}
    const ranked=[...sm.entries()].sort((a,b)=>b[1]-a[1]).map(([n])=>n);
    const aset=new Set(item.answer_session_ids);let hit=null;
    for(let i=0;i<ranked.length;i++){if(aset.has(ranked[i])){hit=i+1;break;}}
    return{question_id:item.question_id,question_type:item.question_type,question:item.question,ranked_session_ids:ranked.slice(0,10),answer_session_ids:item.answer_session_ids,hit_at:hit,r_at_5:hit!==null&&hit<=5,r_at_10:hit!==null&&hit<=10,reciprocal_rank:hit!==null?1/hit:0,fts_hit_count:fts.length,vec_hit_count:vec.length,haystack_size:item.haystack_sessions.length};
  }finally{db.close();try{if(existsSync(dbPath))unlinkSync(dbPath);}catch{}}
}
function mets(rs){const n=rs.length;if(!n)return{r_at_5:0,r_at_10:0,mrr:0,total:0};return{r_at_5:rs.filter(r=>r.r_at_5).length/n,r_at_10:rs.filter(r=>r.r_at_10).length/n,mrr:rs.reduce((s,r)=>s+r.reciprocal_rank,0)/n,total:n};}
function metsByType(rs){const m={};for(const r of rs){if(!m[r.question_type])m[r.question_type]=[];m[r.question_type].push(r);}return Object.fromEntries(Object.entries(m).map(([t,v])=>[t,mets(v)]));}
async function main(){
  const md={A:"FTS5 only",B:"FTS5+ONNX (max)",C:"FTS5+ONNX (weighted)"}[mode];
  process.stderr.write("\nMeMesh LongMemEval -- INTERNAL ONLY\nMode "+mode+":"+md+"\n");
  if(mode!=="A"){
    process.stderr.write("Warming ONNX..."+"\n");
    await embed("warmup");
    process.stderr.write("Ready."+"\n");
  }
  process.stderr.write("Computing dataset SHA256...\n");const datasetSha=await sha256File(datasetPath);process.stderr.write("SHA256: "+datasetSha+"\n");const data=JSON.parse(readFileSync(datasetPath,"utf8"));
  const items=data.slice(0,limitArg);
  process.stderr.write("Loaded "+items.length+" questions."+"\n");
  mkdirSync(outputDir,{recursive:true});
  const results=[];const t0=Date.now();
  for(let i=0;i<items.length;i++){
    try{results.push(await runQ(items[i],mode,dbDir));}
    catch(err){
      process.stderr.write("ERR "+items[i].question_id+": "+err.message+"\n");
      results.push({question_id:items[i].question_id,question_type:items[i].question_type,question:items[i].question,ranked_session_ids:[],answer_session_ids:items[i].answer_session_ids,hit_at:null,r_at_5:false,r_at_10:false,reciprocal_rank:0,fts_hit_count:0,vec_hit_count:0,haystack_size:0,error:err.message});
    }
    if((i+1)%50===0){const m=mets(results);process.stderr.write("["+((i+1))+"/"+items.length+"] R@5="+(m.r_at_5*100).toFixed(1)+"% R@10="+(m.r_at_10*100).toFixed(1)+"% MRR="+m.mrr.toFixed(3)+"\n");}
  }
  const ov=mets(results);const bt=metsByType(results);
  const ts=new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
  const outFile=path.join(outputDir,"mode-"+mode+"-"+ts+".json");
  const ri={mode,mode_description:md,dataset:datasetPath,dataset_sha256:datasetSha,n_questions:results.length,elapsed_seconds:parseFloat(((Date.now()-t0)/1000).toFixed(1)),timestamp:new Date().toISOString(),environment:getEnvInfo(),dataset_variant:"longmemeval_s",status:"PUBLIC"};
  writeFileSync(outFile,JSON.stringify({run_info:ri,overall_metrics:ov,metrics_by_type:bt,results},null,2));
  const elap=((Date.now()-t0)/1000).toFixed(1);
  process.stderr.write("\n=== RESULTS Mode "+mode+" ===\n");
  process.stderr.write("R@5:  "+(ov.r_at_5*100).toFixed(2)+"%"+"\n");
  process.stderr.write("R@10: "+(ov.r_at_10*100).toFixed(2)+"%"+"\n");
  process.stderr.write("MRR:  "+ov.mrr.toFixed(4)+"\n");
  process.stderr.write("Time: "+elap+"s Saved: "+outFile+"\n");
  process.stderr.write("By type:"+"\n");
  for(const[t,m]of Object.entries(bt))process.stderr.write("  "+t+": R@5="+(m.r_at_5*100).toFixed(1)+"% (n="+m.total+")"+"\n");
  console.log(JSON.stringify({mode,overall:ov,outFile},null,2));
}
main().catch(e=>{process.stderr.write("Fatal: "+e.message+"\n");process.exit(1);});