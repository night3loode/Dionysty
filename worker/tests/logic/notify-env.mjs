import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
export function mkEnv(){
  const src=fs.readFileSync(new URL('./worker.mjs',import.meta.url),'utf8');
  const db=new DatabaseSync(':memory:');
  [...new Set(src.match(/CREATE TABLE IF NOT EXISTS [a-z_0-9]+ \((?:[^()]|\([^()]*\))*\)/g))].forEach(c=>db.exec(c));
  try{db.exec('ALTER TABLE media ADD ext INTEGER DEFAULT 0')}catch(e){}
  const wrap=(sql)=>{const st={sql,args:[],bind(...a){const s2=Object.create(st);s2.args=a;return s2},
    run(){const r=db.prepare(this.sql).run(...this.args);return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}},
    first(){return db.prepare(this.sql).get(...this.args)||null},all(){return {results:db.prepare(this.sql).all(...this.args)}}};return st};
  const D1={prepare:wrap,batch:async a=>a.map(s=>s.run()),exec:async s=>db.exec(s)};
  const m=new Map();const DB={m,get:async k=>m.get(k)??null,put:async(k,v)=>m.set(k,String(v)),delete:async k=>m.delete(k),list:async({prefix})=>({keys:[...m.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})};
  const tgSent=[];const blocked=new Set();const realFetch=globalThis.__realFetch||(globalThis.__realFetch=globalThis.fetch);
  globalThis.fetch=async(u,o)=>{u=String(u);if(u.includes('api.telegram.org')){const method=u.split('/').pop();const b=o&&o.body?JSON.parse(o.body):{};tgSent.push({method,b});
      if(method==='sendMessage'&&blocked.has(String(b.chat_id)))return new Response(JSON.stringify({ok:false,error_code:403,description:'Forbidden: bot was blocked by the user'}));
      return new Response(JSON.stringify({ok:true,result:{message_id:tgSent.length,status:'member'}}))}
    if(u.startsWith('http://localhost'))return realFetch(u,o);
    return new Response(JSON.stringify({ok:false}))};
  return {db,env:{D1,DB,BOT_TOKEN:'t',TEAM_CHAT_ID:'-100',WEBHOOK_SECRET:'s'},tgSent,blocked};
}
