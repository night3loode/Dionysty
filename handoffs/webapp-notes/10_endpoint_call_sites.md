# Client call sites for each backend endpoint (excerpts from the app code; the host is not shown)

Each block is the raw code around the first call of that path. Read these to infer request and response fields.

### sq/village
```
adVillage()} function loadVillage(room){call('sq/village',room?{room:room}:{}).then(function(r){if(!r.ok)return;V=r;renderVillage();if(curP&&$('s-person').classList.contains('on')){var q=findP(curP.pid);if(q)person(q,true)}})} function findP(pid){for(var i=0;i<V.people.length;i++)if(V.people[i].pid===pid)return V.people[i];return null} function renderVillage(){if(V.home&&H.vibe==='all')$('v-room').textContent=V.home;if($('vv-title')&&V.room){$('vv-title').textContent=V.room;$('vv-city').textContent=(V.own?'Your village':'A village')+' · The City';$('vv-l
```

### sq/h/state
```
unction(){H.timer=null;if(!hOn())return;call('sq/h/state',{vibe:H.vibe,near:H.near}).then(function(r){if(r.ok){$('h-err').textContent='';H.st=r;badge(r.unread||0);hRender()}else $('h-err').textContent=r.error||'';if(hOn())H.timer=setTimeout(go,H.st&&H.st.cid?3000:5000)})};if(now)go();else H.timer=setTimeout(go,4000)} function hAct(path,body,ok){call('sq/h/'+path,body||{}).then(function(r){if(!r.ok){$('h-err').textContent=r.error||'';if(r.knock){H.mode='';hRender()}return}$('h-err').textContent='';if(ok)ok(r);hPoll(true)})} function hCircle(c){var d=docum
```

### sq/h/
```
t(go,4000)} function hAct(path,body,ok){call('sq/h/'+path,body||{}).then(function(r){if(!r.ok){$('h-err').textContent=r.error||'';if(r.knock){H.mode='';hRender()}return}$('h-err').textContent='';if(ok)ok(r);hPoll(true)})} function hCircle(c){var d=document.createElement('div');d.className='circ'+(c.inside?' inside':'')+(c.id===H.near&&!c.inside?' near':'')+(c.hushed?' hushed':''); var ring=document.createElement('div');ring.className='ring';var R=c.cap>6?86:80,S=c.cap>6?40:46; var full=c.seats.length>=c.cap; for(var i=0;i<c.cap;i++){var a=(-90+i*360/c.ca
```

### sq/h/glad
```
nerHTML='<span>Sent, quietly. ✦</span>';call('sq/h/glad',{pid:p});buzz()}}); return w} function hRender(){var st=H.st;if(!st)return;var f=$('h-floor'); var lines=$('h-lines');var stick=!lines||lines.scrollHeight-lines.scrollTop-lines.clientHeight<50; $('h-here').textContent=st.here?st.here+' here now':''; f.innerHTML='';var mine=null;st.circles.forEach(function(c){if(c.inside)mine=c}); if(mine){f.appendChild(hCircle(mine));f.appendChild(hInside(mine))} var others=st.circles.filter(function(c){return !c.inside}); if(others.length){if(mine){var h=document.
```

### sq/h/dm/list
```
r){clearTimeout(DM.timer);DM.timer=null}call('sq/h/dm/list').then(function(r){if(r.ok){var box=$('dm-list'),n=0;box.innerHTML=''; r.threads.forEach(function(t,i){n+=t.unread;var row=document.createElement('div');row.className='dmr'+(t.unread?' new':'');row.innerHTML='<span class="ws" id="dms'+i+'"></span><span class="wt"><span class="wa">'+esc(t.alias)+'</span><span class="wm">'+(t.last?(t.mine?'You: ':'')+esc(t.last):'Bonded ✦ · say hello')+'</span></span><span class="dmt">'+(t.at?ago(t.at):'')+(t.unread?'<i>'+t.unread+'</i>':'')+'</span>';row.onclick=f
```

