const {chromium}=require('playwright');const http=require('http');const crypto=require('crypto');
(async()=>{
const {mkEnv}=await import('./notify-env.mjs');const W=await import('./worker.mjs');
const {db,env,tgSent,blocked}=mkEnv();env.BROADCAST_BATCH='3';
await W.default.fetch(new Request('https://w/'),env,{waitUntil(){}});
await env.DB.put('sl:inbox','-777');
const ins=db.prepare("INSERT OR REPLACE INTO people (uid,pid,room,alias,done,member,stage) VALUES (?,?,?,?,?,?,?)");
for(let i=1;i<=9;i++)ins.run(String(100+i),'p'+i,i<=6?'Village 1':'Village 2','M'+i,1,1,'Member');
ins.run('201','a1','Village 1','App1',1,0,'Chatting');ins.run('202','a2','Village 1','Dec',1,0,'Declined');ins.run('bot:9','b9','Village 1','Bot',1,1,'Member');
db.prepare("INSERT INTO note_prefs (uid,kind,off) VALUES ('105','events',1)").run();blocked.add('106');
const token=crypto.randomBytes(32).toString('hex');await env.DB.put('god:sess:'+crypto.createHash('sha256').update(token).digest('hex'),JSON.stringify({at:Date.now()}));
await env.DB.put('god:acct',JSON.stringify({x:1}));
const pending=[];const ctx={waitUntil(p){pending.push(p)}};
const srv=http.createServer(async(q,r)=>{let body='';q.on('data',c=>body+=c);q.on('end',async()=>{const req=new Request('https://dionysty-bot.test'+q.url,{method:q.method,headers:q.headers,body:q.method==='POST'?body:undefined});
  const res=await W.default.fetch(req,env,ctx);r.writeHead(res.status,{'content-type':res.headers.get('content-type')||'text/plain'});r.end(Buffer.from(await res.arrayBuffer()))})}).listen(8780);
let pass=0,fail=0;const ok=(c,s)=>{c?pass++:(fail++,console.log('FAIL',s))};
const b=await chromium.launch();const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});
await c.route(/fonts\.|jsdelivr/,x=>x.abort());
await c.addInitScript(t=>{sessionStorage.setItem('sl_t',t)},token);
const p=await c.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('dialog',d=>d.accept());
await p.goto('http://localhost:8780/starlove');await p.waitForSelector('#t3');await p.click('#t3');await p.waitForSelector('#bc-text');
await p.waitForFunction(()=>/Goes to/.test(document.getElementById('bc-n').textContent));
ok((await p.textContent('#bc-n')).includes('Goes to 9 people'),'members count 9: '+await p.textContent('#bc-n'));
await p.selectOption('#bc-aud','room');await p.waitForTimeout(400);await p.selectOption('#bc-room','Village 2');await p.waitForTimeout(400);
ok((await p.textContent('#bc-n')).includes('Goes to 3 people'),'village 2 count 3: '+await p.textContent('#bc-n'));
await p.selectOption('#bc-aud','all');await p.waitForTimeout(400);ok((await p.textContent('#bc-n')).includes('Goes to 10 people'),'everyone excludes declined and bots: '+await p.textContent('#bc-n'));
await p.selectOption('#bc-aud','members');await p.click('[data-tpl=house]');await p.waitForTimeout(400);
ok((await p.inputValue('#bc-kind'))==='events'&&(await p.inputValue('#bc-btn'))==='house','template sets kind+button');
await p.click('#bc-test');await p.waitForFunction(()=>/Test sent/.test(document.getElementById('bc-er').textContent));
ok(tgSent.some(x=>String(x.b.chat_id)==='-777'&&x.b.text.includes('Starlove, places for the First House')),'test goes to inbox with alias filled');
await p.screenshot({path:'./feat-console-broadcast.png',fullPage:true});
tgSent.length=0;await p.click('#bc-go');await p.waitForFunction(()=>/On its way/.test(document.getElementById('bc-er').textContent));
await p.waitForFunction(()=>/Done ·/.test((document.getElementById('bc-list')||{}).textContent||''),null,{timeout:30000});
await Promise.all(pending);
const msgs=tgSent.filter(x=>x.method==='sendMessage');const to=msgs.map(x=>String(x.b.chat_id)).sort();
ok(to.length===new Set(to).size,'no one got it twice');
ok(!to.includes('105'),'person with events off skipped');ok(!to.includes('201')&&!to.includes('202')&&!to.includes('bot:9'),'only members');
ok(msgs.some(x=>x.b.chat_id==='101'&&x.b.text.includes('M1, places')),'alias personalised');
ok(msgs[0].b.reply_markup.inline_keyboard[0][0].url==='https://dionysty.pages.dev/house/','house button');
const row=db.prepare('SELECT * FROM bcast ORDER BY id DESC').get();
ok(row.total===9&&row.sent===7&&row.skipped===1&&row.failed===1&&row.status==='done','counts '+JSON.stringify({t:row.total,s:row.sent,k:row.skipped,f:row.failed,st:row.status}));
const listText=await p.textContent('#bc-list');ok(listText.includes('7 of 9 delivered')&&listText.includes('1 had it off')&&listText.includes('1 not delivered'),'list shows counts: '+listText.slice(0,200));
await p.screenshot({path:'./feat-console-broadcast-sent.png',fullPage:true});
// cancel mid-way
const r1=await (await fetch('http://localhost:8780/api/god/broadcast/send',{method:'POST',body:JSON.stringify({token,audience:'all',kind:'news',text:'second',btn:'none',confirm:1})})).json();
await Promise.all(pending);
console.log('r1',JSON.stringify(r1));await fetch('http://localhost:8780/api/god/broadcast/cancel',{method:'POST',body:JSON.stringify({token,id:r1.id})});
const r2=db.prepare('SELECT status,sent,total FROM bcast WHERE id=?').get(r1.id);ok(r2.status==='cancelled'&&r2.sent<r2.total,'cancel stops it: '+JSON.stringify(r2));
// unauthenticated
const u=await (await fetch('http://localhost:8780/api/god/broadcast/send',{method:'POST',body:JSON.stringify({audience:'all',text:'x',confirm:1})})).json();ok(u.error==='auth','needs sign-in');
// bad link
const bl=await (await fetch('http://localhost:8780/api/god/broadcast/send',{method:'POST',body:JSON.stringify({token,audience:'all',text:'x',btn:'url',btnUrl:'javascript:alert(1)',confirm:1})})).json();ok(!bl.ok,'non-https link refused');
// cron finishes a broadcast with nobody watching
const r3=await (await fetch('http://localhost:8780/api/god/broadcast/send',{method:'POST',body:JSON.stringify({token,audience:'members',kind:'news',text:'third',btn:'none',confirm:1})})).json();
await Promise.all(pending);for(let i=0;i<4;i++)await W.default.scheduled({},env,ctx);
ok(db.prepare('SELECT status FROM bcast WHERE id=?').get(r3.id).status==='done','cron completes broadcast');
console.log('errors',JSON.stringify(errs));console.log('pass',pass,'fail',fail);
await b.close();srv.close();process.exit(0)})();
