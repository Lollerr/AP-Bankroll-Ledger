'use strict';
const DEFAULT_CASINOS=['Ameristar','Boomtown Biloxi','Boomtown NOLA','Caesars NOLA','Coushatta','GN Biloxi','GN Lake Charles','Gold Strike Tunica',"Harrah's Gulf Coast",'Hollywood Gulf Coast','Hollywood Tunica','Horseshoe Lake Charles','HorseShoe Tunica','IP Biloxi',"L'Auberge BR","L'Auberge LC",'Paragon','Pearl River','Scarlet Pearl','Southland','Treasure Chest','WaterView'];
const API=String(window.AP_CONFIG?.API_URL||'');
let db,deviceId,baseline,localState,eventsCache=[],syncKey='';
let actionLocked=false,syncRunning=false;
let currentPage='ledger',scheduleView='date';

const $=id=>document.getElementById(id);
const money=n=>'$'+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const round2=n=>Math.round((Number(n)||0)*100)/100;
const endpointConfigured=()=>/^https:\/\//.test(API)&&!API.includes('PASTE_');
const configured=()=>endpointConfigured()&&!!syncKey;

async function openDB(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open('ap-bankroll-v7',1);
    r.onupgradeneeded=()=>{
      const d=r.result;
      if(!d.objectStoreNames.contains('events')) d.createObjectStore('events',{keyPath:'id'});
      if(!d.objectStoreNames.contains('meta')) d.createObjectStore('meta',{keyPath:'key'});
    };
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
}
function store(name,mode='readonly'){return db.transaction(name,mode).objectStore(name)}
function reqP(r){return new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function metaGet(key){const x=await reqP(store('meta').get(key));return x?.value}
async function metaSet(key,value){await reqP(store('meta','readwrite').put({key,value}))}
async function addEvent(ev){await reqP(store('events','readwrite').put(ev));await refreshEvents()}
async function refreshEvents(){eventsCache=await reqP(store('events').getAll());eventsCache.sort((a,b)=>a.createdAt-b.createdAt)}
async function markSynced(ids){const tx=db.transaction('events','readwrite'),s=tx.objectStore('events');for(const id of ids){const ev=await reqP(s.get(id));if(ev){ev.synced=true;ev.syncedAt=Date.now();s.put(ev)}}await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});await refreshEvents()}
async function deleteSynced(){const tx=db.transaction('events','readwrite'),s=tx.objectStore('events');for(const ev of eventsCache) if(ev.synced) s.delete(ev.id);await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});await refreshEvents()}

function defaultBaseline(){return {syncAt:0,casinos:DEFAULT_CASINOS,state:{session:'',casino:'',playerName:''},recon:{expected:0,physical:0,variance:0},freePlay:{cashCollected:0,earned:0,paid:0,payable:0},schedule:{ok:false,totalOffers:0,offerPay:0,monthLabel:'',unknownCount:0},scheduleData:{ok:false,monthLabel:'',entries:[],breakdown:[],unknown:[]},lastReload:null,recent:[]}}
function defaultState(){return {active:null,lastReload:null}}
function uuid(){return crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)}
function event(type,payload){return {id:uuid(),type,ts:new Date().toISOString(),createdAt:Date.now(),deviceId,payload,synced:false}}
function pending(){return eventsCache.filter(e=>!e.synced)}