### sq/h/dm/thread
```
M.ttimer);DM.ttimer=null}var pid=DM.pid;call('sq/h/dm/thread',{pid:pid,after:DM.last}).then(function(r){if(pid!==DM.pid)return;if(r.ok){if(!DM.peer||DM.peer.pid!==r.peer.pid){DM.peer=r.peer;$('t-name').textContent=r.peer.alias;sigil('t-sig',r.peer.points||{},r.peer.member,r.peer.pid)} var box=$('t-lines');var near=box.scrollHeight-box.scrollTop-box.clientHeight<60; r.msgs.forEach(function(m){if(m.id<=DM.last)return;DM.last=m.id;var d=document.createElement('div');d.className='ln'+(m.mine?' mine':'');d.innerHTML='<span>'+esc(m.body)+'</span><i>'+ago(m.at)
```

### sq/h/dm/send
```
eturn;var b=$('t-send');b.disabled=true;call('sq/h/dm/send',{pid:DM.pid,text:t}).then(function(r){b.disabled=false;if(!r.ok){$('e-t').textContent=r.error||'';return}$('e-t').textContent='';i.value='';buzz();var e=$('t-empty');if(e)e.remove();tLoad()})} function person(p,quiet){curP=p;if(!quiet){var from=$('s-dms').classList.contains('on')?'s-dms':$('s-vil')&&$('s-vil').classList.contains('on')?'s-vil':'s-village';show('s-person');hist=[from,'s-person']} sigil('sig-p',p.points||{},p.member,p.pid);$('pp-alias').textContent=p.alias+(p.me?' (you)':''); $('pp
```

### sq/vouch
```
vouch)return;var x=this;x.disabled=true;call('sq/vouch',{pid:q.pid,on:!q.vouch.mine}).then(function(r){x.disabled=false;if(!r.ok){$('e-p').textContent=r.error||'';return}buzz(r.vouched?'success':'');q.vouch.mine=r.vouched;person(q,true);loadVillage(V.own?'':V.room)})}} bv.style.display=pv.can?'':'none';bv.className=pv.mine?'btn ghost':'btn';bv.textContent=pv.mine?'Take back my vouch':'Vouch for '+p.alias+' · counts '+V.myWeight; var b=$('b-bond');$('e-p').textContent='';b.className='btn';b.disabled=false; if(p.me||V.own===false){b.style.display='none'}el
```

### sq/vote
```
x){x.onclick=function(){x.disabled=true;call('sq/vote',{pid:p.pid,v:x.dataset.v}).then(function(r){if(!r.ok){$('e-p').textContent=r.error||'';x.disabled=false;return}buzz('success');p.vote.canVote=false;p.vote.voted=true;person(p,true);loadVillage()})}})} else if(p.vote&&p.vote.voted)v.innerHTML='<p class="small" style="text-align:center;margin-top:18px">Your vote is in. Votes stay private.</p>'} $('b-bond').onclick=function(){var p=curP;if(!p)return;var b=this;b.disabled=true;call('sq/bond',{pid:p.pid}).then(function(r){if(!r.ok){$('e-p').textContent=r.
```

### sq/bond
```
if(!p)return;var b=this;b.disabled=true;call('sq/bond',{pid:p.pid}).then(function(r){if(!r.ok){$('e-p').textContent=r.error||'';b.disabled=false;return}p.bond=r.bond;buzz(r.bond==='bonded'?'success':'');if(r.bond==='bonded')$('sig-p').classList.add('pulse');setTimeout(function(){$('sig-p').classList.remove('pulse')},1200);person(p,true);loadVillage()})}; function qPaint(q){var b=$('b-quiet');if(!b)return;b.textContent='Starlove’s Telegram nudges: '+(q?'off':'on');b.dataset.q=q?'1':''} function qLoad(){call('sq/h/prefs').then(function(r){if(r.ok)qPaint(r.
```

