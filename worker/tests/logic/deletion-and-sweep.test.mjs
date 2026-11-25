import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import * as W from './worker.mjs';
const src = fs.readFileSync('./worker.mjs','utf8');
function mkD1(){
  const db = new DatabaseSync(':memory:');
  const creates = [...new Set(src.match(/CREATE TABLE IF NOT EXISTS [a-z_0-9]+ \((?:[^()]|\([^()]*\))*\)/g))];
  creates.forEach(c=>db.exec(c)); db.exec('ALTER TABLE media ADD ext INTEGER DEFAULT 0');
  const wrap=(sql)=>{const st={sql,args:[],bind(...a){const s2=Object.create(st);s2.args=a;return s2},
    run(){const r=db.prepare(this.sql).run(...this.args);return {meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}}},
    first(){return db.prepare(this.sql).get(...this.args)||null},
    all(){return {results:db.prepare(this.sql).all(...this.args)}}};return st};
  return {db, D1:{prepare:wrap, batch:async(arr)=>arr.map(s=>s.run()), exec:async(s)=>db.exec(s)}};
}
function mkKV(){const m=new Map();return {m,get:async k=>m.has(k)?m.get(k):null,put:async(k,v)=>{m.set(k,String(v))},delete:async k=>{m.delete(k)},list:async({prefix})=>({keys:[...m.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})}}
let pass=0,fail=0;const ok=(c,msg)=>{if(c){pass++}else{fail++;console.log('FAIL',msg)}};
const D=86400000; const _now=Date.now; Date.now=()=>W.RETENTION_START+2*D+3600000;
// ---------- sweepExpiry ----------
{
  const {db,D1}=mkD1(); const env={D1,DB:mkKV()};
  const now=Date.now(), old=now-2*D;
  db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at) VALUES ('aaa111','1','2','1','x',0,?)").run(old);
  db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at) VALUES ('bbb222','1','2','1','x',1,?)").run(old);
  db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at) VALUES ('ccc333','1','2','1','x',0,?)").run(old); // never sent
  db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at) VALUES ('ddd444','1','2','1','x',0,?)").run(now); // fresh, unsent
  db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (1,'1','2','1','mx:aaa111',?)").run(old); // unsaved -> goes
  db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (2,'1','2','1','mx:bbb222|o',?)").run(old); // saved -> stays
  db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (3,'1','2','1','hello',?)").run(old); // unsaved -> goes
  db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (4,'1','2','1','recent',?)").run(now); // recent -> stays
  db.prepare("INSERT INTO dm_save (id,by,at) VALUES (2,'1',?)").run(now);
  await W.sweepExpiry(env);
  const ids=db.prepare('SELECT id FROM dms ORDER BY id').all().map(x=>x.id);
  const mids=db.prepare('SELECT id FROM media ORDER BY id').all().map(x=>x.id);
  ok(JSON.stringify(ids)==='[2,4]','dms kept '+JSON.stringify(ids));
  ok(JSON.stringify(mids)==='["bbb222","ddd444"]','media kept '+JSON.stringify(mids));
  // missing table should not stop other steps
  db.exec('DROP TABLE msgs'); db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (5,'1','2','1','old',?)").run(old);
  await W.sweepExpiry(env); ok(!db.prepare('SELECT 1 FROM dms WHERE id=5').get(),'sweep continues past missing table');
}
// ---------- forgetAll ----------
{
  const {db,D1}=mkD1(); const KV=mkKV(); const env={D1,DB:KV};
  db.prepare("INSERT INTO circles (id,room,vibe,topic,hushed,cap,welcome,at,last) VALUES (1,'V','foyer','open',0,5,0,0,0),(2,'V','salon','hushed',1,5,0,0,0),(3,'V','foyer','welcome',NULL,5,1,0,0),(4,'V','foyer','null',NULL,5,0,0,0)").run();
  for(const c of [1,2,3,4]) db.prepare("INSERT INTO lines (cid,uid,body,at) VALUES (?,'7','hi',0)").run(c);
  db.prepare("INSERT INTO lines (cid,uid,body,at) VALUES (2,'8','other',0)").run();
  db.prepare("INSERT INTO people (uid,pid,room,alias,done,member) VALUES ('7','p7','V','Seven',1,1),('8','p8','V','Eight',1,1)").run();
  db.prepare("INSERT INTO dms (a,b,uid,body,at) VALUES ('7','8','7','x',0),('8','9','8','y',0)").run();
  db.prepare("INSERT INTO blocks (a,b,at) VALUES ('7','8',0),('8','7',0)").run();
  db.prepare("INSERT INTO sl_msgs (at,who,label,body,dest) VALUES (0,'Seven','Telegram','hey','tg:7'),(0,'Eight','Telegram','hey','tg:8')").run();
  db.prepare("INSERT INTO together (a,b,secs,last) VALUES ('7','8',10,0)").run();
  db.prepare("INSERT INTO pgintro (id,pg,uid,by,to_uid,status) VALUES (1,1,'8','7','9','x')").run();
  db.prepare("INSERT INTO pgmsg (intro,uid,body,at) VALUES (1,'9','m',0)").run();
  await KV.put('ok:7:8','1');await KV.put('ok:8:7','1');await KV.put('ok:8:77','1');await KV.put('blk:8:7','1');await KV.put('blk:7:8','1');await KV.put('swd:7:8','1');await KV.put('x:7:55','8');
  await W.forgetAll(env,'7');
  const L=db.prepare('SELECT cid,uid FROM lines ORDER BY cid,uid').all().map(x=>x.cid+':'+x.uid).join(',');
  ok(L==='1:7,2:8,3:7','lines kept only in open/welcome circles: '+L);
  ok(!db.prepare("SELECT 1 FROM people WHERE uid='7'").get(),'people row gone');
  ok(db.prepare("SELECT 1 FROM people WHERE uid='8'").get(),'other person kept');
  ok(db.prepare("SELECT COUNT(*) n FROM dms").get().n===1,'their dms gone, others kept');
  ok(JSON.stringify(db.prepare('SELECT a,b FROM blocks').all())==='[{"a":"8","b":"7"}]','blocks against them kept');
  ok(db.prepare("SELECT COUNT(*) n FROM sl_msgs").get().n===1,'their starlove rows gone');
  ok(!db.prepare("SELECT 1 FROM together").get(),'together gone');
  ok(!db.prepare("SELECT 1 FROM pgmsg").get()&&!db.prepare("SELECT 1 FROM pgintro").get(),'intros gone');
  const keys=[...KV.m.keys()].sort().join(',');
  ok(keys==='blk:8:7,ok:8:77','kv left: '+keys);
}
// ---------- media pattern ----------
ok(W.V2_MEDIA_OK.test('data:image/jpeg;base64,/9j/4AAQSkZJRg=='),'jpeg ok');
ok(W.V2_MEDIA_OK.test('data:video/mp4;base64,AAAA'),'mp4 ok');
ok(!W.V2_MEDIA_OK.test('x" onerror="alert(1)'),'attack rejected');
ok(!W.V2_MEDIA_OK.test('data:image/jpeg;base64,AAA" onerror="alert(1)'),'attack in data url rejected');
ok(!W.V2_MEDIA_OK.test('data:text/html;base64,AAAA'),'html rejected');
ok(!W.V2_MEDIA_OK.test('blob:https://x/1'),'blob url rejected');
ok(W.V2_MEDIA_OK.test('aGVsbG8tY2lwaGVy'),'bare base64 (encrypted) ok');
// Drive-stored photos are dropped from Drive by the sweep and by forgetAll
{
  const {db,D1}=mkD1(); const drops=[]; const realFetch=globalThis.fetch;
  globalThis.fetch=async(u,o)=>{const b=JSON.parse(o.body);if(b.op==='del')drops.push(b.id);return new Response(JSON.stringify({ok:true}))};
  const env={D1,DB:mkKV(),MEDIA_BRIDGE_URL:'https://bridge.test',MEDIA_KEY:'k'};
  const old=Date.now()-2*D;
  db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at,ext) VALUES ('e1','1','2','1','',0,?,1),('e2','1','2','1','',0,?,1),('e3','5','6','5','',0,?,1)").run(old,old,old);
  db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (1,'1','2','1','mx:e1|o',?),(2,'1','2','1','mx:e2',?),(3,'5','6','5','mx:e3',?)").run(old,old,Date.now());
  db.prepare("INSERT INTO dm_save (id,by,at) VALUES (2,'1',0)").run();
  await W.sweepExpiry(env);
  ok(JSON.stringify(drops)==='["m_e1"]','sweep drops only unsaved Drive photo: '+JSON.stringify(drops));
  await W.forgetAll(env,'1');
  ok(drops.includes('m_e2')&&!drops.includes('m_e3'),'forgetAll drops their Drive photos only: '+JSON.stringify(drops));
  globalThis.fetch=realFetch;
}
// ---------- code lookup ----------
{
  const KV=mkKV(); await KV.put('c:DNY-AB12CD','42'); await KV.put('u:42',JSON.stringify({alias:'A',code:'DNY-AB12CD'}));
  for(const c of ['DNY-AB12CD','dny-ab12cd','DNYAB12CD']) ok((await W.recByCode({DB:KV},c))?.uid==='42','code '+c);
  ok(!(await W.recByCode({DB:KV},'nope')),'bad code null');
}
console.log('pass',pass,'fail',fail);