function viewData(){
  const p=pending();
  let expected=Number(baseline.recon?.expected)||0;
  let physical=Number(baseline.recon?.physical)||0;
  let fpCash=Number(baseline.freePlay?.cashCollected)||0;
  let fpEarned=Number(baseline.freePlay?.earned)||0;
  let fpPaid=Number(baseline.freePlay?.paid)||0;
  for(const e of p){
    if(e.type==='cashout') expected+=Number(e.payload.net)||0;
    if(e.type==='freeplay'){
      const c=Number(e.payload.cashOut)||0; expected+=c; fpCash+=c; fpEarned+=round2(c*.15);
    }
    if(e.type==='fp_settlement') fpPaid+=Number(e.payload.amount)||0;
    if(e.type==='reconcile') physical=Number(e.payload.counted)||0;
    if(e.type==='correction'){
      const b=e.payload.before||{},a=e.payload.after||{};
      if(e.payload.targetType==='session' && String(b.status||'')!=='OPEN'){
        expected+=round2((Number(a.net)||0)-(Number(b.net)||0));
      }
      if(e.payload.targetType==='freeplay'){
        const delta=round2((Number(a.cashOut)||0)-(Number(b.cashOut)||0));
        expected+=delta;fpCash+=delta;fpEarned+=round2(delta*.15);
      }
    }
  }
  expected=round2(expected); physical=round2(physical);
  return {expected,physical,variance:round2(physical-expected),fpCash:round2(fpCash),fpEarned:round2(fpEarned),fpPaid:round2(fpPaid),fpPayable:Math.max(0,round2(fpEarned-fpPaid)),pending:p.length};
}

async function saveState(){await metaSet('localState',localState)}
async function saveSyncKey(){
  const raw=$('syncKeyInput').value.trim();
  if(raw.length<32){setStatus('Sync key looks too short. Paste the full private key.');return}
  syncKey=raw;await metaSet('syncKey',syncKey);$('syncKeyInput').value='';render();setStatus('Private sync key saved on this iPhone.');
  if(navigator.onLine) syncNow(true);
}
async function clearSyncKey(){
  if(!syncKey){setStatus('No sync key is stored on this device.');return}
  if(!confirm('Remove the private sync key from this iPhone? Local entries will remain, but cloud backup will stop until a key is saved again.')) return;
  syncKey='';await metaSet('syncKey','');$('syncKeyInput').value='';render();setStatus('Private sync key removed from this iPhone.');
}

function setStatus(t){$('status').textContent=t}
function lockActions(ms=650){
  if(actionLocked) return false;
  actionLocked=true;
  document.querySelectorAll('button:not(.small)').forEach(b=>b.disabled=true);
  setTimeout(()=>{actionLocked=false;document.querySelectorAll('button:not(.small)').forEach(b=>b.disabled=false);render()},ms);
  return true;
}

async function commitLocal(ev,stateMutator,msg){
  if(!lockActions()) return;
  try{
    await addEvent(ev);
    if(stateMutator) stateMutator();
    await saveState();
    render();
    setStatus(msg+' · saved on this iPhone');
    syncNow(false);
  }catch(err){setStatus('Local save failed: '+err.message)}
}