### sq/h/prefs
```
;b.dataset.q=q?'1':''} function qLoad(){call('sq/h/prefs').then(function(r){if(r.ok)qPaint(r.quiet)})} $('b-quiet').onclick=function(){var q=!this.dataset.q;this.disabled=true;var me2=this;call('sq/h/prefs',{quiet:q}).then(function(r){me2.disabled=false;if(r.ok){qPaint(r.quiet);buzz()}})}; $('b-msg').onclick=function(){if(curP)thread(curP.pid)}; $('b-pback').onclick=function(){if(hist[0]==='s-vil')vil(V.room);else back()};$('b-tback').onclick=function(){dms()}; $('t-send').onclick=tSend;$('t-in').addEventListener('keydown',function(e){if(e.key==='Enter')
```

### sq/lab/
```
var t=b.textContent;b.textContent=label;call('sq/lab/'+p).then(function(r){b.disabled=false;b.textContent=t;if(!r.ok){$('lab-e').textContent=r.error||'';return}buzz('success');labCount();city()})}; $('lab-seed').onclick=function(){go('seed',this,'Seeding…')};$('lab-clear').onclick=function(){var b=this;if(!b.dataset.sure){b.dataset.sure=1;b.textContent='Tap again to clear';return}delete b.dataset.sure;go('clear',b,'Clearing…')};labCount()} function labCount(){call('sq/lab/count').then(function(r){if(r&&r.ok&&$('lab-n'))$('lab-n').textContent=r.bots?r.bot
```

### sq/lab/count
```
ing…')};labCount()} function labCount(){call('sq/lab/count').then(function(r){if(r&&r.ok&&$('lab-n'))$('lab-n').textContent=r.bots?r.bots+' bots live in the Lab. Fill again to reshuffle them.':'No bots yet. Fill the Lab to see it busy.'})} var MYVIL="",ME={pid:"p9",alias:"",hops:0,me:1},LIVE={pid:"",star:0,room:"",temple:"",since:"",member:0,here:0,ships:0,cid:0,bset:{},asked:{},reqs:{},look:null,sent:{},vfix:{},ready:0},P=function(e,t,a){return{pid:"p"+e,alias:t,hops:a}},STARS=[],SAY={},LINES={},LID=0,JOIN=0,START=Date.now();function addLine(e,t,a,n,o){
```

### sq/sky
```
(skyLone()?440:620)}function skyLoad(e){call("sq/sky").then(function(t){if(t.ok){SKY.d=t,t.stars.forEach(function(e){var t=skyPos(e);e.x=t.x,e.y=t.y}),skyRelax(t.stars),t.villages.forEach(function(e,a){var n=skyVilPos(a,t.villages.length);e.x=n.x,e.y=n.y}),$("sky-room").textContent=t.room;try{localStorage.setItem("dy_me",JSON.stringify({alias:t.alias||"",room:t.room||"",at:Date.now()}))}catch(e){}if($("sky-line").textContent=(t.here?t.here+" here now":"quiet tonight")+" · "+t.stars.length+" star"+(1===t.stars.length?"":"s"),SKY.inn&&!t.stars.some(functio
```

### sq/h/knock
```
l right now");else if(e.intro||e.hushed)call("sq/h/knock",{id:e.id}).then(function(t){t.ok?(buzz("success"),SKY.knock={id:e.id,at:Date.now()},SKY.lk={id:e.id,at:Date.now()},skyIsland(),skyKnockPoll()):skyFlash(t.error||"Could not knock")});else{var t=0,a=null,n=function(){if(t&&a){if(!a.ok)return a.knock?(SKY.sel=e,e.intro=1,skyIsland(),void skyFlash(a.error||"Knock to be let in")):(skyFlash(a.error||"Could not travel"),void skyHome());buzz("success"),skyLoad(function(){skyEnter()})}};skyWarp(e,function(){t=1,n()}),call("sq/h/join",{id:e.id}).then(functi
```

