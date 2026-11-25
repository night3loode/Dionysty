import { DatabaseSync } from 'node:sqlite';
import * as W from './worker.mjs';
const db=new DatabaseSync(':memory:');
const wrap=(sql)=>{const st={sql,args:[],bind(...a){const s2=Object.create(st);s2.args=a;return s2},
  run(){const r=db.prepare(this.sql).run(...this.args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}},
  first(){return db.prepare(this.sql).get(...this.args)||null},all(){return {results:db.prepare(this.sql).all(...this.args)}}};return st};
const D1={prepare:wrap,batch:async a=>a.map(s=>s.run()),exec:async s=>db.exec(s)};
const m=new Map();const KV={get:async k=>m.get(k)??null,put:async(k,v)=>m.set(k,String(v)),delete:async k=>m.delete(k),list:async({prefix})=>({keys:[...m.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})};
const sent=[];globalThis.fetch=async(u,o)=>{const b=o&&o.body?JSON.parse(o.body):{};sent.push({m:String(u).split('/').pop(),b});return new Response(JSON.stringify({ok:true,result:{message_id:sent.length,status:'left'}}))};
const env={D1,DB:KV,BOT_TOKEN:'t',TEAM_CHAT_ID:'-100'};
await KV.put('sl:inbox','-555');
await KV.put('u:1',JSON.stringify({step:'chatting',alias:'One',code:'DNY-AAAA11',member:{room:'V'},rulesOk:true,talkTo:'2'}));
await KV.put('u:2',JSON.stringify({step:'chatting',alias:'Two',code:'DNY-BBBB22',member:{room:'V'},rulesOk:true}));
await KV.put('u:3',JSON.stringify({step:'chatting',alias:'Three',code:'DNY-CCCC33'}));
const msg=(id,text)=>({message_id:Math.floor(Math.random()*1e6),from:{id:Number(id),first_name:'X'},chat:{id:Number(id),type:'private'},text});
const rows=()=>{try{return db.prepare('SELECT who,body FROM sl_msgs').all()}catch(e){return []}};
let pass=0,fail=0;const ok=(c,s)=>{c?pass++:(fail++,console.log('FAIL',s))};
await W.onPrivate(msg(1,'private hello to Two'),null,env);
ok(!rows().some(r=>r.body.includes('private hello')),'member relay not copied');
ok(!sent.some(s=>s.b.chat_id=='-555'&&String(s.b.text).includes('private hello')),'relay not sent to inbox chat');
await W.onPrivate(msg(3,'question for the team'),null,env);
ok(rows().some(r=>r.body.includes('question for the team')),'applicant message still reaches Starlove');
const n0=rows().length; await W.onPrivate(msg(3,'/forget'),'/forget',env);
ok(!rows().some(r=>r.body==='/forget'),'/forget not logged');
ok(!m.has('u:3'),'record deleted on /forget');
ok(rows().length===0||!rows().some(r=>r.body.includes('question')),'their starlove rows deleted: '+JSON.stringify(rows()));
console.log('pass',pass,'fail',fail);
