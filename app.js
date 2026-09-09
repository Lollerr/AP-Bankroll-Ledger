'use strict';
const APP_VERSION='8.2.5';
const DEFAULT_CASINOS=['Ameristar','Boomtown Biloxi','Boomtown NOLA','Caesars NOLA','Coushatta','GN Biloxi','GN Lake Charles','Gold Strike Tunica',"Harrah's Gulf Coast",'Hollywood Gulf Coast','Hollywood Tunica','Horseshoe Lake Charles','HorseShoe Tunica','IP Biloxi',"L'Auberge BR","L'Auberge LC",'Paragon','Pearl River','Scarlet Pearl','Southland','Treasure Chest','WaterView'];
const API=String(window.AP_CONFIG?.API_URL||'');
let db,deviceId,baseline,localState,eventsCache=[],syncKey='';
let actionLocked=false,syncRunning=false;
let bootstrapReady=false,cloudError='';
let currentPage='home',scheduleView='date',entryView='session',reportView='overview';

const $=id=>document.getElementById(id);
const money=n=>'$'+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const round2=n=>Math.round((Number(n)||0)*100)/100;
const endpointConfigured=()=>/^https:\/\//.test(API)&&!API.includes('PASTE_');
const configured=()=>endpointConfigured()&&!!syncKey;