### sq/h/join
```
er()})}};skyWarp(e,function(){t=1,n()}),call("sq/h/join",{id:e.id}).then(function(e){a=e,n()})}}function skyKnockPoll(){clearInterval(SKY.hp),SKY.hp=setInterval(function(){SKY.knock?call("sq/h/state",{vibe:"all"}).then(function(e){if(e&&e.ok)return e.cid===SKY.knock.id?(SKY.knock=null,buzz("success"),void skyLoad(function(){skyEnter()})):void(e.knock&&"waiting"===e.knock.status||Date.now()-SKY.knock.at>8e3&&(SKY.knock=null,clearInterval(SKY.hp),skyFlash("No answer yet. If they let you in, you will fly straight there")))}):clearInterval(SKY.hp)},3e3)}func
```

### sq/h/say
```
(e){var t=e.value.trim();t&&(e.value="",call("sq/h/say",{text:t}).then(function(a){if(!a.ok)return skyFlash(a.error||"Not sent"),void(e.value=t);buzz("success"),skyHPoll()}))}}function skyNew(){var e=$("sky-in"),t=e?e.value.trim():"";call("sq/h/new",{vibe:"all",topic:t}).then(function(e){e.ok?(buzz("success"),SKY.mode="",skyLoad(function(){skyEnter()})):skyFlash(e.error||"Could not light a star")})}function skyIsland(){var e=$("sky-isl");if(e){var t=$("sky-il"),a=$("sky-ib"),n=SKY.d,o=SKY.sel,i=document.activeElement,r=i&&"sky-in"===i.id?i.value:null;SKY
```

### sq/h/new
```
var e=$("sky-in"),t=e?e.value.trim():"";call("sq/h/new",{vibe:"all",topic:t}).then(function(e){e.ok?(buzz("success"),SKY.mode="",skyLoad(function(){skyEnter()})):skyFlash(e.error||"Could not light a star")})}function skyIsland(){var e=$("sky-isl");if(e){var t=$("sky-il"),a=$("sky-ib"),n=SKY.d,o=SKY.sel,i=document.activeElement,r=i&&"sky-in"===i.id?i.value:null;SKY.inn||(a.dataset.h=""),e.classList.toggle("in",!!SKY.inn),e.classList.toggle("open",!!SKY.open),e.classList.toggle("big",!!(o||SKY.open||SKY.inn||SKY.mode||SKY.knock));var s=SKY.msg?'<div class=
```

### sq/h/answer
```
function(e){e.onclick=function(){buzz(),call("sq/h/answer",{kid:+e.dataset.k,a:e.dataset.a}).then(function(t){t&&!t.ok?skyFlash(t.error||""):"in"===e.dataset.a&&buzz("success"),skyHPoll()})}}),void a.querySelectorAll("[data-o]").forEach(function(e){e.onclick=function(){buzz();var t=e.dataset.o;if("sky"!==t)return"out"===t?e.dataset.sure?void call("sq/h/leave",{}).then(function(){buzz("success"),SKY.inn=0,SKY.cs=null,clearInterval(SKY.hp),skyLoad(function(){skyHome()})}):(e.dataset.sure=1,void(e.textContent="Tap again to step out")):void("hush"===t&&call(
```

### sq/h/leave
```
==t)return"out"===t?e.dataset.sure?void call("sq/h/leave",{}).then(function(){buzz("success"),SKY.inn=0,SKY.cs=null,clearInterval(SKY.hp),skyLoad(function(){skyHome()})}):(e.dataset.sure=1,void(e.textContent="Tap again to step out")):void("hush"===t&&call("sq/h/hush",{on:!(l&&l.hushed)}).then(function(e){e.ok?(buzz("success"),SKY.open=0,skyHPoll()):skyFlash(e.error||"")}));skyExit(1)}})}if(SKY.knock)return t.textContent="Knocking…",void(a.innerHTML='<div class="sky-cm" style="margin:0 4px">Someone inside can let you in. Stay close.</div>'+s);if("new"===S
```

### sq/h/hush
```
p again to step out")):void("hush"===t&&call("sq/h/hush",{on:!(l&&l.hushed)}).then(function(e){e.ok?(buzz("success"),SKY.open=0,skyHPoll()):skyFlash(e.error||"")}));skyExit(1)}})}if(SKY.knock)return t.textContent="Knocking…",void(a.innerHTML='<div class="sky-cm" style="margin:0 4px">Someone inside can let you in. Stay close.</div>'+s);if("new"===SKY.mode){t.textContent="Light it",a.innerHTML='<div class="sky-ct">A new star</div><div class="sky-cm">Name what you want to talk about. Others drift in.</div><div class="sky-say"><input id="sky-in" maxlength="8
```

