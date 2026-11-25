import { mkEnv } from './notify-env.mjs';
import * as W from './worker.mjs';
let pass=0,fail=0;const ok=(c,s)=>{c?pass++:(fail++,console.log('FAIL',s))};
const {db,env,tgSent,blocked}=mkEnv();
await W.default.fetch(new Request('https://w/'),env,{waitUntil(){}}); // v2Ready etc.
db.prepare("INSERT OR REPLACE INTO people (uid,pid,room,alias,done,member,stage) VALUES ('1','p1','Village 1','One',1,1,'Member'),('2','p2','Village 1','Two',1,1,'Member'),('3','p3','Village 2','Three',1,1,'Member'),('4','p4','Village 1','Four',1,0,'Chatting'),('5','p5','Village 1','Five',1,0,'Declined'),('bot:1','b1','Village 1','Bot',1,1,'Member')").run();
// notify basics
ok(await W.notify(env,'1','news','hi')==='sent','notify sends');
const last=tgSent.at(-1);ok(last.b.reply_markup.inline_keyboard.at(-1)[0].callback_data==='nt|news|off','has turn-off button');
ok(await W.notify(env,'bot:1','news','hi')==='off','lab bot skipped');
blocked.add('2');ok(await W.notify(env,'2','news','hi')==='blocked','blocked detected');blocked.clear();
// turn off via button
const q={id:'q',from:{id:1},data:'nt|news|off',message:{chat:{id:1},message_id:9,text:'hi'}};
await W.default.fetch(new Request('https://w/',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'s'},body:JSON.stringify({callback_query:q})}),env,{waitUntil(){}});
ok(await W.notify(env,'1','news','hi')==='off','news off after button');
ok(await W.notify(env,'1','events','hi')==='sent','events still on');
// app quiet mode silences dm + expiring only
db.prepare("INSERT OR REPLACE INTO prefs (uid,quiet) VALUES ('3',1)").run();
ok(await W.notify(env,'3','dm','x')==='off','quiet silences dm');
ok(await W.notify(env,'3','events','x')==='sent','quiet does not silence events');
// /notifications menu
tgSent.length=0;
await W.default.fetch(new Request('https://w/',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'s'},body:JSON.stringify({update_id:1,message:{message_id:5,from:{id:1,first_name:'O'},chat:{id:1,type:'private'},text:'/notifications'}})}),env,{waitUntil(){}});
const menu=tgSent.find(x=>x.method==='sendMessage'&&String(x.b.text).includes('What Starlove may tell you'));
ok(menu&&menu.b.reply_markup.inline_keyboard.length===4,'menu has 4 toggles');
ok(menu&&menu.b.reply_markup.inline_keyboard[3][0].text.includes('off'),'news shown off');
ok(!tgSent.some(x=>String(x.b.text||'').includes('To Starlove')&&String(x.b.text).includes('/notifications')),'/notifications not forwarded to inbox');
// expiring reminders
const realNow=Date.now;const H=3600000,D=86400000;const T=W.RETENTION_START+3*D;Date.now=()=>T;
db.prepare("INSERT INTO dms (a,b,uid,body,at) VALUES ('1','2','2','soon',?),('1','2','2','soon2',?),('1','4','4','later',?),('1','3','3','saved',?)").run(T-D+2*H,T-D+2.5*H,T-D+10*H,T-D+H);
const sv=db.prepare("SELECT id FROM dms WHERE body='saved'").get().id;db.prepare('INSERT INTO dm_save (id,by,at) VALUES (?,?,0)').run(sv,'1');
tgSent.length=0;await W.ntExpiring(env);
const ex=tgSent.filter(x=>String(x.b.text||'').includes('disappear in about 3 hours'));
ok(ex.length===1&&String(ex[0].b.chat_id)==='1'&&ex[0].b.text.includes('Two')&&!ex[0].b.text.includes('Four')&&!ex[0].b.text.includes('Three'),'one reminder to 1 about Two only: '+JSON.stringify(ex.map(x=>x.b.text)));
tgSent.length=0;await W.ntExpiring(env);ok(!tgSent.length,'no repeat within the hour');
Date.now=()=>T+H;tgSent.length=0;await W.ntExpiring(env);ok(!tgSent.some(x=>String(x.b.text||'').includes('Two')),'no repeat same day');
// grace period: messages from before RETENTION_START expire at RETENTION_START+24h
Date.now=()=>W.RETENTION_START+D-2*H;db.prepare("INSERT INTO dms (a,b,uid,body,at) VALUES ('2','3','3','old one',?)").run(W.RETENTION_START-5*D);
tgSent.length=0;await W.ntExpiring(env);ok(tgSent.some(x=>String(x.b.chat_id)==='2'&&String(x.b.text).includes('Three')),'pre-start messages reminded before grace ends');
Date.now=realNow;
// forgetAll clears prefs
await W.forgetAll(env,'1');ok(!db.prepare("SELECT 1 FROM note_prefs WHERE uid='1'").get(),'prefs deleted on forget');
console.log('pass',pass,'fail',fail);