// v8.0 raster casino icon library used by Schedule views; precached for offline use.
function casinoKey(location){
  const s=String(location||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ');
  if(s.includes('horseshoe')||s.includes('caesars')) return 'caesars';
  if(s.includes('mgm')) return 'mgm';
  if(s.includes('hard rock')) return 'hardrock';
  if(s.includes('bally')) return 'ballys';
  if(s.includes('wynn')) return 'wynn';
  if(s.includes('encore')) return 'encore';
  if(s.includes('resorts world')) return 'resortsworld';
  if(s.includes('ocean')) return 'ocean';
  if(s.includes('borgata')) return 'borgata';
  if(s.includes('gold strike')) return 'goldstrike';
  if(s.includes('southland')) return 'southland';
  if(s.includes('ameristar')) return 'ameristar';
  if(s.includes('waterview')||s.includes('water view')) return 'waterview';
  if(s.includes('pearl river')) return 'pearlriver';
  if(s.includes('harrah')) return 'harrahs';
  if(s.includes('hollywood')) return 'hollywood';
  if(s.includes('boomtown')) return 'boomtown';
  if(s.includes('coushatta')) return 'coushatta';
  if(s.includes('golden nugget')||/^gn\b/.test(s)) return 'goldennugget';
  if(s.includes('l auberge')||s.includes('lauberge')) return 'lauberge';
  if(s.includes('paragon')) return 'paragon';
  if(s.includes('scarlet pearl')) return 'scarletpearl';
  if(s.includes('treasure chest')) return 'treasurechest';
  if(/^ip\b/.test(s)||s.includes(' ip biloxi')) return 'ip';
  return 'generic';
}
function casinoIconSvg(location,compact=false){
  const k=casinoKey(location), c=compact?' casino-icon-compact':'';
  const raster=new Set(['caesars','mgm','hardrock','ballys','wynn','encore','resortsworld','ocean','borgata','harrahs','hollywood','ameristar','lauberge','goldennugget','southland','goldstrike','ip','pearlriver','waterview','coushatta']);
  if(raster.has(k)){
    return `<span class="casino-icon casino-${k}${c}" aria-hidden="true"><img src="casino-icons/${k}.png" alt="" loading="lazy" decoding="async"></span>`;
  }
  return `<span class="casino-icon casino-generic${c}" aria-hidden="true"><span class="casino-icon-text">${esc(initials(location))}</span></span>`;
}

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

function defaultBaseline(){return {syncAt:0,casinos:DEFAULT_CASINOS,state:{session:'',casino:'',playerName:''},recon:{expected:0,physical:0,variance:0},freePlay:{cashCollected:0,earned:0,paid:0,payable:0},schedule:{ok:false,totalOffers:0,offerPay:0,monthLabel:'',unknownCount:0},scheduleData:{ok:false,monthLabel:'',entries:[],breakdown:[],unknown:[]},reports:{sessions:[],freePlay:[],payments:[],reconciliations:[],corrections:[],scheduleSnapshots:[]},lastReload:null,recent:[]}}
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
  if(!endpointConfigured()){setStatus('Cloud endpoint is not configured.');return}
  if(!navigator.onLine){setStatus('Connect to the internet before saving or changing the private sync key so it can be verified.');return}
  if(syncRunning){setStatus('A sync is already in progress. Try again in a moment.');return}
  syncRunning=true;cloudError='';setStatus('Verifying private sync key…');render();
  const previousKey=syncKey;
  try{
    await bootstrapRemote(raw);
    syncKey=raw;await metaSet('syncKey',syncKey);$('syncKeyInput').value='';
    setStatus('Private sync key verified and saved on this device. Google ledger data loaded successfully.');
  }catch(err){
    syncKey=previousKey;cloudError=err.message||'Private sync key verification failed';
    setStatus(cloudError==='Private sync key was rejected'?'Private sync key rejected. Nothing was changed on this device.':'Key verification failed: '+cloudError);
  }finally{syncRunning=false;render()}
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

  // v8.1.1: build a durable correction list from report history first.
  // This keeps recently-synced offline entries correctable even if the
  // dedicated bootstrap `recent` payload is stale or missing on a device.
  const reports=baseline.reports||{};
  for(const x of (reports.sessions||[])){
    const id=String(x.id||'');
    if(!id) continue;
    map.set('session|'+id,{
      targetType:'session',targetId:id,ts:x.ts||x.date||'',casino:x.casino||'',playerName:x.playerName||'',
      initial:Number(x.initial)||0,reloads:Number(x.reloads)||0,totalDeployed:Number(x.totalDeployed)||0,
      final:Number(x.final)||0,net:Number(x.net)||0,status:String(x.status||'')
    });
  }
  for(const x of (reports.freePlay||[])){
    const id=String(x.id||'');
    if(!id) continue;
    map.set('freeplay|'+id,{
      targetType:'freeplay',targetId:id,ts:x.ts||'',casino:x.casino||'',playerName:x.playerName||'',
      faceValue:Number(x.faceValue)||0,cashOut:Number(x.cashOut)||0
    });
  }

  // The dedicated recent payload is preferred when present because it is the
  // server's intentionally small, correction-oriented view. It overwrites
  // matching report-history records by target type + target ID.
  for(const x of (baseline.recent||[])) map.set(x.targetType+'|'+x.targetId,{...x});

  // Pending local events are applied last so the picker always reflects the
  // newest unsynced state on this device.
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
  const sessionCount=items.filter(x=>x.targetType==='session').length;
  const fpCount=items.filter(x=>x.targetType==='freeplay').length;
  const detail=$('correctionSourceDetail');
  if(detail) detail.textContent=`${items.length} correctable entries loaded · ${sessionCount} sessions · ${fpCount} free play`;
  sel.innerHTML='';
  if(!items.length){sel.add(new Option('No recent entries available',''));$('correctionEmpty').hidden=false;$('sessionCorrection').hidden=true;$('fpCorrection').hidden=true;return}
  $('correctionEmpty').hidden=true;
  sel.add(new Option('Select an entry to correct…',''));
  for(const x of items) sel.add(new Option(correctionLabel(x),x.targetType+'|'+x.targetId));
  if([...sel.options].some(o=>o.value===old)) sel.value=old;
}
async function refreshCorrectionEntries(){
  if(!configured()){setStatus('Cloud sync must be configured before refreshing correction entries.');return}
  if(!navigator.onLine){setStatus('Offline. Correction entries will refresh when service returns.');return}
  if(syncRunning){setStatus('A sync is already in progress. Try again in a moment.');return}
  syncRunning=true;
  try{
    setStatus('Refreshing correction entries…');
    await bootstrapRemote();
    renderCorrectionPicker();
    const items=recentEntries();
    setStatus(`Correction entries refreshed · ${items.length} loaded · app ${APP_VERSION}`);
  }catch(err){
    cloudError=err.message||'Correction refresh failed';
    setStatus('Correction refresh failed: '+cloudError);
  }finally{syncRunning=false;render()}
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
  for(const id of ['casinoSelect','fpCasinoSelect','corrSessionCasino','corrFpCasino']){const el=$(id);if(!el)continue;const old=el.value;el.innerHTML='';for(const c of list)el.add(new Option(c,c));if(list.includes(old))el.value=old}
}
function render(){
  const v=viewData(),a=localState.active,sched=baseline.schedule||{};
  if($('newSession'))$('newSession').hidden=!!a;if($('activeSession'))$('activeSession').hidden=!a;
  if(a){$('activeCasino').textContent=a.casino;$('activePlayer').textContent='Player / Card: '+a.playerName;const lr=localState.lastReload;$('lastReload').textContent=lr?money(lr.amount).replace('.00','')+' at '+new Date(lr.ts).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'None yet'}
  const cloudLoaded=bootstrapReady||!!baseline.syncAt;
  $('homeExpected').textContent=cloudLoaded?money(v.expected):'—';$('homePhysical').textContent=cloudLoaded?money(v.physical):'—';$('homeVariance').textContent=cloudLoaded?((v.variance<0?'−':'')+money(Math.abs(v.variance))):'—';$('homeVariance').className=cloudLoaded?(v.variance===0?'good':'bad'):'';
  $('homeFpPayable').textContent=cloudLoaded?money(v.fpPayable):'—';$('homeFpCash').textContent=cloudLoaded?money(v.fpCash):'—';$('homeScheduled').textContent=cloudLoaded&&sched.ok?money0(sched.totalOffers):'—';$('homeScheduledPay').textContent=cloudLoaded&&sched.ok?money(sched.offerPay):'—';
  $('homeActive').hidden=!a;if(a){$('homeActiveCasino').textContent=a.casino;$('homeActivePlayer').textContent=a.playerName;$('homeDeployed').textContent=money0(a.totalDeployed);$('homeReloads').textContent=money0(a.reloads);$('homeLastReload').textContent=localState.lastReload?new Date(localState.lastReload.ts).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'None'}
  $('fpPayable').textContent=money(v.fpPayable);$('fpPayDetail').textContent=money(v.fpEarned)+' earned · '+money(v.fpPaid)+' paid';$('settleBtn').disabled=actionLocked||!cloudLoaded||v.fpPayable<=0;
  $('variance').textContent=(v.variance<0?'−':'')+money(Math.abs(v.variance));$('variance').className='big '+(v.variance===0?'good':'bad');$('reconDetail').textContent='Expected '+money(v.expected)+' · Physical '+money(v.physical);
  const online=navigator.onLine,p=v.pending,badge=$('syncBadge');if(!endpointConfigured()){badge.className='badge warn';badge.textContent='SETUP'}else if(!syncKey){badge.className='badge warn';badge.textContent='KEY NEEDED'}else if(cloudError&&!cloudLoaded){badge.className='badge warn';badge.textContent='SYNC ERROR'}else if(!cloudLoaded){badge.className='badge warn';badge.textContent='SYNC NEEDED'}else{badge.className='badge '+(!online||p?'warn':'ok');badge.textContent=!online?'OFFLINE':p?(p+' PENDING'):'BACKED UP'}
  const last=baseline.syncAt?new Date(baseline.syncAt).toLocaleString():'Never';const backup=!endpointConfigured()?'Cloud endpoint not configured.':!syncKey?'Private sync key required.':!cloudLoaded?(cloudError?`Ledger data unavailable — ${cloudError}.`:'Ledger data unavailable — sync required.'):p?`${p} local entr${p===1?'y':'ies'} awaiting backup · Last sync ${last}`:`All local entries backed up · Last sync ${last}`;$('backupDetail').textContent=backup;$('homeBackup').textContent=backup;$('keyDetail').textContent=syncKey?(cloudLoaded?'Private sync key verified on this device.':'A private sync key is stored, but it has not successfully loaded the ledger yet.'):'No private sync key saved on this device.';
  renderCorrectionPicker();if(currentPage==='schedule')renderSchedule();if(currentPage==='reports')renderReports();
}
function esc(v){return String(v??'').replace(/[&<>\"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]))}
function money0(n){return '$'+Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0})}

// Phoenix Link calculator. Constants mirror the denomination-specific models in
// "Copy of PL updated" -> "Additional PL Data". Bet-range and all-data models
// are intentionally excluded.
const PHOENIX_MHB=1888;
const PHOENIX_MODELS=[
  {id:'phoenixEv0102',label:'$0.01–$0.02',rtp:0.8175741352147923,growthPerSpin:1.2306234594423464,avgFeature:38.03728789138267},
  {id:'phoenixEv0525',label:'$0.05–$0.25',rtp:0.8451549207185887,growthPerSpin:1.2202279818355937,avgFeature:40.25382912648497},
  {id:'phoenixEv12',label:'$1–$2',rtp:0.8560457490531819,growthPerSpin:1.2615698511761881,avgFeature:42.625862845010616},
  {id:'phoenixEv510',label:'$5–$10',rtp:0.8293794521766762,growthPerSpin:1.2378646329837941,avgFeature:46.51317132768362}
];
function phoenixUnits(counter,model){
  const growth=(PHOENIX_MHB-counter)/2;
  const spins=growth/model.growthPerSpin;
  return model.avgFeature-spins*(1-model.rtp);
}
function renderPhoenixCalculator(){
  const input=$('phoenixCounter');if(!input)return;
  const raw=input.value.trim().replace(/,/g,'');
  const counter=Number(raw),valid=raw!==''&&Number.isFinite(counter)&&counter>=0;
  for(const model of PHOENIX_MODELS){
    const el=$(model.id);if(!el)continue;
    if(!valid){el.textContent='—';el.className='';continue}
    const units=phoenixUnits(counter,model);
    el.textContent=(units>0?'+':'')+units.toFixed(2)+' units';
    el.className=units>0?'good':units<0?'bad':'';
  }
  const hint=$('phoenixHint');if(hint)hint.textContent=valid?'Probable EV in bet units · denomination-specific historical model.':'Enter a valid non-negative persistent counter.';
}

// Wolf Run Eclipse calculator. This reproduces "Copy of Slots Analyzer v1.2"
// -> WRE -> AT10 exactly. The sheet's dependency chain reduces to:
// AT10 = AS2*0.03428 + AT2*0.02468 + AU2*0.017629.
// AV2 (Mega) is an input on the sheet but is not referenced by AT10.
function wreValue(id){
  const el=$(id);if(!el)return {valid:false,value:0};
  const raw=el.value.trim().replace(/,/g,'');
  const value=Number(raw);
  return {valid:raw!==''&&Number.isFinite(value)&&value>=0,value};
}
function wreEv(mini,minor,major){return mini*0.03428+minor*0.02468+major*0.017629}
function renderWreCalculator(){
  const mini=wreValue('wreMini'),minor=wreValue('wreMinor'),major=wreValue('wreMajor'),mega=wreValue('wreMega');
  const out=$('wreEv'),hint=$('wreHint');if(!out)return;
  const coreValid=mini.valid&&minor.valid&&major.valid;
  if(!coreValid){out.textContent='—';out.className='hero';if(hint)hint.textContent='Enter valid non-negative Mini, Minor and Major values. Mega is optional because the sheet AT10 formula does not reference it.';return}
  const ev=wreEv(mini.value,minor.value,major.value);
  out.textContent=(ev>0?'+':'')+ev.toFixed(2);
  out.className='hero '+(ev>0?'good':ev<0?'bad':'');
  if(hint)hint.textContent='';
}

// Magic Treasures Gold calculator. This reproduces "Copy of Slots Analyzer v1.2"
// -> Magic Treasures Gold -> AM9 exactly:
// AM9 = AM3*0.043496 + AN3*0.022892 + AO3*0.0079094.
function mtgValue(id){
  const el=$(id);if(!el)return {valid:false,value:0};
  const raw=el.value.trim().replace(/,/g,'');
  const value=Number(raw);
  return {valid:raw!==''&&Number.isFinite(value)&&value>=0,value};
}
function mtgEv(green,purple,gold){return green*0.043496+purple*0.022892+gold*0.0079094}
function renderMtgCalculator(){
  const green=mtgValue('mtgGreen'),purple=mtgValue('mtgPurple'),gold=mtgValue('mtgGold');
  const out=$('mtgEv');if(!out)return;
  if(!(green.valid&&purple.valid&&gold.valid)){out.textContent='—';out.className='hero';return}
  const ev=mtgEv(green.value,purple.value,gold.value);
  out.textContent=(ev>0?'+':'')+ev.toFixed(2);
  out.className='hero '+(ev>0?'good':ev<0?'bad':'');
}
function initials(name){const parts=String(name||'?').trim().split(/\s+/).filter(Boolean);return(parts.length>1?(parts[0][0]+parts[1][0]):parts[0]?.slice(0,2)||'?').toUpperCase()}
function showPage(page){currentPage=['home','schedule','add','reports','calculators','more'].includes(page)?page:'home';for(const p of ['Home','Schedule','Add','Reports','Calculators','More'])$('page'+p).hidden=currentPage!==p.toLowerCase();for(const p of ['Home','Schedule','Add','Reports','More'])$('nav'+p).classList.toggle('active',currentPage===p.toLowerCase());if(currentPage==='schedule')renderSchedule();if(currentPage==='reports')renderReports();window.scrollTo({top:0,behavior:'instant'})}
function showCalculatorsHome(){showPage('calculators');$('calculatorHub').hidden=false;$('calculatorPhoenix').hidden=true;$('calculatorWre').hidden=true;$('calculatorMtg').hidden=true}
function openCalculator(name){showPage('calculators');$('calculatorHub').hidden=true;$('calculatorPhoenix').hidden=name!=='phoenix';$('calculatorWre').hidden=name!=='wre';$('calculatorMtg').hidden=name!=='mtg';if(name==='phoenix'){renderPhoenixCalculator();setTimeout(()=>{const el=$('phoenixCounter');if(el)el.focus()},0)}if(name==='wre'){renderWreCalculator();setTimeout(()=>{const el=$('wreMini');if(el)el.focus()},0)}if(name==='mtg'){renderMtgCalculator();setTimeout(()=>{const el=$('mtgGreen');if(el)el.focus()},0)}}
function goAdd(view){showPage('add');setEntryView(view)}
function setEntryView(view){entryView=['session','freeplay','reconcile'].includes(view)?view:'session';$('entrySession').hidden=entryView!=='session';$('entryFreeplay').hidden=entryView!=='freeplay';$('entryReconcile').hidden=entryView!=='reconcile';$('entrySessionTab').classList.toggle('active',entryView==='session');$('entryFpTab').classList.toggle('active',entryView==='freeplay');$('entryReconTab').classList.toggle('active',entryView==='reconcile')}
function setReportView(view){reportView=['overview','casino','fp','audit'].includes(view)?view:'overview';for(const x of ['Overview','Casino','Fp','Audit'])$('report'+x+'Tab').classList.toggle('active',reportView===x.toLowerCase());renderReports()}
function reportData(){return baseline.reports||{sessions:[],freePlay:[],payments:[],reconciliations:[],corrections:[],scheduleSnapshots:[]}}
function dateOf(x){const d=new Date(x);return isNaN(d)?null:d}
function reportFiltered(){const r=reportData(),mode=$('reportPeriod')?.value||'month',now=new Date();let start=null;if(mode==='month')start=new Date(now.getFullYear(),now.getMonth(),1);else if(mode==='30')start=new Date(now.getTime()-30*864e5);else if(mode==='ytd')start=new Date(now.getFullYear(),0,1);const keep=x=>!start||((dateOf(x.ts||x.date||x.timestamp)||new Date(0))>=start);return {...r,sessions:(r.sessions||[]).filter(keep),freePlay:(r.freePlay||[]).filter(keep),payments:(r.payments||[]).filter(keep),reconciliations:(r.reconciliations||[]).filter(keep),corrections:(r.corrections||[]).filter(keep)}}
function sum(a,f){return round2(a.reduce((s,x)=>s+(Number(f(x))||0),0))}
function groupBy(a,key){const m={};for(const x of a){const k=key(x)||'Unknown';(m[k]||(m[k]=[])).push(x)}return m}
function monthKey(ts){const d=dateOf(ts);return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`:''}
function chartSvg(points){if(points.length<2)return '<div class="sub">Not enough history yet.</div>';const vals=points.map(x=>x.v),mn=Math.min(...vals),mx=Math.max(...vals),rng=Math.max(1,mx-mn);const coords=points.map((x,i)=>`${(i/(points.length-1))*100},${95-((x.v-mn)/rng)*80}`).join(' ');return `<svg class="trend" viewBox="0 0 100 100" preserveAspectRatio="none"><line class="axis" x1="0" y1="95" x2="100" y2="95"/><polyline points="${coords}"/></svg><div class="sub">${money(mn)} low · ${money(mx)} high</div>`}
function renderReports(){if(!$('reportsContent'))return;const r=reportFiltered(),sessions=(r.sessions||[]).filter(x=>x.status==='CLOSED'),fp=r.freePlay||[];const net=sum(sessions,x=>x.net),deployed=sum(sessions,x=>x.totalDeployed),wins=sessions.filter(x=>Number(x.net)>0),losses=sessions.filter(x=>Number(x.net)<0),fpFace=sum(fp,x=>x.faceValue),fpCash=sum(fp,x=>x.cashOut),conv=fpFace?fpCash/fpFace:0;
 let html='';if(reportView==='overview'){const best=sessions.length?Math.max(...sessions.map(x=>Number(x.net)||0)):0,worst=sessions.length?Math.min(...sessions.map(x=>Number(x.net)||0)):0;html=`<div class="report-kpis"><div class="report-kpi"><span>NET AP P/L</span><b class="${net>=0?'good':'bad'}">${money(net)}</b></div><div class="report-kpi"><span>SESSIONS</span><b>${sessions.length}</b></div><div class="report-kpi"><span>WIN RATE</span><b>${sessions.length?(wins.length/sessions.length*100).toFixed(1):'0.0'}%</b></div><div class="report-kpi"><span>FP CASH</span><b>${money(fpCash)}</b></div></div><section class="report-card"><h3>Session Analytics</h3><table class="data-table"><tr><th>Metric</th><th>Value</th></tr><tr><td>Total deployed</td><td>${money(deployed)}</td></tr><tr><td>P/L per $1,000 deployed</td><td>${deployed?money(net/deployed*1000):'$0.00'}</td></tr><tr><td>Average session</td><td>${sessions.length?money(net/sessions.length):'$0.00'}</td></tr><tr><td>Best session</td><td class="good">${money(best)}</td></tr><tr><td>Worst session</td><td class="bad">${money(worst)}</td></tr><tr><td>Winning / losing</td><td>${wins.length} / ${losses.length}</td></tr></table></section>`;
 const months=groupBy(sessions,x=>monthKey(x.ts||x.date));const fpMonths=groupBy(fp,x=>monthKey(x.ts));const keys=[...new Set([...Object.keys(months),...Object.keys(fpMonths)])].filter(Boolean).sort().reverse();html+=`<section class="report-card"><h3>Monthly Summary</h3><table class="data-table"><tr><th>Month</th><th>AP P/L</th><th>FP Cash</th><th>Combined</th></tr>${keys.map(k=>{const p=sum(months[k]||[],x=>x.net),f=sum(fpMonths[k]||[],x=>x.cashOut);return `<tr><td>${k}</td><td class="${p>=0?'good':'bad'}">${money(p)}</td><td>${money(f)}</td><td>${money(p+f)}</td></tr>`}).join('')||'<tr><td colspan="4">No data</td></tr>'}</table></section>`;
 const pts=(r.reconciliations||[]).map(x=>({v:Number(x.expected)||0}));html+=`<section class="report-card"><h3>Bankroll History</h3>${chartSvg(pts)}</section>`}
 else if(reportView==='casino'){const g=groupBy(sessions,x=>x.casino),rows=Object.entries(g).map(([k,a])=>({k,n:a.length,net:sum(a,x=>x.net),dep:sum(a,x=>x.totalDeployed),wins:a.filter(x=>x.net>0).length})).sort((a,b)=>b.net-a.net);const max=Math.max(1,...rows.map(x=>Math.abs(x.net)));html=`<section class="report-card"><h3>Casino Performance</h3>${rows.map(x=>`<div class="bar-row"><span>${esc(x.k)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,Math.abs(x.net)/max*100)}%"></div></div><b class="${x.net>=0?'good':'bad'}">${money(x.net)}</b></div>`).join('')||'<div class="sub">No sessions in period.</div>'}</section><section class="report-card"><table class="data-table"><tr><th>Casino</th><th>Sessions</th><th>Win%</th><th>Deployed</th><th>ROI</th></tr>${rows.map(x=>`<tr><td>${esc(x.k)}</td><td>${x.n}</td><td>${(x.wins/x.n*100).toFixed(0)}%</td><td>${money0(x.dep)}</td><td>${x.dep?(x.net/x.dep*100).toFixed(1):'0'}%</td></tr>`).join('')}</table></section>`;const pg=groupBy(sessions,x=>x.playerName);const pr=Object.entries(pg).map(([k,a])=>({k,n:a.length,net:sum(a,x=>x.net)})).sort((a,b)=>b.net-a.net);html+=`<section class="report-card"><h3>Player / Card Performance</h3><table class="data-table"><tr><th>Player / Card</th><th>Sessions</th><th>P/L</th></tr>${pr.map(x=>`<tr><td>${esc(x.k)}</td><td>${x.n}</td><td class="${x.net>=0?'good':'bad'}">${money(x.net)}</td></tr>`).join('')}</table></section>`}
 else if(reportView==='fp'){const earned=round2(fpCash*.15),payments=sum(r.payments||[],x=>x.amount),payable=Math.max(0,round2(earned-payments));html=`<div class="report-kpis"><div class="report-kpi"><span>FACE VALUE</span><b>${money(fpFace)}</b></div><div class="report-kpi"><span>ACTUAL CASH</span><b>${money(fpCash)}</b></div><div class="report-kpi"><span>CONVERSION</span><b>${(conv*100).toFixed(1)}%</b></div><div class="report-kpi"><span>15% EARNED</span><b>${money(earned)}</b></div></div>`;const fg=groupBy(fp,x=>x.casino),rows=Object.entries(fg).map(([k,a])=>({k,face:sum(a,x=>x.faceValue),cash:sum(a,x=>x.cashOut)})).sort((a,b)=>b.cash-a.cash);html+=`<section class="report-card"><h3>Free Play by Casino</h3><table class="data-table"><tr><th>Casino</th><th>Face</th><th>Cash</th><th>Conv.</th></tr>${rows.map(x=>`<tr><td>${esc(x.k)}</td><td>${money0(x.face)}</td><td>${money0(x.cash)}</td><td>${x.face?(x.cash/x.face*100).toFixed(1):0}%</td></tr>`).join('')}</table></section>`;
 const snaps=r.scheduleSnapshots||[],snapMonths=groupBy(snaps,x=>x.monthKey),colMonths=groupBy(fp,x=>monthKey(x.ts));const mk=[...new Set([...Object.keys(snapMonths),...Object.keys(colMonths)])].filter(Boolean).sort().reverse();html+=`<section class="report-card"><h3>Schedule vs Collection</h3><table class="data-table"><tr><th>Month</th><th>Scheduled</th><th>Collected Face</th><th>Progress</th></tr>${mk.map(k=>{const s=sum(snaps[k]||[],x=>x.amount),c=sum(colMonths[k]||[],x=>x.faceValue);return `<tr><td>${k}</td><td>${money0(s)}</td><td>${money0(c)}</td><td>${s?Math.min(999,c/s*100).toFixed(1):'—'}%</td></tr>`}).join('')||'<tr><td colspan="4">Schedule snapshots begin with v8.0.</td></tr>'}</table><div class="sub">Progress compares scheduled known face value with recorded free-play face value. Unknown schedule amounts are excluded.</div></section><section class="report-card"><h3>15% Pay History</h3><div class="sub">Earned ${money(earned)} · Paid ${money(payments)} · Current calculated balance ${money(payable)}</div><table class="data-table"><tr><th>Date</th><th>Payment</th><th>Note</th></tr>${(r.payments||[]).slice().reverse().map(x=>`<tr><td>${esc((x.ts||'').slice(0,10))}</td><td>${money(x.amount)}</td><td>${esc(x.note||'')}</td></tr>`).join('')||'<tr><td colspan="3">No payments in period.</td></tr>'}</table></section>`}
 else{const corrections=r.corrections||[],recs=r.reconciliations||[],largeLosses=sessions.filter(x=>Number(x.net)<=-1000).sort((a,b)=>a.net-b.net),highReload=sessions.filter(x=>Number(x.reloads)>=2000).sort((a,b)=>b.reloads-a.reloads);html=`<div class="report-kpis"><div class="report-kpi"><span>CORRECTIONS</span><b>${corrections.length}</b></div><div class="report-kpi"><span>RECON CHECKS</span><b>${recs.length}</b></div><div class="report-kpi"><span>LOSSES ≤ -$1K</span><b>${largeLosses.length}</b></div><div class="report-kpi"><span>RELOADS ≥ $2K</span><b>${highReload.length}</b></div></div><section class="report-card"><h3>Exceptions / Audit</h3>${largeLosses.slice(0,10).map(x=>`<div class="audit-item"><b class="bad">${money(x.net)}</b> · ${esc(x.casino)}<div class="sub">${esc(x.playerName)} · deployed ${money(x.totalDeployed)}</div></div>`).join('')}${highReload.slice(0,10).map(x=>`<div class="audit-item"><b>${money(x.reloads)} reloads</b> · ${esc(x.casino)}<div class="sub">${esc(x.playerName)}</div></div>`).join('')||'<div class="sub">No flagged exceptions in this period.</div>'}</section><section class="report-card"><h3>Reconciliation History</h3><table class="data-table"><tr><th>Date</th><th>Expected</th><th>Physical</th><th>Variance</th></tr>${recs.slice().reverse().map(x=>`<tr><td>${esc((x.ts||'').slice(0,10))}</td><td>${money(x.expected)}</td><td>${money(x.physical)}</td><td class="${Math.abs(x.variance)<.01?'good':'bad'}">${money(x.variance)}</td></tr>`).join('')||'<tr><td colspan="4">History begins with v8.0 reconciliations.</td></tr>'}</table></section><section class="report-card"><h3>Correction Log</h3>${corrections.slice().reverse().slice(0,30).map(x=>`<div class="audit-item"><b>${esc(x.field)}</b>: ${esc(x.original)} → ${esc(x.corrected)}<div class="sub">${esc((x.ts||'').slice(0,10))} · ${esc(x.targetType)} · ${esc(x.reason||'No reason')}</div></div>`).join('')||'<div class="sub">No corrections in this period.</div>'}</section>`}
 $('reportsContent').innerHTML=html}

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
      html+=`<div class="offer-row">${casinoIconSvg(x.location)}<div><div class="offer-location">${esc(x.location||'Unknown location')}</div><div class="offer-detail">${detail||'No time/card detail'}${x.fpRaw&&x.amount>0&&x.fpRaw.replace(/[$,\s]/g,'')!==String(x.amount)?` · FP ${esc(x.fpRaw)}`:''}</div></div><div class="offer-amount ${x.unknown?'unknown':''}">${esc(amt)}</div></div>`;
    }
    html+='</section>';
  }
  if((d.unknown||[]).length){html+=`<div class="schedule-section-title">Unknown / To Be Determined</div><section class="day-group unknown-card"><div class="unknown-title day-head"><span>FP AMOUNT UNKNOWN</span><span>${d.unknown.length}</span></div>`;for(const x of d.unknown){html+=`<div class="offer-row"><span class="casino-icon casino-generic"><span class="casino-icon-text">?</span></span><div><div class="offer-location">${esc(x.location||'Unknown location')}</div><div class="offer-detail">${esc(x.dateLabel)} · ${esc(x.card||'No card')} · ${esc(x.time||'No time')}</div></div><div class="offer-amount unknown">${esc(x.fpRaw||'IDK')}</div></div>`}html+='</section>'}
  $('scheduleContent').innerHTML=html||'<div class="schedule-empty">No entries for this month.</div>';
}
function renderScheduleCasino(d){
  let html='<section class="casino-breakdown"><div class="breakdown-head"><div>CASINO / LOCATION</div><div class="num">OFFERS</div><div class="num">TOTAL FP</div><div class="num">15%</div></div>';
  for(const x of d.breakdown||[]){html+=`<div class="breakdown-row"><div class="breakdown-location-wrap">${casinoIconSvg(x.location,true)}<div class="breakdown-location">${esc(x.location)}${x.unknownCount?` <span class="pill">${x.unknownCount} IDK</span>`:''}</div></div><div class="num">${x.offers}</div><div class="num">${money0(x.total)}</div><div class="num">${money(x.pay)}</div></div>`}
  html+='</section>';
  if((d.unknown||[]).length){html+=`<div class="schedule-section-title">Unknown Offers</div><section class="day-group unknown-card">`;for(const x of d.unknown){html+=`<div class="offer-row"><span class="casino-icon casino-generic"><span class="casino-icon-text">?</span></span><div><div class="offer-location">${esc(x.location)}</div><div class="offer-detail">${esc(x.dateLabel)} · ${esc(x.card||'No card')}</div></div><div class="offer-amount unknown">${esc(x.fpRaw||'IDK')}</div></div>`}html+='</section>'}
  $('scheduleContent').innerHTML=html;
}
function renderScheduleCalendar(d){
  const [year,month]=String(d.monthKey||'').split('-').map(Number);if(!year||!month){$('scheduleContent').innerHTML='<div class="schedule-empty">Calendar unavailable.</div>';return}
  const by={};for(const x of d.entries||[]){if(!by[x.date])by[x.date]={total:0,count:0,unknown:0,locations:[]};by[x.date].total+=Number(x.amount)||0;by[x.date].count++;if(x.unknown)by[x.date].unknown++;if(x.location&&!by[x.date].locations.includes(x.location))by[x.date].locations.push(x.location)}
  const first=new Date(year,month-1,1),days=new Date(year,month,0).getDate();let html='<div class="calendar-grid">';for(const w of ['S','M','T','W','T','F','S'])html+=`<div class="cal-dow">${w}</div>`;for(let i=0;i<first.getDay();i++)html+='<div class="cal-day empty"></div>';
  for(let day=1;day<=days;day++){const key=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,x=by[key];const icons=x?(x.locations||[]).slice(0,3).map(v=>casinoIconSvg(v,true)).join(''):'';const more=x&&x.locations.length>3?`<span class="cal-more">+${x.locations.length-3}</span>`:'';html+=`<div class="cal-day"><div class="cal-date">${day}</div>${x?`<div class="cal-icons">${icons}${more}</div><div class="cal-total">${money0(x.total)}</div><div class="cal-count">${x.count} offer${x.count===1?'':'s'}${x.unknown?` · ${x.unknown} IDK`:''}</div>`:''}</div>`}
  html+='</div>';$('scheduleContent').innerHTML=html;
}


async function cloudRequest(path,{method='GET',body=null,timeout=18000,keyOverride=syncKey}={}){
  if(!endpointConfigured()) throw new Error('Cloud API is not configured');
  if(!keyOverride) throw new Error('Private sync key is missing');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const base=API.replace(/\/+$/,'');
    const opts={method,mode:'cors',cache:'no-store',redirect:'follow',signal:controller.signal,headers:{'Authorization':'Bearer '+keyOverride,'Accept':'application/json'}};
    if(body!==null){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body)}
    const resp=await fetch(base+path,opts);
    let data=null;
    try{data=await resp.json()}catch(e){throw new Error('Cloud API returned an unreadable response (HTTP '+resp.status+')')}
    if(resp.status===401||data?.error==='UNAUTHORIZED') throw new Error('Private sync key was rejected');
    if(!resp.ok) throw new Error(data?.error||('Cloud API request failed (HTTP '+resp.status+')'));
    return data;
  }catch(err){
    if(err?.name==='AbortError') throw new Error('Cloud request timed out');
    if(err instanceof TypeError) throw new Error('Cloud API could not be reached');
    throw err;
  }finally{clearTimeout(timer)}
}
async function bootstrapRemote(keyOverride=syncKey){
  if(!endpointConfigured()||!keyOverride||!navigator.onLine) return false;
  const data=await cloudRequest('/bootstrap',{keyOverride,timeout:30000});
  if(!data?.ok){
    if(data?.error==='UNAUTHORIZED') throw new Error('Private sync key was rejected');
    throw new Error(data?.error?('Bootstrap failed: '+data.error):'Bootstrap failed');
  }
  baseline={...defaultBaseline(),...data,syncAt:Date.now()};delete baseline.ok;delete baseline.serverTime;
  bootstrapReady=true;cloudError='';
  await metaSet('baseline',baseline);
  if(pending().length===0){
    if(data.state?.session) localState={active:{sessionId:data.state.session,casino:data.state.casino,playerName:data.state.playerName,initial:Number(data.state.initial)||0,reloads:Number(data.state.reloads)||0,totalDeployed:Number(data.state.totalDeployed)||0},lastReload:data.lastReload||null};
    else localState=defaultState();
    await saveState();
  }
  populateCasinos();render();return true;
}
async function syncNow(manual=false){
  if(syncRunning) return;
  if(!endpointConfigured()){if(manual)setStatus('Set the Cloudflare Worker URL in config.js first.');return}
  if(!syncKey){if(manual)setStatus('Save the private sync key on this device first.');render();return}
  if(!navigator.onLine){if(manual)setStatus('Offline. Entries are safe locally and will sync when service returns.');render();return}
  syncRunning=true;
  try{
    await refreshEvents();
    let unsynced=pending();
    while(unsynced.length){
      const batch=unsynced.slice(0,20);
      const result=await cloudRequest('/sync',{method:'POST',body:{action:'sync',events:batch},timeout:45000});
      const acked=Array.isArray(result?.acked)?result.acked:[];
      if(acked.length) await markSynced(acked);
      if(Array.isArray(result?.errors)&&result.errors.length){
        const first=result.errors[0];
        throw new Error('Server rejected an entry'+(first?.error?': '+first.error:''));
      }
      if(!acked.length) throw new Error('Cloud API did not acknowledge the pending entries');
      unsynced=pending();
    }
    await bootstrapRemote();
    await deleteSynced();
    render();
    if(manual)setStatus(pending().length?'Some entries are still awaiting backup.':'Google backup is current and ledger data is loaded.');
  }catch(err){
    cloudError=err.message||'Cloud sync failed';
    if(manual)setStatus('Sync failed; local data is intact: '+cloudError);
    else setStatus(cloudError==='Private sync key was rejected'?'Private sync key rejected. Open More → Sync Security and enter the correct key.':'Cloud sync unavailable; local entries remain safe. '+cloudError);
  }finally{syncRunning=false;render()}
}

async function init(){
  if('serviceWorker'in navigator){try{const reg=await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});await reg.update();navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!sessionStorage.getItem('ap-sw-reloaded')){sessionStorage.setItem('ap-sw-reloaded','1');location.reload()}})}catch(e){}}db=await openDB();deviceId=await metaGet('deviceId');if(!deviceId){deviceId=uuid();await metaSet('deviceId',deviceId)}syncKey=await metaGet('syncKey')||'';baseline=await metaGet('baseline')||defaultBaseline();bootstrapReady=!!baseline.syncAt;localState=await metaGet('localState')||defaultState();await refreshEvents();populateCasinos();setEntryView('session');showPage('home');render();
  if(configured()&&navigator.onLine)await syncNow(false);else if(!endpointConfigured())setStatus('Local mode ready. Configure the Cloudflare Worker URL.');else if(!syncKey)setStatus('Ledger data unavailable — enter and verify the private sync key in More.');else if(!bootstrapReady)setStatus('Ledger data unavailable — sync required.');window.addEventListener('online',()=>syncNow(false));window.addEventListener('offline',render);document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncNow(false)});setInterval(()=>{if(!document.hidden)syncNow(false)},20000)
}
init().catch(e=>setStatus('Startup error: '+e.message));