### sq/h/unsay
```
button>'),$("tb-go").onclick=function(){call("sq/h/unsay",{id:e.lid}).then(function(t){$("v11-sheet").classList.remove("on"),t.ok?(buzz("success"),delete V11.cache[e.lid],SKY.bub=SKY.bub.filter(function(t){return t.lid!==e.lid}),skyFlashSoft("Taken back. Nobody will find it when they scroll back.")):skyFlashSoft(t.error)})}}skyTap=function(e,t){if(!V11.placing)for(var a=0;a<SKY.bubHit.length;a++){var n=SKY.bubHit[a];if(e>=n.x&&e<=n.x+n.w&&t>=n.y&&t<=n.y+n.h+8&&n.b&&tbLeft(n.b)>0)return void tbAsk(n.b)}tbTap0(e,t)};var tbBub0=skyBubbles,V14={tagFor:0,msgT
```

### sq/pg/list
```
GN=0;function cityOld(){hist=[];labMk();call('sq/pg/list').then(function(q){if(q&&q.ok){var n=q.asks.length+q.coming.filter(function(x){return !x.welcomed}).length;if(n!==PGN){PGN=n;if(MAPD&&$('s-city').classList.contains('on'))$('c-list').innerHTML&&city()}}});show('s-city');$('c-err').textContent='';var l=$('c-list');if(MAPD)l.innerHTML=mapSvg(MAPD);call('sq/map').then(function(r){if(!r.ok){$('c-err').textContent=r.error||'';return}MAPD=r;$('c-title').textContent=r.room;$('c-line').textContent=r.city+' · '+(r.live?r.live+' here now':'the island is quie
```

### sq/map
```
list');if(MAPD)l.innerHTML=mapSvg(MAPD);call('sq/map').then(function(r){if(!r.ok){$('c-err').textContent=r.error||'';return}MAPD=r;$('c-title').textContent=r.room;$('c-line').textContent=r.city+' · '+(r.live?r.live+' here now':'the island is quiet tonight');l.innerHTML=mapSvg(r); l.querySelectorAll('.mp').forEach(function(g){var go=function(){var k=g.dataset.k;buzz();if(k==='gate'){ptab='wait';vil(r.room);setPtab('wait')}else if(k==='hall'){location.href='/house/'}else if(k==='duty'){duty()}else if(k==='wayside'){wayside()}else if(SPACE_INFO[k]){space(k)
```

### sq/duty/new
```
rst.';return}var b=this;b.disabled=true;call('sq/duty/new',{title:t,body:$('du-b').value,kind:DU.kind}).then(function(r){b.disabled=false;if(!r.ok){$('du-e').textContent=r.error||'';return}$('du-e').textContent='';$('du-t').value='';$('du-b').value='';buzz('success');duLoad()})}; $('du-t').addEventListener('input',function(){$('du-e').textContent=''})} function duty(){duMk();hist=['s-city','s-duty'];show('s-duty');duLoad()} function duLoad(){call('sq/duty/list').then(function(r){if(!r.ok){$('du-e').textContent=r.error||'';return}DU.d=r;duRender()})} func
```

### sq/duty/list
```
w('s-duty');duLoad()} function duLoad(){call('sq/duty/list').then(function(r){if(!r.ok){$('du-e').textContent=r.error||'';return}DU.d=r;duRender()})} function duCard(x,mine){var d=document.createElement('div');d.className='du-card'+(x.official?' off':'');var kind=x.kind==='irl'?'In real life':'Digital'; var meta=(x.official?'The House':esc(x.by.alias))+' · '+kind+' · +'+x.reward+' token'+(x.reward>1?'s':'');var st='',acts=''; if(!mine){acts='<button class="btn" data-a="take">Answer this duty</button>'} else if(x.mineRaised){if(x.status==='open'){st='Wait
```

