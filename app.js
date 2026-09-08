'use strict';
const DEFAULT_CASINOS=['Ameristar','Boomtown Biloxi','Boomtown NOLA','Caesars NOLA','Coushatta','GN Biloxi','GN Lake Charles','Gold Strike Tunica',"Harrah's Gulf Coast",'Hollywood Gulf Coast','Hollywood Tunica','Horseshoe Lake Charles','HorseShoe Tunica','IP Biloxi',"L'Auberge BR","L'Auberge LC",'Paragon','Pearl River','Scarlet Pearl','Southland','Treasure Chest','WaterView'];
const API=String(window.AP_CONFIG?.API_URL||'');
let db,deviceId,baseline,localState,eventsCache=[],syncKey='';
let actionLocked=false,syncRunning=false;

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

function defaultBaseline(){return {syncAt:0,casinos:DEFAULT_CASINOS,state:{session:'',casino:'',playerName:''},recon:{expected:0,physical:0,variance:0},freePlay:{cashCollected:0,earned:0,paid:0,payable:0},lastReload:null}}
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

function populateCasinos(){
  const list=[...new Set([...(baseline.casinos||[]),...DEFAULT_CASINOS])].filter(Boolean).sort();
  for(const id of ['casinoSelect','fpCasinoSelect']){
    const el=$(id),old=el.value;el.innerHTML='';for(const c of list) el.add(new Option(c,c));if(list.includes(old)) el.value=old;
  }
}
function render(){
  const v=viewData(),a=localState.active;
  $('newSession').hidden=!!a;$('activeSession').hidden=!a;
  if(a){$('activeCasino').textContent=a.casino;$('activePlayer').textContent='Player / Card: '+a.playerName;const lr=localState.lastReload;$('lastReload').textContent=lr?money(lr.amount).replace('.00','')+' at '+new Date(lr.ts).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}):'None yet'}
  $('fpPayable').textContent=money(v.fpPayable);
  $('fpPayDetail').textContent=money(v.fpEarned)+' earned · '+money(v.fpPaid)+' paid · '+money(v.fpCash)+' actual FP cash collected';
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
  else if(!endpointConfigured()) setStatus('Local mode ready. Configure the v7.1 sync URL before deployment.');
  else if(!syncKey) setStatus('Local mode ready. Enter the private sync key to enable Google backup.');
  window.addEventListener('online',()=>syncNow(false));window.addEventListener('offline',render);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncNow(false)});
  setInterval(()=>{if(!document.hidden)syncNow(false)},20000);
}
init().catch(e=>setStatus('Startup error: '+e.message));