async function startSession(amount){
  const player=$('sessionPlayerName').value.trim(),casino=$('casinoSelect').value;
  if(!player){setStatus('Enter the player / card name.');return}
  if(localState.active){setStatus('A session is already active.');return}
  const sid='S-'+uuid();
  const ev=event('session_start',{sessionId:sid,casino,playerName:player,amount});
  await commitLocal(ev,()=>{localState.active={sessionId:sid,casino,playerName:player,initial:Number(amount),reloads:0,totalDeployed:Number(amount)};localState.lastReload=null;$('sessionPlayerName').value=''},'Session started');
}
async function addReload(amount){
  const a=localState.active;if(!a){setStatus('No active session.');return}
  const ev=event('reload',{sessionId:a.sessionId,casino:a.casino,playerName:a.playerName,amount});
  await commitLocal(ev,()=>{a.reloads+=Number(amount);a.totalDeployed+=Number(amount);localState.lastReload={amount:Number(amount),ts:ev.ts}},'Reload recorded');
}
async function finishSession(){
  const a=localState.active;if(!a){setStatus('No active session.');return}
  const raw=$('cashOutAmount').value.trim(),n=Number(raw);
  if(raw===''||!Number.isFinite(n)||n<0){setStatus('Enter the final amount.');return}
  const ev=event('cashout',{sessionId:a.sessionId,casino:a.casino,playerName:a.playerName,amount:n,totalDeployed:a.totalDeployed,net:round2(n-a.totalDeployed)});
  await commitLocal(ev,()=>{localState.active=null;localState.lastReload=null;$('cashOutAmount').value=''},'Session closed');
}
async function saveFreePlay(){
  const casino=$('fpCasinoSelect').value,player=$('fpPlayerName').value.trim();
  const faceRaw=$('fpFaceValue').value.trim(),cashRaw=$('fpCashOut').value.trim(),face=Number(faceRaw),cash=Number(cashRaw);
  if(!player){setStatus('Enter the name on the player card.');return}
  if(faceRaw===''||!Number.isFinite(face)||face<=0){setStatus('Enter the free-play face value.');return}
  if(cashRaw===''||!Number.isFinite(cash)||cash<0){setStatus('Enter the actual cash-out.');return}
  const ev=event('freeplay',{casino,playerName:player,faceValue:face,cashOut:cash});
  await commitLocal(ev,()=>{$('fpFaceValue').value='';$('fpCashOut').value=''},'Free play recorded');
}
async function settleFreePlay(){
  const due=viewData().fpPayable;
  if(due<=0){setStatus('There is no free-play payment balance due.');return}
  if(!confirm('Record '+money(due)+' as paid and reset the running 15% balance to $0?')) return;
  const ev=event('fp_settlement',{amount:due,note:'Free-play commission paid'});
  await commitLocal(ev,null,'Payment settlement recorded');
}
async function reconcileNow(){
  const raw=$('physicalCount').value.trim();if(raw===''){setStatus('Enter the physical bankroll count.');return}
  const n=Number(raw);if(!Number.isFinite(n)||n<0){setStatus('Enter a valid physical bankroll count.');return}
  if(n===0&&!confirm('Record an actual physical bankroll of $0?')) return;
  const ev=event('reconcile',{counted:n});
  await commitLocal(ev,()=>{$('physicalCount').value=''},'Reconciliation recorded');
}


