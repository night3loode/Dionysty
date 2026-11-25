import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import * as W from './worker.mjs';
const src=fs.readFileSync('./worker.mjs','utf8');
function mk(){const db=new DatabaseSync(':memory:');
  [...new Set(src.match(/CREATE TABLE IF NOT EXISTS [a-z_0-9]+ \((?:[^()]|\([^()]*\))*\)/g))].forEach(c=>db.exec(c));
  try{db.exec('ALTER TABLE media ADD ext INTEGER DEFAULT 0')}catch(e){}
  const wrap=(sql)=>{const st={sql,args:[],bind(...a){const s2=Object.create(st);s2.args=a;return s2},
    run(){const r=db.prepare(this.sql).run(...this.args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}},
    first(){return db.prepare(this.sql).get(...this.args)||null},all(){return {results:db.prepare(this.sql).all(...this.args)}}};return st};
  const m=new Map();
  return {db,D1:{prepare:wrap,batch:async a=>a.map(s=>s.run()),exec:async s=>db.exec(s)},
    KV:{get:async k=>m.get(k)??null,put:async(k,v)=>m.set(k,String(v)),delete:async k=>m.delete(k),list:async({prefix})=>({keys:[...m.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})}};}
let pass=0,fail=0;const ok=(c,msg)=>{c?pass++:(fail++,console.log('FAIL',msg))};
const D=86400000;const real=Date.now;Date.now=()=>W.RETENTION_START+2*D+3600000;
let bridgeUp=true;const gone=new Set(),calls=[];
globalThis.fetch=async(u,o)=>{const b=JSON.parse(o.body);calls.push(b);if(!bridgeUp)throw new Error('down');if(b.op==='del'){gone.add(b.id);return Response.json({ok:true})}return Response.json({ok:false})};
const mkenv=()=>{const x=mk();return {x,db:x.db,env:{D1:x.D1,DB:x.KV,MEDIA_BRIDGE_URL:'https://bridge.test/',MEDIA_KEY:'k'}}};
const now=Date.now(),old=now-2*D;
const q=(db,s,...a)=>db.prepare(s).all(...a);
// 1. sweep with bridge DOWN: blob id queued, row gone, then retried when bridge returns
{const {db,env}=mkenv();gone.clear();bridgeUp=false;
 db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at,ext) VALUES ('aaa111','1','2','1','',0,?,1)").run(old);
 db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (1,'1','2','1','mx:aaa111|o',?)").run(old);
 await W.sweepExpiry(env);
 ok(q(db,'SELECT id FROM media').length===0,'sweep: media row removed even though bridge is down');
 ok(JSON.stringify(q(db,'SELECT id FROM mpurge').map(x=>x.id))==='["aaa111"]','sweep: blob id queued for retry');
 bridgeUp=true;await W.sweepExpiry(env);
 ok(q(db,'SELECT id FROM mpurge').length===0&&gone.has('m_aaa111'),'sweep: retry drains queue and deletes blob in Drive');}
// 2. sweep when the queue insert itself fails: row is KEPT so the locator is not lost
{const {db,env}=mkenv();gone.clear();bridgeUp=false;
 db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at,ext) VALUES ('bbb222','1','2','1','',0,?,1)").run(old);
 db.exec('DROP TABLE mpurge');
 await W.sweepExpiry(env);
 ok(q(db,'SELECT id FROM media').length===1,'sweep: row kept when neither delete nor enqueue succeeded');}
// 3. dm/del of a photo DM with "|o" suffix: Drive blob dropped, row gone; down bridge queues retry
{const {db,env}=mkenv();gone.clear();bridgeUp=false;
 const req=new Request('https://w/api',{method:'POST',headers:{Origin:'https://dionysty.pages.dev'}});
 const call=async(uid,p,b)=>{const r=await W.v2Api(req,'/api/sq/v2/'+p,env,b,null,uid,{});return r.json()};
 await call('1','stars',{});
 db.prepare("INSERT OR REPLACE INTO people (uid,pid,room,alias,done,member) VALUES ('1','p1','V','One',1,1),('2','p2','V','Two',1,1)").run();
 db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at,ext) VALUES ('ccc333','1','2','1','',1,?,1)").run(now);
 db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (7,'1','2','1','mx:ccc333|o',?)").run(now);
 const r=await call('1','dm/del',{id:7});
 ok(r.ok,'dm/del ok');
 ok(q(db,'SELECT id FROM media').length===0,'dm/del: media row removed');
 ok(q(db,"SELECT body FROM dms WHERE id=7")[0].body==='','dm/del: body blanked');
 ok(JSON.stringify(q(db,'SELECT id FROM mpurge').map(x=>x.id))==='["ccc333"]','dm/del: blob queued while bridge down');
 ok((await call('2','media/get',{id:'ccc333'})).gone!==false&&!(await call('2','media/get',{id:'ccc333'})).blob,'dm/del: photo not served after delete');
 bridgeUp=true;await W.mediaPurgeSweep(env);
 ok(q(db,'SELECT id FROM mpurge').length===0&&gone.has('m_ccc333'),'dm/del: queued blob deleted on retry');}
// 4. forgetAll with bridge down: Drive blob queued, rows removed; with failed enqueue the row is kept
{const {db,env}=mkenv();gone.clear();bridgeUp=false;
 db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at,ext) VALUES ('ddd444','7','8','7','',0,?,1)").run(now);
 await W.forgetAll(env,'7');
 ok(q(db,'SELECT id FROM media').length===0&&q(db,'SELECT id FROM mpurge').length===1,'forgetAll: row removed, blob queued');
 db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at,ext) VALUES ('eee555','7','8','7','',0,?,1)").run(now);
 db.exec('DROP TABLE mpurge');await W.forgetAll(env,'7');
 ok(q(db,'SELECT id FROM media').length===1,'forgetAll: row kept when blob could neither be deleted nor queued');}
Date.now=real;console.log('pass',pass,'fail',fail);process.exit(fail?1:0);