### sq/duty/
```
ion(){var a=b.dataset.a;b.disabled=true;call('sq/duty/'+a,{id:x.id}).then(function(r){b.disabled=false;if(!r.ok){d.querySelector('.du-err').textContent=r.error||'';return}buzz(a==='confirm'||a==='take'?'success':'');duLoad()})}});return d} function duRender(){var r=DU.d;$('du-tok').innerHTML='<span class="hk">✦ '+r.tokens+' token'+(r.tokens===1?'':'s')+'</span><span class="hd">Earned by answering duties. Spent on tickets and on travel across the Map.</span>'+(r.log&&r.log.length?'<span class="hc">Last: '+(r.log[0].delta>0?'+':'')+r.log[0].delta+' · '+esc
```

### sq/pg/say
```
rim();if(!t)return;$('pgm-in').value='';call('sq/pg/say',{id:PG.meet,text:t}).then(function(r){if(!r.ok){$('pgm-e').textContent=r.error||''}pgPoll()})}; $('pgm-go').onclick=send;$('pgm-in').addEventListener('keydown',function(e){if(e.key==='Enter')send()})} function wayside(){pgMk();clearInterval(PG.timer);hist=['s-city','s-pg'];show('s-pg');pgLoad()} function pgLoad(){call('sq/pg/list').then(function(r){if(!r.ok){$('pg-e').textContent=r.error||'';return}PG.d=r;pgRender()})} function pgAct(p,b,el,ok){el.disabled=true;call('sq/pg/'+p,b).then(function(r){e
```

### sq/pg/
```
ction pgAct(p,b,el,ok){el.disabled=true;call('sq/pg/'+p,b).then(function(r){el.disabled=false;if(!r.ok){$('pg-e').textContent=r.error||'';return}$('pg-e').textContent='';buzz('success');if(ok)ok(r);pgLoad()})} function pgWho(p){return '<b>'+esc(p.alias)+'</b>'+(p.room?' <span class="pg-v">'+esc(p.room)+'</span>':'')} function pgSteps(n){return n===null?'no road yet':n+' introduction'+(n===1?'':'s')+' away'+(n>3?' · a long pilgrimage':'')} function pgRender(){var r=PG.d;$('pg-fuel').innerHTML='<span class="hk">✦ '+r.tokens+' token'+(r.tokens===1?'':'s')+'
```

### sq/pg/draft
```
function(){var vb=this;vb.disabled=true;call('sq/pg/draft',{id:x.id}).then(function(q){vb.disabled=false;if(!q.ok){$('pg-e').textContent=q.error||'';return}V=q.parts;vb.style.display='none';var pp=d.querySelector('.pg-parts');pp.innerHTML='<p class="small">Starlove drafted this from what the house has seen. Untick anything you don’t want to say. Nothing is sent until you introduce them. Private messages are never read.</p>'+(V.length?'':'<p class="hush">The house has nothing on record yet. Your own words will have to do.</p>');V.forEach(function(v){var l
```

### sq/pg/targets
```
class="hush">Looking at the roads…</p>';call('sq/pg/targets').then(function(r){if(!r.ok){$('pg-e').textContent=r.error||'';return}PG.t=r.people;pgPickRender();$('pg-q').focus()})} function pgPickRender(){var l=$('pg-list');if(!PG.t)return;l.innerHTML='';PG.t.filter(function(p){return !PG.q||(p.alias+' '+(p.room||'')).toLowerCase().indexOf(PG.q)>=0}).slice(0,40).forEach(function(p){var d=document.createElement('div');d.className='pg-row'+(p.steps===null?' far':'');d.innerHTML='<span>'+pgWho(p)+'</span><span class="pg-v">'+pgSteps(p.steps)+'</span>';if(p.s
```