function recentEntries(){
  const map=new Map();
  for(const x of (baseline.recent||[])) map.set(x.targetType+'|'+x.targetId,{...x});
  for(const e of pending()){
    const p=e.payload||{};
    if(e.type==='session_start'){
      map.set('session|'+p.sessionId,{targetType:'session',targetId:p.sessionId,ts:e.ts,casino:p.casino,playerName:p.playerName,initial:Number(p.amount)||0,reloads:0,totalDeployed:Number(p.amount)||0,final:0,net:-(Number(p.amount)||0),status:'OPEN'});
    }else if(e.type==='reload'){
      const k='session|'+p.sessionId,x=map.get(k);if(x){x.reloads=round2((Number(x.reloads)||0)+(Number(p.amount)||0));x.totalDeployed=round2((Number(x.initial)||0)+x.reloads);x.net=x.status==='CLOSED'?round2((Number(x.final)||0)-x.totalDeployed):-x.totalDeployed;x.ts=e.ts;}
    }else if(e.type==='cashout'){
      const k='session|'+p.sessionId;let x=map.get(k);if(!x)x={targetType:'session',targetId:p.sessionId,casino:p.casino,playerName:p.playerName,initial:Math.max(0,(Number(p.totalDeployed)||0)),reloads:0,totalDeployed:Number(p.totalDeployed)||0};x.final=Number(p.amount)||0;x.totalDeployed=Number(p.totalDeployed)||x.totalDeployed||0;x.net=Number(p.net)||0;x.status='CLOSED';x.ts=e.ts;map.set(k,x);
    }else if(e.type==='freeplay'){
      map.set('freeplay|'+e.id,{targetType:'freeplay',targetId:e.id,ts:e.ts,casino:p.casino,playerName:p.playerName,faceValue:Number(p.faceValue)||0,cashOut:Number(p.cashOut)||0});
    }else if(e.type==='correction'){
      const k=p.targetType+'|'+p.targetId,x=map.get(k);if(x){Object.assign(x,p.after||{});x.ts=e.ts;}
    }
  }
  return [...map.values()].sort((a,b)=>String(b.ts||'').localeCompare(String(a.ts||''))).slice(0,40);
}
function correctionLabel(x){
  const d=x.ts?new Date(x.ts).toLocaleDateString([], {month:'numeric',day:'numeric'}):'';
  if(x.targetType==='session') return `${d} · PLAY · ${x.casino} · ${x.playerName} · ${x.status==='OPEN'?'OPEN':money(x.net)+' P/L'}`;
  return `${d} · FP · ${x.casino} · ${x.playerName} · ${money(x.cashOut)}`;
}
function renderCorrectionPicker(){
  const sel=$('correctionTarget'),items=recentEntries(),old=sel.value;
  sel.innerHTML='';
  if(!items.length){sel.add(new Option('No recent entries available',''));$('correctionEmpty').hidden=false;$('sessionCorrection').hidden=true;$('fpCorrection').hidden=true;return}
  $('correctionEmpty').hidden=true;
  sel.add(new Option('Select an entry to correct…',''));
  for(const x of items) sel.add(new Option(correctionLabel(x),x.targetType+'|'+x.targetId));
  if([...sel.options].some(o=>o.value===old)) sel.value=old;
}
function selectedCorrection(){
  const val=$('correctionTarget').value;if(!val)return null;
  const i=val.indexOf('|');const type=val.slice(0,i),id=val.slice(i+1);
  return recentEntries().find(x=>x.targetType===type&&String(x.targetId)===id)||null;
}
function loadCorrectionTarget(){
  const x=selectedCorrection();$('sessionCorrection').hidden=!x||x.targetType!=='session';$('fpCorrection').hidden=!x||x.targetType!=='freeplay';
  if(!x)return;
  if(x.targetType==='session'){
    $('corrSessionCasino').value=x.casino;$('corrSessionPlayer').value=x.playerName;$('corrInitial').value=x.initial;$('corrReloads').value=x.reloads;$('corrFinal').value=x.final;
    $('corrFinal').disabled=x.status==='OPEN';$('corrSessionSummary').textContent=x.status==='OPEN'?'Active session · final amount remains unavailable until session is closed.':'Current P/L '+money(x.net)+' · deployed '+money(x.totalDeployed);
  }else{
    $('corrFpCasino').value=x.casino;$('corrFpPlayer').value=x.playerName;$('corrFpFace').value=x.faceValue;$('corrFpCash').value=x.cashOut;
  }
  $('correctionReason').value='';
}
async function saveCorrection(){
  const x=selectedCorrection();if(!x){setStatus('Select an entry to correct.');return}
  const reason=$('correctionReason').value.trim();let after;
  if(x.targetType==='session'){
    const casino=$('corrSessionCasino').value,player=$('corrSessionPlayer').value.trim();
    const ir=$('corrInitial').value.trim(),rr=$('corrReloads').value.trim(),fr=$('corrFinal').value.trim();
    const initial=Number(ir),reloads=Number(rr),final=x.status==='OPEN'?0:Number(fr);
    if(!player){setStatus('Enter the player / card name.');return}
    if(ir===''||!Number.isFinite(initial)||initial<=0){setStatus('Enter a valid positive initial load.');return}
    if(rr===''||!Number.isFinite(reloads)||reloads<0){setStatus('Enter a valid reload total.');return}
    if(x.status!=='OPEN'&&(fr===''||!Number.isFinite(final)||final<0)){setStatus('Enter a valid final cash-out.');return}
    const totalDeployed=round2(initial+reloads),net=x.status==='OPEN'?-totalDeployed:round2(final-totalDeployed);
    after={casino,playerName:player,initial,reloads,totalDeployed,final,net,status:x.status};
  }else{
    const casino=$('corrFpCasino').value,player=$('corrFpPlayer').value.trim();
    const ar=$('corrFpFace').value.trim(),cr=$('corrFpCash').value.trim(),faceValue=Number(ar),cashOut=Number(cr);
    if(!player){setStatus('Enter the name on the player card.');return}
    if(ar===''||!Number.isFinite(faceValue)||faceValue<=0){setStatus('Enter a valid free-play face value.');return}
    if(cr===''||!Number.isFinite(cashOut)||cashOut<0){setStatus('Enter a valid actual cash amount.');return}
    after={casino,playerName:player,faceValue,cashOut};
  }
  const before={...x};delete before.targetType;delete before.targetId;delete before.ts;
  const changed=Object.keys(after).some(k=>String(after[k])!==String(before[k]));if(!changed){setStatus('Nothing changed.');return}
  const ev=event('correction',{targetType:x.targetType,targetId:x.targetId,before,after,reason});
  await commitLocal(ev,()=>{
    if(x.targetType==='session'&&localState.active&&String(localState.active.sessionId)===String(x.targetId)){
      localState.active.casino=after.casino;localState.active.playerName=after.playerName;localState.active.initial=after.initial;localState.active.reloads=after.reloads;localState.active.totalDeployed=after.totalDeployed;
    }
  },'Correction recorded');
}

