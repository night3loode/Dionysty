import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import * as W from './worker.mjs';
const src=fs.readFileSync('./worker.mjs','utf8');
const db=new DatabaseSync(':memory:');
[...new Set(src.match(/CREATE TABLE IF NOT EXISTS [a-z_0-9]+ \((?:[^()]|\([^()]*\))*\)/g))].forEach(c=>db.exec(c));
const wrap=(sql)=>{const st={sql,args:[],bind(...a){const s2=Object.create(st);s2.args=a;return s2},
  run(){const r=db.prepare(this.sql).run(...this.args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}},
  first(){return db.prepare(this.sql).get(...this.args)||null},all(){return {results:db.prepare(this.sql).all(...this.args)}}};return st};
const D1={prepare:wrap,batch:async a=>a.map(s=>s.run()),exec:async s=>db.exec(s)};
const m=new Map();const KV={get:async k=>m.get(k)??null,put:async(k,v)=>m.set(k,String(v)),delete:async k=>m.delete(k),list:async({prefix})=>({keys:[...m.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})};
const env={D1,DB:KV};
const req=new Request('https://w/api',{method:'POST',headers:{Origin:'https://dionysty.pages.dev'}});
const call=async(uid,p,b)=>{const r=await W.v2Api(req,'/api/sq/v2/'+p,env,b,null,uid,{});return {s:r.status,j:await r.json()}};
let pass=0,fail=0;const ok=(c,msg)=>{c?pass++:(fail++,console.log('FAIL',msg))};
// people
await call('1','stars',{}); // triggers v2Ready
db.prepare("INSERT OR REPLACE INTO people (uid,pid,room,alias,done,member) VALUES ('1','p1','V','One',1,1),('2','p2','V','Two',1,1),('3','p3','V','Three',1,0)").run();
// media/put: no bond -> refused
let r=await call('1','media/put',{pid:'p2',blob:'data:image/jpeg;base64,AAAA'});
ok(!r.j.ok,'no bond refused: '+JSON.stringify(r.j));
db.prepare("INSERT INTO bonds (a,b,status,at) VALUES ('1','2','bonded',0)").run();
r=await call('1','media/put',{pid:'p2',blob:'x" onerror="alert(1)'}); ok(!r.j.ok,'attack refused');
r=await call('1','media/put',{pid:'p2',blob:'data:image/jpeg;base64,AAAA'}); ok(r.j.ok&&r.j.id,'valid photo ok '+JSON.stringify(r.j));
const mid=r.j.id;
db.prepare("INSERT INTO media (id,a,b,uid,blob,once,at) VALUES ('evil','1','2','1','x\" onerror=1',0,0)").run();
r=await call('2','media/get',{id:'evil'}); ok(r.j.gone&&!r.j.blob,'stored attack not served');
r=await call('2','media/get',{id:mid}); ok(r.j.blob==='data:image/jpeg;base64,AAAA','valid served');
// dm/save
db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (10,'1','2','1','hi',0)").run();
r=await call('1','dm/save',{id:10}); ok(r.j.saved===true&&r.j.saved_by_me===true,'save');
r=await call('2','dm/save',{id:10}); ok(r.j.saved===false,'other participant can unsave (shared state)');
r=await call('2','dm/save',{id:10}); ok(r.j.saved===true&&r.j.saved_by_me===true,'other participant can save again');
r=await call('1','dm/save',{id:10}); ok(r.j.saved===false,'original saver can unsave what the other saved');
r=await call('3','dm/save',{id:10}); ok(r.s===404,'non-participant refused');
// dm/del removes photo with suffix
db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (11,'1','2','1',?,0)").run('mx:'+mid+'|o');
r=await call('1','dm/del',{id:11}); ok(r.j.ok&&!db.prepare('SELECT 1 FROM media WHERE id=?').get(mid),'delete removes photo');
// legacy compatibility: old "img<id>" and bare-id bodies still delete the photo
for (const [n,fmt] of [[12,id=>'img'+id],[13,id=>id],[14,id=>'mx:'+id],[15,id=>'mx:'+id+'|v']]) {
  r=await call('1','media/put',{pid:'p2',blob:'data:image/jpeg;base64,AAAA'}); const lid=r.j.id;
  db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (?,'1','2','1',?,0)").run(n,fmt(lid));
  r=await call('1','dm/del',{id:n}); ok(r.j.ok&&!db.prepare('SELECT 1 FROM media WHERE id=?').get(lid),'legacy body format removes photo: '+fmt('<id>'));
}
// non-photo bodies must not delete someone else's media
r=await call('1','media/put',{pid:'p2',blob:'data:image/jpeg;base64,AAAA'}); const keep=r.j.id;
db.prepare("INSERT INTO dms (id,a,b,uid,body,at) VALUES (16,'1','2','1','hello there',0)").run();
r=await call('1','dm/del',{id:16}); ok(r.j.ok&&db.prepare('SELECT 1 FROM media WHERE id=?').get(keep),'plain text delete leaves other media');
// history
db.prepare("INSERT INTO circles (id,room,vibe,topic,hushed,cap,welcome,at,last) VALUES (20,'V','foyer','open',0,5,0,0,0),(21,'V','salon','hush',1,5,0,0,0)").run();
db.prepare("INSERT INTO lines (cid,uid,body,at) VALUES (20,'1','open line',?),(21,'1','secret',?)").run(Date.now()-1000,Date.now()-1000);
r=await call('3','history',{cid:20}); ok(r.j.ok&&r.j.lines.length===1,'open circle readable by applicant');
r=await call('3','history',{cid:21}); ok(r.s===403,'hushed refused for non-seated');
db.prepare("INSERT INTO seats (cid,uid,at) VALUES (21,'2',0)").run();
r=await call('2','history',{cid:21}); ok(r.j.ok&&r.j.lines.length===1,'hushed readable when seated');
r=await call('2','history',{cid:999}); ok(r.j.ok&&r.j.lines.length===0,'missing circle empty');
console.log('pass',pass,'fail',fail);