### sq/pg/start
```
xtContent='Tap again to set out';return}call('sq/pg/start',{pid:p.pid}).then(function(r){if(!r.ok){$('pg-e').textContent=r.error||'';return}buzz('success');$('pg-pick').style.display='none';pgLoad()})};l.appendChild(d)});if(!l.children.length)l.innerHTML='<p class="hush">Nobody by that name on the Map.</p>'} function pgOpen(id){pgMk();PG.meet=id;PG.after=0;$('pgm-msgs').innerHTML='';$('pgm-e').textContent='';hist=['s-city','s-pg','s-pgm'];show('s-pgm');pgPoll();clearInterval(PG.timer);PG.timer=setInterval(function(){if(!$('s-pgm').classList.contains('on'
```

### sq/pg/meet
```
turn}pgPoll()},5000)} function pgPoll(){call('sq/pg/meet',{id:PG.meet,after:PG.after}).then(function(r){if(!r.ok){$('pgm-e').textContent=r.error||'';return}var x=r.meet;$('pgm-h').innerHTML=x.canBond?'With <em>'+esc(x.other.alias)+'</em>':esc(x.pilgrim.alias)+' & '+esc(x.to.alias); $('pgm-line').textContent=(x.canBond?x.by.alias+' made this introduction':'You made this introduction')+' · '+x.mins+' min together'+(x.here.length?' · someone is here now':''); $('pgm-ref').innerHTML=x.kind==='verified'&&x.parts&&x.parts.length?'<div class="pg-ref"><span clas
```

### pass
```
}else village(m)} function renderPass(){call('pass').then(function(r){if(!r.ok){$('e-pass').textContent=r.error||'Couldn’t load your pass.';return}$('e-pass').textContent=''; if(window.qrcode){var q=qrcode(0,'M');q.addData(r.token);q.make();$('qr').innerHTML=q.createSvgTag({cellSize:6,margin:2,scalable:true})}else $('qr').textContent=r.token; var t=$('qr-t'),ms=Math.max(5,r.validFor||30)*1000;t.style.transition='none';t.style.width='100%';void t.offsetWidth;t.style.transition='width '+ms+'ms linear';t.style.width='0%'; passTimer=setTimeout(function(){if(
```

### door
```
how('s-doorres')} function check(token){call('door',{token:token}).then(function(r){if(!r.ok){alertBox(r.error||'Couldn’t check that pass.');return} if(!r.valid){$('d-verdict').className='verdict no';$('d-verdict').textContent='Not valid';$('sig-door').innerHTML='';$('d-who').textContent='';$('d-note').textContent=r.reason||'';if(tg&&tg.HapticFeedback)tg.HapticFeedback.notificationOccurred('error')} else{$('d-verdict').className='verdict yes';$('d-verdict').textContent='Welcome';sigil('sig-door',r.points||{},true,r.code);$('d-who').textContent=r.alias+(r
```

### me
```
e setTimeout(start,0); function start(){call('me').then(function(r){if(!r.ok){if(!initData){login=null;try{localStorage.removeItem('dy_login')}catch(e){}signin()}else show('s-out');return}if(r.me&&r.me.done)route(r.me);else{if(r.me&&r.me.alias)$('alias').value=r.me.alias;show('s-hello')}})} document.querySelectorAll('[data-adult]').forEach(function(b){b.onclick=function(){if(b.dataset.adult==='yes'){st.adult=true;show('s-name')}else show('s-minor')}}); $('b-name').onclick=function(){var a=$('alias').value.trim();if(!a){$('e-alias').textContent='Tell us w
```

### register
```
abled=true;$('e-words').textContent=''; call('register',{adult:st.adult,alias:st.alias,points:st.points,gender:st.gender,mode:st.mode,withCode:st.mode==='alone'?'':$('withCode').value.trim(),why:$('why').value.trim(),want:$('want').value.trim(),invite:$('invite').value.trim(),reddit:$('reddit').value.trim()}).then(function(r){b.disabled=false; if(r.ok){if(tg&&tg.HapticFeedback)tg.HapticFeedback.notificationOccurred('success');village(r.me);return} var f=r.field;if(f==='alias'){show('s-name');$('e-alias').textContent=r.error}else if(f==='points'){show('s-
```