function populateCasinos(){
  const list=[...new Set([...(baseline.casinos||[]),...DEFAULT_CASINOS])].filter(Boolean).sort();
  for(const id of ['casinoSelect','fpCasinoSelect','corrSessionCasino','corrFpCasino']){
    const el=$(id),old=el.value;el.innerHTML='';for(const c of list) el.add(new Option(c,c));if(list.includes(old)) el.value=old;
  }
}
function render(){
  const v=viewData(),a=localState.active;
  $('newSession').hidden=!!a;$('activeSession').hidden=!a;
  if(a){$('activeCasino').textContent=a.casino;$('activePlayer').textContent='Player / Card: '+a.playerName;const lr=localState.lastReload;$('lastReload').textContent=lr?money(lr.amount).replace('.00','')+' at '+new Date(lr.ts).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}):'None yet'}
  const sched=baseline.schedule||{};
  $('fpPayable').textContent=money(v.fpPayable);
  $('fpActualCash').textContent=money(v.fpCash);
  $('fpScheduledTotal').textContent=sched.ok?money(sched.totalOffers):'—';
  $('fpScheduledPay').textContent=sched.ok?money(sched.offerPay):'—';
  $('fpMonthLabel').textContent=(sched.monthLabel||'CURRENT MONTH').toUpperCase();
  $('fpPayDetail').textContent=money(v.fpEarned)+' earned · '+money(v.fpPaid)+' paid';
  $('fpScheduleDetail').textContent=sched.ok?('Rusty schedule · '+(sched.unknownCount?String(sched.unknownCount)+' unknown FP offer'+(sched.unknownCount===1?'':'s')+' excluded':'all listed FP amounts known')):'Rusty schedule total unavailable until the next successful sync.';
  $('settleBtn').disabled=actionLocked||v.fpPayable<=0;
  $('variance').textContent=(v.variance<0?'−':'')+money(Math.abs(v.variance));$('variance').className='big '+(v.variance===0?'okText':'badText');
  $('reconDetail').textContent='Expected '+money(v.expected)+' · Physical '+money(v.physical);
  const online=navigator.onLine, p=v.pending;
  const badge=$('syncBadge');
  if(!endpointConfigured()){badge.className='badge warn';badge.textContent='SETUP NEEDED'}
  else if(!syncKey){badge.className='badge warn';badge.textContent='KEY NEEDED'}
  else {badge.className='badge '+(!online?'warn':p?'warn':'ok');badge.textContent=!online?'OFFLINE':p?(p+' PENDING'):'BACKED UP'}
  const last=baseline.syncAt?new Date(baseline.syncAt).toLocaleString():'Never';
  $('backupDetail').textContent=!endpointConfigured()?'Cloud endpoint not configured.':!syncKey?'Private sync key required before Google backup can run.':p?`${p} local entr${p===1?'y':'ies'} awaiting Google backup · Last cloud sync ${last}`:`All local entries backed up · Last cloud sync ${last}`;
  $('keyDetail').textContent=syncKey?'Private sync key is stored only on this device.':'No private sync key saved on this device.';
  renderCorrectionPicker();
  if(currentPage==='schedule') renderSchedule();
}


function esc(v){return String(v??'').replace(/[&<>\"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]))}
function money0(n){return '$'+Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0})}
function initials(name){const parts=String(name||'?').trim().split(/\s+/).filter(Boolean);return (parts.length>1?(parts[0][0]+parts[1][0]):parts[0]?.slice(0,2)||'?').toUpperCase()}
function showPage(page){
  currentPage=page==='schedule'?'schedule':'ledger';
  $('pageLedger').hidden=currentPage!=='ledger';$('pageSchedule').hidden=currentPage!=='schedule';
  $('tabLedger').classList.toggle('active',currentPage==='ledger');$('tabSchedule').classList.toggle('active',currentPage==='schedule');
  if(currentPage==='schedule') renderSchedule();
  window.scrollTo({top:0,behavior:'instant'});
}
function setScheduleView(view){scheduleView=['date','casino','calendar'].includes(view)?view:'date';renderSchedule()}
function scheduleData(){return baseline.scheduleData||{ok:false,monthLabel:'',entries:[],breakdown:[],unknown:[]}}
function renderSchedule(){
  if(!$('scheduleContent')) return;
  const d=scheduleData();
  $('viewDate').classList.toggle('active',scheduleView==='date');$('viewCasino').classList.toggle('active',scheduleView==='casino');$('viewCalendar').classList.toggle('active',scheduleView==='calendar');
  $('scheduleMonth').textContent=d.ok?d.monthLabel:'Schedule';
  $('schTotal').textContent=d.ok?money0(d.knownTotal):'—';$('schPay').textContent=d.ok?money(d.projectedPay):'—';
  $('schKnown').textContent=d.ok?String(d.knownCount):'—';$('schUnknown').textContent=d.ok?String(d.unknownCount):'—';
  $('scheduleMeta').textContent=d.ok?`${d.entryCount} scheduled entries · ${d.knownCount} known FP amounts · ${d.unknownCount} unknown · Last cloud sync ${baseline.syncAt?new Date(baseline.syncAt).toLocaleString():'—'}`:'Schedule unavailable until the next successful sync.';
  if(!d.ok){$('scheduleContent').innerHTML='<div class="schedule-empty">Schedule data is not available yet. Connect to the internet and tap SYNC NOW.</div>';return}
  if(scheduleView==='casino') renderScheduleCasino(d); else if(scheduleView==='calendar') renderScheduleCalendar(d); else renderScheduleDate(d);
}
function renderScheduleDate(d){
  const groups=new Map();
  for(const x of d.entries||[]){if(!groups.has(x.date))groups.set(x.date,[]);groups.get(x.date).push(x)}
  let html='';
  for(const [date,rows] of groups){
    const known=rows.reduce((a,x)=>a+(Number(x.amount)||0),0),unknown=rows.filter(x=>x.unknown).length;
    const label=rows[0]?.dateLabel||date;
    html+=`<section class="day-group"><div class="day-head"><span>${esc(label).toUpperCase()}</span><span>${money0(known)}${unknown?` <span class="pill">${unknown} IDK</span>`:''}</span></div>`;
    for(const x of rows){
      const amt=x.unknown?'IDK':money0(x.amount);
      const detail=[x.time,x.card].filter(Boolean).map(esc).join(' · ');
      html+=`<div class="offer-row"><div class="casino-mark">${esc(initials(x.location))}</div><div><div class="offer-location">${esc(x.location||'Unknown location')}</div><div class="offer-detail">${detail||'No time/card detail'}${x.fpRaw&&x.amount>0&&x.fpRaw.replace(/[$,\s]/g,'')!==String(x.amount)?` · FP ${esc(x.fpRaw)}`:''}</div></div><div class="offer-amount ${x.unknown?'unknown':''}">${esc(amt)}</div></div>`;
    }
    html+='</section>';
  }
  if((d.unknown||[]).length){html+=`<div class="schedule-section-title">Unknown / To Be Determined</div><section class="day-group unknown-card"><div class="unknown-title day-head"><span>FP AMOUNT UNKNOWN</span><span>${d.unknown.length}</span></div>`;for(const x of d.unknown){html+=`<div class="offer-row"><div class="casino-mark">?</div><div><div class="offer-location">${esc(x.location||'Unknown location')}</div><div class="offer-detail">${esc(x.dateLabel)} · ${esc(x.card||'No card')} · ${esc(x.time||'No time')}</div></div><div class="offer-amount unknown">${esc(x.fpRaw||'IDK')}</div></div>`}html+='</section>'}
  $('scheduleContent').innerHTML=html||'<div class="schedule-empty">No entries for this month.</div>';
}
function renderScheduleCasino(d){
  let html='<section class="casino-breakdown"><div class="breakdown-head"><div>CASINO / LOCATION</div><div class="num">OFFERS</div><div class="num">TOTAL FP</div><div class="num">15%</div></div>';
  for(const x of d.breakdown||[]){html+=`<div class="breakdown-row"><div class="breakdown-location">${esc(x.location)}${x.unknownCount?` <span class="pill">${x.unknownCount} IDK</span>`:''}</div><div class="num">${x.offers}</div><div class="num">${money0(x.total)}</div><div class="num">${money(x.pay)}</div></div>`}
  html+='</section>';
  if((d.unknown||[]).length){html+=`<div class="schedule-section-title">Unknown Offers</div><section class="day-group unknown-card">`;for(const x of d.unknown){html+=`<div class="offer-row"><div class="casino-mark">?</div><div><div class="offer-location">${esc(x.location)}</div><div class="offer-detail">${esc(x.dateLabel)} · ${esc(x.card||'No card')}</div></div><div class="offer-amount unknown">${esc(x.fpRaw||'IDK')}</div></div>`}html+='</section>'}
  $('scheduleContent').innerHTML=html;
}
function renderScheduleCalendar(d){
  const [year,month]=String(d.monthKey||'').split('-').map(Number);if(!year||!month){$('scheduleContent').innerHTML='<div class="schedule-empty">Calendar unavailable.</div>';return}
  const by={};for(const x of d.entries||[]){if(!by[x.date])by[x.date]={total:0,count:0,unknown:0};by[x.date].total+=Number(x.amount)||0;by[x.date].count++;if(x.unknown)by[x.date].unknown++}
  const first=new Date(year,month-1,1),days=new Date(year,month,0).getDate();let html='<div class="calendar-grid">';for(const w of ['S','M','T','W','T','F','S'])html+=`<div class="cal-dow">${w}</div>`;for(let i=0;i<first.getDay();i++)html+='<div class="cal-day empty"></div>';
  for(let day=1;day<=days;day++){const key=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,x=by[key];html+=`<div class="cal-day"><div class="cal-date">${day}</div>${x?`<div class="cal-total">${money0(x.total)}</div><div class="cal-count">${x.count} offer${x.count===1?'':'s'}${x.unknown?` · ${x.unknown} IDK`:''}</div>`:''}</div>`}
  html+='</div>';$('scheduleContent').innerHTML=html;
}

function jsonp(params,timeout=15000){
  return new Promise((resolve,reject)=>{
    const cb='apcb_'+Date.now()+'_'+Math.random().toString(36).slice(2);const s=document.createElement('script');
    const timer=setTimeout(()=>done(new Error('Cloud request timed out')),timeout);
    function done(err,data){clearTimeout(timer);try{delete window[cb]}catch(e){}s.remove();err?reject(err):resolve(data)}
    window[cb]=data=>done(null,data);
    const u=new URL(API);Object.entries({...params,key:syncKey,callback:cb}).forEach(([k,v])=>u.searchParams.set(k,v));s.src=u.toString();s.onerror=()=>done(new Error('Cloud request failed'));document.head.appendChild(s);
  });
}
async function bootstrapRemote(){
  if(!configured()||!navigator.onLine) return false;
  const data=await jsonp({action:'bootstrap'});
  if(!data?.ok){if(data?.error==='UNAUTHORIZED') throw new Error('Private sync key was rejected');throw new Error('Bootstrap failed')}
  baseline={...defaultBaseline(),...data,syncAt:Date.now()};delete baseline.ok;delete baseline.serverTime;
  await metaSet('baseline',baseline);
  if(pending().length===0){
    if(data.state?.session) localState={active:{sessionId:data.state.session,casino:data.state.casino,playerName:data.state.playerName,initial:Number(data.state.initial)||0,reloads:Number(data.state.reloads)||0,totalDeployed:Number(data.state.totalDeployed)||0},lastReload:data.lastReload||null};
    else localState=defaultState();
    await saveState();
  }
  populateCasinos();render();return true;
}
async function pollAck(ids){
  const waits=[500,1200,2500,4000,7000];
  for(const wait of waits){
    await new Promise(r=>setTimeout(r,wait));
    try{const a=await jsonp({action:'ack',ids:ids.join(',')},12000);if(a?.acked?.length) return a.acked}catch(e){}
  }
  return [];
}
async function syncNow(manual=false){
  if(syncRunning) return;
  if(!endpointConfigured()){if(manual)setStatus('Set the Apps Script /exec URL in config.js first.');return}
  if(!syncKey){if(manual)setStatus('Save the private sync key on this device first.');render();return}
  if(!navigator.onLine){if(manual)setStatus('Offline. Entries are safe locally and will sync when service returns.');render();return}
  syncRunning=true;
  try{
    await refreshEvents();
    let unsynced=pending();
    while(unsynced.length){
      const batch=unsynced.slice(0,20),ids=batch.map(e=>e.id);
      await fetch(API,{method:'POST',mode:'no-cors',redirect:'follow',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'sync',syncKey,events:batch})});
      const acked=await pollAck(ids);
      if(!acked.length) break;
      await markSynced(acked);unsynced=pending();
    }
    try{await bootstrapRemote();await deleteSynced()}catch(e){}
    render();
    if(manual)setStatus(pending().length?'Some entries are still awaiting backup.':'Google backup is current.');
  }catch(err){if(manual)setStatus('Sync failed; local data is intact: '+err.message)}finally{syncRunning=false;render()}
}

async function init(){
  if('serviceWorker'in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  db=await openDB();deviceId=await metaGet('deviceId');if(!deviceId){deviceId=uuid();await metaSet('deviceId',deviceId)}syncKey=await metaGet('syncKey')||'';
  baseline=await metaGet('baseline')||defaultBaseline();localState=await metaGet('localState')||defaultState();await refreshEvents();populateCasinos();render();
  if(configured()&&navigator.onLine){try{await bootstrapRemote()}catch(e){setStatus('Cloud unavailable; local mode is ready.')}syncNow(false)}
  else if(!endpointConfigured()) setStatus('Local mode ready. Configure the v7.4 sync URL before deployment.');
  else if(!syncKey) setStatus('Local mode ready. Enter the private sync key to enable Google backup.');
  window.addEventListener('online',()=>syncNow(false));window.addEventListener('offline',render);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncNow(false)});
  setInterval(()=>{if(!document.hidden)syncNow(false)},20000);
}
init().catch(e=>setStatus('Startup error: '+e.message));
