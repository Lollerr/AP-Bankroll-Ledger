'use strict';
const APP_VERSION='8.3.1';
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
  if(raw.length!==64){
    setStatus(`Private sync key must be exactly 64 characters. This entry has ${raw.length}.`);
    return;
  }
  if(!/^[0-9a-f]{64}$/i.test(raw)){
    setStatus('Private sync key contains invalid characters. Use only 0-9 and A-F, with no spaces, quotes, hyphens, or punctuation.');
    return;
  }
  if(!endpointConfigured()){setStatus('Cloud endpoint is not configured.');return}
  if(!navigator.onLine){setStatus('Connect to the internet before saving or changing the private sync key so it can be verified.');return}
  if(syncRunning){setStatus('A sync is already in progress. Try again in a moment.');return}
  syncRunning=true;cloudError='';setStatus('Verifying private sync key…');render();
  const previousKey=syncKey;
  try{
    await verifySyncKeyRemote(raw);
    syncKey=raw;await metaSet('syncKey',syncKey);$('syncKeyInput').value='';
    setStatus('Private sync key verified. Loading Google ledger data…');render();
    try{
      await bootstrapRemote(raw);
      setStatus('Private sync key verified and saved on this device. Google ledger data loaded successfully.');
    }catch(loadErr){
      cloudError=loadErr.message||'Initial ledger load failed';
      setStatus('Private sync key verified and saved. Initial ledger load failed: '+cloudError+'. Use SYNC to retry.');
    }
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
// Regal Riches calculator. Reproduces Copy of Slots NEW -> Buffalo Diamond:
// Purple*0.8758 + Green*0.617 + Gold*0.4379.
function regalValue(id){
  const el=$(id);if(!el)return {valid:false,value:0};
  const raw=el.value.trim().replace(/,/g,'');
  const value=Number(raw);
  return {valid:raw!==''&&Number.isFinite(value)&&value>=0,value};
}
function regalEv(purple,green,gold){return purple*0.8758+green*0.617+gold*0.4379}
function renderRegalCalculator(){
  const purple=regalValue('regalPurple'),green=regalValue('regalGreen'),gold=regalValue('regalGold');
  const out=$('regalEv');if(!out)return;
  if(!(purple.valid&&green.valid&&gold.valid)){out.textContent='—';out.className='hero';return}
  const ev=regalEv(purple.value,green.value,gold.value);
  out.textContent=(ev>0?'+':'')+ev.toFixed(2);
  out.className='hero '+(ev>0?'good':ev<0?'bad':'');
}
const SUP_MODEL={"ev":{"ev_mega":{"intercept":-171.60169726070012,"coef":[25.08604777370474,14.907344587727403,-12.045896956318229,9.582918158679995,6.161829532689966,4.254954320796444,-3.442492553463214,2.731769310743957,3.8856891548551165,4.124891982146725,-2.9979788849730302,2.009200413981177,2.74942726039017,0.6281954204556669,-1.0112790819194157,0.4449547074726979,1.521678320934825,-0.71230431677436,0.0076473126778273314,0.8211224024078649,14.907344587727618,6.778367246026458,15.947109564493807,10.06206406654808,8.752887107401534,5.06672934240445,17.072269986726912,-2.7887579400907705,8.101742434817758,4.10421072654871,18.10180561479775,1.67482831720513,9.234417552288132,4.244929552973115,17.634314872083355,0.09086086142394591,5.241480941849753,1.625562257062137,19.667094196128847,1.7726993997422948,1.5060939309834336,11.620603033272456,-14.520880503827858,3.60587557194392,3.5665412690552247,9.699578963501569,8.87816700134016,5.449130696764387,3.3565936974714434,10.029141775947656,4.015495366736051,5.630701642553893,3.442684646702469,9.795462279704472,1.748519762834744,1.7515203570467885,0.3003150111664812,12.178087758348997,1.6922284259516838,-19.76335139471426,20.59803118498983,2.3776161549452817,0.8677318504856004,-10.864235282881872,-2.7426472622684375,-0.9150612287363235,0.9031852461426743,-10.747549406422022,-0.9764327032140245,-2.0805055410325153,-2.1050070893368256,-8.886446919839265,0.3989018218887238,-0.05913945074889609,-0.7496195497102428,-9.910056702392977,0.9780138871986584,-0.5085447918916212,-6.003062392714734,2.903058761126081,3.0448844460327273,-0.2415966166121376,-0.16066970821843846,2.096039873423638,6.191836481467545,-0.013589456881042976,-3.412704842875328,6.622937085786308,2.5050199898262573,-0.19606104262660262,4.122246922575507,1.0271685795591898,4.399471322491356,-0.1978912273336727,4.254954320796928,2.7259288957334684,3.1850286757342157,2.868357776302595,4.428127861237945,2.76413172819346,3.2998083778480845,-4.45774549393027,0.16912521091264565,-0.32136323128242994,5.392354353156787,0.09185508460086973,1.137860535465635,-0.3229143373780859,5.279392171985089,1.1139535013763209,1.4344951202329281,2.598361353196606,-3.150053867546319,4.129951708171435,2.890858424456399,1.4717601910176317,5.901834648989455,-0.4031246112745479,-0.37191928679140773,3.8820380653459448,0.6395130760061652,0.3152576289367184,-0.17939100691527612,3.702509856330892,-1.6967242337171726,-5.143509346844683,5.447176589479589,0.2773336393953006,1.4906206018613917,-4.003335309498928,-0.7264254100133876,2.6156933570935723,0.7971697783580938,-3.9727843269263694,0.13238723707240113,0.9419164789328636,-0.5233329471110334,-2.9287874309179287,1.0014460576759086,-0.33221703574451034,3.30794768449302,-1.8160391708089634,4.305129140783851,-0.02936432496927826,0.9618726310536987,1.6969442196020055,0.8972559505090143,-0.07065846406585646,1.3145917000732317,0.8126129163318834,1.3566167826284043,0.2332716620616818,4.124891982145894,3.3577997977562286,0.8774670137244251,2.1096604346797334,0.5528143282990736,-0.1257182036593851,3.2101245749039746,0.10591463386349725,0.5105524348829517,0.28958275964239955,2.9661002582371054,0.1705248884132234,2.1507080523192603,1.9591486187358886,-1.6705456984172868,0.40721443184387646,0.01437438619173202,3.3676539401754435,0.8467850026950812,0.7376630445559487,0.41884466746414273,3.096782717830107,0.5931275020874102,-4.010767900313304,4.207895601292887,2.0487951298511673,0.5298525598798246,-3.3086706704172273,0.1564169467663683,0.8666412858897236,-0.8977302943835175,-2.254546468411123,0.389953945323348,-0.1002678633704143,0.2827680854323435,1.5666869686672378,0.20392234591115838,-0.0920541328990059,-0.34109944805276626,0.9405443182430816,0.47011492794159526,-0.016942966909953578,0.628195420456604,0.3894290169454885,2.05058545777655,0.46720244278510514,1.3434748405041848,-0.29365468534127076,2.3957155932299243,-0.689466921822532,0.28901515135460015,0.3706806457602105,-2.258864695430158,0.44505283062751194,-0.33226171909692626,0.7056855312899811,0.7748707607444787,-1.6368501703988374,1.9465513044753908,0.7943909290469415,-0.4246963418612268,-0.9210405076310691,-0.6423920412073223,0.03191366565267285,0.827509598272547,-0.49798963317738865,0.6767333027274343,-0.00474736014070689,-0.7123043167708845,-0.9030912721828247,1.88351907035415,0.8621785225455164,-0.6108610690740776,-0.17049432084513563,-0.6163908722267017,-0.28563771720065956,0.45212478229027864,-0.16193099173097433]},"ev_grand":{"intercept":-136.67020714578902,"coef":[-3.144647029724634,3.122977553354353,-1.8402264950434954,1.1106490715825486,9.729832439005243,9.281178984824507,-6.173396063535636,1.7831104409944067,5.797233355680622,2.419989750766826,-2.337602764446628,3.0772080438220017,0.8057918317879478,1.5309159307881077,-1.0078374709457578,-0.25153975723754407,1.7389695769636972,2.5952980075160603,-1.7185716351026967,-0.34045925519751924,3.1229775533535373,5.824563956177529,-6.887052670033512,1.1661815252891259,-2.175522379670755,-2.646814856797436,0.15330124284995053,16.561385058209535,-0.18995996758677222,0.3938363332972529,-2.8086055553985205,-5.502232327636628,-2.1652930323560033,-0.9918577136850081,-1.8501688397635758,2.087877247404428,0.3929626490603847,1.6958526715837001,-3.7708602124721957,-2.585913803009492,6.09742586143342,-1.924666414814967,4.369137631240898,-1.167726529584437,-6.0234951044497524,7.965866910808253,-22.127360732690754,2.4910315735133746,2.4415015178029056,0.8946371060744934,7.292834148987267,0.18574829722212216,-0.8084301576343594,3.188540411355118,-1.6251236673190452,3.225298223090119,3.198389724788911,0.2881143772198114,1.2124082921931936,0.2748431995203361,0.2637939055086265,9.35261981539127,12.68152064859329,-11.098928529722546,20.522825709312855,3.172543606938005,0.2331650735016851,-2.250949839219555,-2.7613225943501165,0.7091005450523057,1.9895738699130932,-2.8960617227337404,1.1772259617672436,-0.82707549164431,-0.2220845031386304,-1.2532575788773757,-0.7442089775265845,-1.1490818676384287,14.802551067785734,-6.7933922021583815,16.345168030697145,1.6384153042199887,-0.12727401971496236,-0.6033315326455332,2.5741004002600048,-0.37070421550619087,11.537105706090049,-6.5946663439975035,4.985862856526557,0.22806780547020566,-3.3405991209579557,1.5716806560992866,1.7007229108204183,0.14670327033907124,9.281178984826594,5.420313328543011,4.425251093845831,1.872265963150165,-0.41301485178324054,-0.7167324989621452,8.717431644761888,-1.7313283945186562,3.010708559060253,1.8970993794483932,6.800574169071913,2.3880703599904765,4.481226277869237,3.2469040928958814,5.890520247138375,-0.9583594347848586,1.6476967805206604,6.830103053645158,-7.763953177854932,-1.1539953950059887,0.0191143884460628,7.880719133546546,6.68793501553327,3.9168670987990066,2.345216160471035,6.038046239383253,-1.9256963368142677,4.652792028845252,3.031086208990238,5.554437661587966,5.050280094672926,-9.884988733182219,9.811566961743091,6.361107527592671,2.346036930658575,-7.487538328616659,0.24324240358764046,-1.7211097949541214,-0.1355028132523491,-4.992931895218252,4.2814975249602005,-1.5441731054308863,0.24761135468033402,-5.239287766949974,0.4594218970985706,-0.16922070176518866,-13.402990374911726,10.510089188478014,-5.257043950019457,-0.4969437506725757,-1.3625830098545597,1.1544197363226962,0.33756422870368075,0.490734887268071,0.6491718544350261,0.27735727224815104,1.5815907452091884,-0.4686475395429644,2.4199897507643366,0.7576693558110522,4.218453772732526,3.2310684459746324,2.453784083470609,1.2303093848974342,4.07751845671907,-0.3315848399376657,3.497116915280175,1.433308261839534,3.5465202870462114,0.6636605648452772,0.0061362096998626246,2.0449333880038787,-2.4046114873916378,2.448347681771605,1.6035681422957189,0.9159243797967481,-0.8759910294384744,2.746610214682734,1.6772296875782262,0.5235285323655301,-2.159046011921082,-3.9498538431414483,4.192540694342383,-1.1933687076300425,0.10920785149330493,-2.0019784354047454,0.22045373394354612,-0.6490754837463489,1.0459329617462902,-2.3671166728228887,2.5434144109796093,-0.20129012811148603,-0.6527854152986844,1.3724755730214993,2.737852096266958,0.20341450914601963,-0.11526702574034063,0.4201888896586908,1.257063917773635,0.49726801280558297,1.5309159307889364,1.453419863667469,-0.34452002237561247,-0.2641167451429147,-0.817318856382194,0.30459360997324275,0.571439871524836,2.169233634527409,1.0460749846741912,0.5661152551919961,-1.0831144142106686,-0.355727520573913,0.29423381985193614,1.2371231336350592,-2.706906133533817,-1.2109478256005255,1.3181513901213782,1.7350621275851215,1.8926639405847663,-2.1956650120259544,-0.08457324318398989,-0.21382914350674997,-0.6942567401479313,1.7937550395313797,-0.20869597654547634,-0.001684682083879945,2.595298007513493,2.12817393415193,-0.10938389023931679,-0.3574822179871127,1.4777220438800367,1.1422108736802628,-2.114325905865098,-2.16448229062731,2.3904593763354316,0.07064930723885711]},"ev_major":{"intercept":-124.12472402350679,"coef":[-2.583638105645561,-4.490346241941468,3.0050294820589207,3.5767138126870304,-2.0654065624258084,0.3809462516434266,0.0481418892656149,3.3907612386756516,3.175172942124307,3.651081294872805,-2.269427752758633,-0.38099964121468244,2.362450632446083,-0.21564791486114962,-0.2842090755053629,0.3893414097169219,2.0849225461774923,0.9390188502134713,-0.4802824322456198,-1.6937061482524023,-4.490346241940445,-4.286427406871636,0.7866294122562754,3.7555495033463733,-2.008074132644761,-1.0443288360317964,-1.290335015321213,-3.449367331348357,-1.556710424231383,-0.284243808111293,-1.8525759391814143,14.576129934137024,0.9637482574044215,1.4662589097790124,-3.4174994611252796,3.1557764532666375,3.3609642517598806,3.9520031935860707,-4.831488087664956,2.53145028313901,-3.0341699011447916,-1.7451384658402336,6.5269650841697,-2.015404004855649,-0.8652879014861199,-3.140263500956224,6.279024127310288,-7.618542570662795,-6.790829356963192,1.588121794309325,-14.572595743193332,-0.898483978643422,-0.07868303918221438,-3.7801587600610826,-2.295228093575861,1.5381279644712536,2.555366375367244,-5.362274081485512,-4.89987324345533,3.745409777385689,-4.2984792422431894,-0.5440675319336641,0.7399594364012254,2.2814663598766436,-3.463293573653748,8.500465181711993,8.438310050163524,-3.648860537098988,13.673240296504511,2.7027298733783813,0.009341313172218832,2.1843658025804236,4.108245008505169,0.35373441161658237,-1.375490968131324,3.477520349929155,0.791114231522843,-0.7942341325509892,2.109606541267764,-1.7196395844512393,3.429973641301915,-0.18744528907070848,6.457397602448046,-1.836393780593972,7.27726058399004,-0.15206833144676787,4.856463878580294,-2.766171828201154,3.822229020623812,0.4619213287162208,-4.436762026537184,5.239304829806149,4.031579362884856,0.412041159134041,0.3809462516445973,1.2072919903848895,-2.6430006627409814,3.560299300676184,-2.6827882317103295,-1.809180894968617,-0.4072451639316606,7.547491808498298,2.1368000213776854,1.1115631196584397,-2.9186425849064483,-0.018385949297405918,-0.038283235757251295,1.4341900889985608,-2.6892567254156376,1.6297531921156745,1.3517724480352613,-0.7740533212479019,5.80372082812611,-3.282933047711929,-4.697781319167815,3.752707956400198,-10.12147492717067,2.109041570690068,1.3411638100165184,-0.9394795830865579,1.1353707519063132,-0.05236502915618846,0.5077966784855182,-0.04654858328020135,0.2929967010092943,0.957408900116207,-1.234098962630709,5.230366433162786,6.649461642243025,-4.495153447105817,8.681989055260734,0.6051635436272883,-0.9786857420384734,0.5894196473068432,1.6397377181516477,2.1791174042805315,0.6515822091915804,-0.3052943682672088,1.4922952905081686,-0.8150768977108029,9.193610718003528,-3.6459235642381103,4.62834451666322,0.5527972654176089,0.5156045196982072,-1.3633031799908668,2.6241850868376413,0.1191512619171822,0.3499981278933911,1.7529917681486957,2.124250259942238,-0.054385938936140486,3.651081294872435,2.166235059483847,1.1409999178254357,-0.40004962325555565,4.034323095434381,2.5616481932092126,0.3864919083538015,1.1814596473223549,1.2713134738980116,1.1046135402338904,2.1041680284732713,2.533466027032465,0.7135673562590894,2.6270830052366136,-3.5952250465405933,2.7968483058642746,2.1044598264151384,1.1871410889397245,-0.04687600981625001,1.5697501573147332,1.143934296135889,2.4072429910121076,-3.329714772066107,-3.564366430728076,3.578730116305324,0.21425768927251787,-1.534371255083043,-0.900928917421377,2.6151252825045104,1.1133543345507961,0.27600410577424694,-2.1121963226991567,3.5885782534609802,-0.46144540357351427,-3.936930183055077,-2.250210356475859,-1.802477710590859,0.30491040585176765,-3.177545992743196,2.712714575062234,-0.9250989806031166,0.47920373297320096,-0.21564791485996387,-0.9355725291410228,2.637096134951331,0.4088084800875421,-0.5328549166093628,-0.3087009041814437,2.2378748778213864,1.133038357528549,-0.9741068166678839,0.5659347529522809,-1.933201728291563,-1.8328203502761864,-1.1206501738761303,0.6203729280819472,0.7876910779605142,-1.0498642480600258,1.1487065509056715,3.209335353150579,1.8003138972751858,-1.386101110241589,0.8206196199946939,-0.30083149854087293,0.24172483731624825,-0.03671879284514378,-0.665257356235832,-0.03647897568640987,0.9390188502141398,-0.5956886982259165,2.236383600307498,-1.7783914556036,-1.5129455518381656,1.9486585371612242,-3.952233574667316,-1.6983753388346832,1.5788183517463148,0.016272136279153603]},"ev_minor":{"intercept":-65.02295323416398,"coef":[1.179725056556609,-1.187757013922882,1.0847420486242534,1.3694674223945078,-1.7290523985274928,-3.0933192602186086,1.8122916917406218,0.5694941512351429,-1.4866944200219137,-1.096327365930941,0.8766111583554581,-0.7713952144907299,4.5863091644451845,5.307935323495457,-3.4344521078411727,1.1246790885558693,1.3170888115077672,1.1728181136771088,-0.7710982252419605,0.8804968433622373,-1.1877570139244127,-3.1114518977565795,3.3405001355202217,1.4379407934856032,0.2008569533417134,-0.6601825460730895,1.2801976791656327,3.2833711979122984,-0.2993256222860496,-0.6737481214430134,1.3725135346966297,5.43701914877884,2.426858557898403,1.9729338416719386,-0.3063473848277323,-2.1059456367371396,3.6729129102348677,1.5187043834758525,-0.14955981700930154,-2.211085789846644,-3.8274757278864344,1.8683665012986792,0.3301127766367777,-0.5785391668191268,-0.43258271530479603,-0.7207416382600568,-2.7550741189673777,-2.2268635582590655,-2.0638559930435325,0.5438279432690537,-6.742411452969456,-0.4204188920961998,-0.028021801195349996,-0.8780312374627935,4.855065431061028,3.3829425094364614,1.9371007418168187,-2.454381241052509,3.388076389761592,-0.31116950500189483,-0.5479427102069033,-0.901290281116323,-2.187902136040269,2.162904614196523,2.645496032589329,0.5547245264030771,0.7525264794423232,0.3941673540406393,5.577336628562645,4.417137032131195,4.708354640594578,-2.262081391076794,-0.42238135847104447,-1.3913118028564058,-0.40926498659496685,1.292462219144456,-0.5046131728067669,0.7613095153847369,-0.5444029621599747,2.1656307040923206,-0.8638538315520727,-0.10223442937227235,-4.341240601917199,5.623703773050163,-2.263902250242001,0.47874276035926894,-5.722812735532281,-1.1596624054244298,3.815171423362798,-0.2953961667489669,-4.337019149272619,4.0276708080391055,1.722586774707593,-0.274212060098071,-3.0933192602183337,-2.396077398791121,0.11374382451182857,0.5979688588138127,-0.7741645824363511,-0.7613423013952143,-1.084204247716199,1.0806383054639324,2.421425205141937,1.4605122282230723,-2.373521837976671,1.501032285999334,0.16139982516950221,-0.04693127743576678,-1.492176355735678,-0.6157920445684991,-1.0866425880221746,-1.9287709616662048,2.3569197002694375,-1.461046263697812,-1.133308449394894,-1.896457058412028,-3.7167541273320266,-0.739810894848569,-1.517459686323747,-1.2932476080400088,-0.5335743712651029,-1.7283964920090351,-1.1036420774369433,-1.8149604243829094,1.6969937598148965,2.6733288262944086,-2.5710980597111504,-0.6165634046951639,-0.4316392383756504,2.0411197654306616,-0.9807088217238701,4.103874622902347,5.515857649997607,-2.281793287673787,0.9218992939802418,2.073078873016953,1.6289526755433585,0.4383465133323263,-1.261355716858099,-0.20683549626849895,1.3197963727442634,-1.037262237406306,-0.18425253123226148,0.06481747495768335,4.0934742921956095,-6.976731914338788,7.544351188097898,0.13369305068551326,0.2503598179552703,0.2703371328527282,0.30270995141867096,-0.2763520095827863,-1.0963273659309989,-0.7042624792670377,-0.6920091606579211,-0.8099649752377903,-0.3504488021266162,0.2249873545904984,-0.8933369633559671,3.6307928135996645,-0.882558988647161,-0.8714609087847158,-0.44787684263867705,0.5759007399257042,-0.444343636581997,-0.5850450260607214,0.6362311960431821,-1.4919421495297531,-1.7296069106216934,0.8694232073855223,-3.384029379627924,-1.8293008301548062,-1.7915237273624278,0.5860156217374465,0.5066348004571789,1.2204779516639632,-1.3421233032054423,4.9487913701812145,5.789565374372818,-3.544709424180269,3.8696322698130845,2.3680888608171493,2.279392607712615,-1.0030796111821967,0.22787107728218792,-0.4188909488017085,4.819597971156412,-2.5752790612966385,5.041271779363719,0.24445891603968511,4.893257551678448,-2.021500335787295,1.4060537172522976,-0.10435421602706905,5.307935323498429,3.5371840140095197,1.3637494359893378,1.1809130428904575,1.2760226424834271,1.535367924966121,2.765214292702789,0.9267406534253678,1.5592093182552833,3.4168961982554906,-3.3463504693612953,0.7076663556937502,0.6648703310175292,3.940762751031375,1.133126485873688,-5.106279278817508,5.104159162439185,0.8639653851582778,0.6579001777703274,-3.284734400565971,1.4497644918491277,-0.10121225101177599,-0.08400203280812496,-1.283642335148214,0.9849484581412841,0.08039517776655995,1.1728181136767628,0.5850156767615222,0.6914376635884,0.924521685557783,0.07025938455649869,0.9328296569151308,-0.34634104164159646,-1.2615371653758207,1.2021394639775895,-0.03362748076864323]},"ev_mini":{"intercept":-49.858103653155126,"coef":[2.0564477177587808,-1.3647945776199113,0.6171249073222963,-0.0667666401215884,-0.2921683700331024,-1.873339329930677,0.9794625189330849,0.750215070762838,-0.9150032675435109,-1.617278405494834,1.0451260554093285,-0.1265724901800637,0.5363143538093557,1.847500813480014,-1.0124527529924479,1.5759248447935637,3.1298238991177896,3.4588361424106036,-2.272178311764593,0.9581975643050367,-1.3647945776210062,-2.5704703818504964,3.591793413663585,-0.07010497215321564,-0.18745328075457723,-1.2387342839848128,2.306030960709177,0.917596473438901,1.2479565708384135,0.30412943833072853,1.334021746728637,2.308138760863449,1.8289448787785845,2.1284968389546184,0.5171836905029197,-4.9570274850082106,1.7500013019172478,1.736090065015434,0.5826423173378243,-4.0258321593217765,-2.612449755574654,0.825194646780614,-2.130057938514414,-1.0302636210331795,-1.259921067151556,-0.5294959306658213,0.3745674740345506,-0.10116679681031122,0.09123479571292187,-1.2528860708630032,-2.61517415390907,1.777378156317376,2.494359050044711,-2.7695936811596864,6.548450328450378,-0.2655643086573399,0.7829057451486334,-1.6415744255425722,5.174762493786538,-0.4401113681456658,0.26517078074469375,0.3181593321456111,-0.7446685095002337,0.9969940362694097,-0.8724987252610166,-0.7622392466339378,-1.4402938264790113,1.4861489299194814,2.026011035793548,-1.1491914774925407,-0.540479793129099,1.0388241746950142,-4.610496730921989,2.6699901472889813,2.201608431900388,-0.9309954741623732,-4.04917461466605,1.1118664812857701,2.520423674239454,-3.6608595992946316,-1.0757655965196837,-0.06582018461161691,-7.560375260689492,4.800506079664675,-2.657179307537538,0.2393312314414908,-1.4132475902190864,0.036945465217745,2.7175029144898217,-0.7020794079506314,-3.616841254855708,-0.2663370106065617,1.3240965964571498,-0.5991164514791893,-1.8733393299309296,-1.6545266325655525,0.8892698972322154,0.787725824301551,-1.3348439604427738,-1.3535772529615187,0.7534188410847493,3.034940045141755,0.4192975220740834,0.7042790001231743,-0.6274914975348708,0.04714969381854616,2.5615450413522525,2.342295571474775,-1.8681824801283486,0.2080749561645387,-0.9887760310205597,-0.9063052832963746,1.1192804855413705,-1.6146478961749793,-1.4575127401360632,-0.458864198339124,-3.0774715848297736,0.0775989036147858,0.2353980013542597,-1.6997147977623392,0.13894662717871709,0.305802480816666,0.24765274144266725,-1.6665170308289496,0.6584398919403835,1.2096719068646855,-1.1864974235346757,0.2796366880437218,-0.33654536454262873,0.9250579164815537,1.3979033444903177,0.33519589380254217,1.3708253700039186,0.058486257886437715,1.4918331250146897,2.2501786234155015,2.6983592950173962,-1.01276912087299,1.0514811281740466,0.03807661590541762,2.026994147787164,-0.7098331250349031,0.5761476598813555,0.10707538076790217,0.3367708391441784,0.7456235220504197,0.7621611900412192,0.1202109331424592,-0.09218008907638135,-4.49388904944861,5.103822071065033,0.14207004924570465,-1.6172784054945109,-1.5141377632712456,0.22544220532180093,-0.13290111470829602,0.906582466304329,0.5745021370585588,-1.1241548755002753,1.3618162630301536,1.4222772401341377,1.1033422373142079,-1.2550499133583464,3.373369087860546,-0.9242442134553968,-0.7534680866035652,0.7754570971274227,-0.3608504066545925,-0.794984899876143,-0.7284335361998776,-1.21235528569381,-1.0128744245136554,-1.4846708756703881,0.13311521216228947,-2.8222767601632963,1.3826171398554248,-1.3707894959152476,0.5312390106223892,1.9694638773841482,-0.3107852362681175,0.9087989110783848,3.19386469999251,3.969161143814195,-2.1253816554727756,3.23044652646567,-0.40631832046462596,0.3631561895111457,0.37668053211322905,0.6168652279487582,0.0602057671495131,6.247925957590184,-5.283612026334929,6.1878507104758045,0.3036820915754074,1.8475008134803885,1.4807456123586837,-0.646332046001309,1.6547210870561093,-0.482651057399197,-0.974656446864144,1.5730678475704583,0.9980215544230062,0.9110204209280504,0.8603963507448651,1.201142787570593,-0.41786262742293473,-1.6671956922293345,3.113962647015746,-0.1611295147848533,-1.1776995309866924,1.0602788669835193,3.2276329117723845,4.364553785547356,-4.126780726865172,3.786558840520365,-0.13312623361205708,0.8849136168740188,2.5623041869098735,1.5362061574685362,0.012349264808266616,3.458836142409422,2.331626347248215,1.0265763920063748,1.0061074425841774,0.9905179618089068,2.269786324131042,-2.07341108443469,-3.439041870195448,3.3899538618618936,-0.07733440669257492]},"ev_mega_grand":{"intercept":-181.74805319800726,"coef":[25.738232316431723,18.49580292574323,-14.174481615372025,7.612814627950847,11.070173280855176,6.229074790782077,-5.23843842013811,3.011297852932333,5.034520299532427,4.221754714053121,-3.135677154046444,1.2625503827131899,3.011287441400953,0.6149049985848368,-0.9851427842075839,-0.3575789819224544,1.673806110960437,0.22794389439046603,-0.43608753051393867,-0.44606367926044865,18.495802925742606,10.576179102640204,13.89952925922824,7.99345535924655,12.446528685930037,5.105652331608655,17.580747901489204,-1.9456230774606813,7.4914898622647765,3.2269411015742278,19.437864608269997,-0.02078659816275952,7.236867009731429,3.2353409291292956,19.105478746709558,1.7431070082587043,8.012799246087788,3.8711434855447795,18.58024808728,1.1721599284390438,4.230103177899604,12.731710653471133,-17.34510418910327,11.016088733633973,5.655714816677489,11.08826001628317,4.192293900629828,5.754042305153519,2.9149203887413138,13.494842452158775,5.067688418204093,4.939125060590444,2.5215538160705626,13.607650229452,0.6603976646656485,5.173496792741207,2.659137307438783,13.44120341765599,2.1989438773651395,-22.048794441791426,23.138473713721737,0.9852295591085635,0.9631043673529772,-12.96703523086995,0.37058461466628856,0.23882423142977086,1.645522802015979,-13.269707082721867,0.3631780168276019,-1.0372831551355661,-1.2286340886861125,-11.417132246134095,2.1520257686724547,-2.329958179370243,-1.6791444859290734,-10.815912152899907,0.6076715806521658,-0.27691008800912337,-0.5129594133033226,9.851216418861416,1.3443125457197553,-0.3124634726957354,2.04101046476845,3.6547129335294675,4.815110854835025,-0.4282185227896533,-1.1537582988191528,4.282711010523658,2.6075131109848386,0.016294779429093263,-0.9416283340870956,4.156947642654372,2.882521685646575,-0.3237106309254025,6.229074790784226,3.0182497871199545,7.102121691430229,3.161862745592969,4.673961634753025,3.631042377450978,6.75858943367322,-0.7932854385428023,1.9575876684576627,0.8922902934349402,8.529069491696673,1.6330423364993276,4.0257395666681735,2.235850357269233,7.610678439297201,2.5863297296715504,0.8084642840351255,4.794508925869915,-7.750217397966914,2.8025376103527133,2.6081160764740763,3.385144527700206,2.27695790454806,1.289351328908766,0.9201424383876785,4.483426563988718,-1.080397895946784,1.8110090656174034,1.0593936694776533,4.5019714524831995,-2.5509177403462626,-8.62134032552587,9.112603749724858,2.0319410091554984,1.495209449046494,-5.592509896045733,-0.6242258666133705,1.7801478218223536,0.02409597948361236,-4.833438304797513,2.1068576258453633,-0.14074808797649466,-0.7255262016877424,-4.13420307469133,1.6663380967812698,-0.0646608691976432,-1.2866373899535188,2.6407120871146113,1.3750652935106549,-0.10787470595555418,-0.11392250938881648,2.201674267631263,0.48580269733686227,0.17262681051404283,0.3971141353573502,1.1345382866184106,2.003744538341781,0.2618569684456338,4.2217547140523095,2.8900159990561076,2.2351566762333053,1.3256779018374596,0.51878169502325,0.17759215441341125,4.099423060744739,0.005231149631770518,1.9708423913399749,0.9594053679481824,3.4012313513133066,2.236606210455661,1.4006968429742706,2.663184879774431,-3.642558502589433,0.9297291394220408,0.6248984396172136,3.0886247768576918,0.5742930206803704,1.8127625546097588,0.847975369080421,2.8043676980724763,-3.0988299566563042,-4.753457280510172,4.903707028610465,2.048116413775964,0.1912125049163423,-3.2449474372030633,0.4020377755851389,0.18589038667978272,-0.37930454036959993,-2.5030141362105742,2.266825987702766,0.0035878888109698547,0.5395988433534803,0.5591570184699566,0.4808823043575624,0.0002560099494264258,0.08353297047432404,-0.31769016802517475,0.4684830266434976,0.45414293403478034,0.6149049985839306,0.17128478845052414,2.4638365429677758,-0.37545793112766374,1.9214320788129633,0.7362463249542707,1.932258492933702,0.2197180893723462,-0.06092581390568855,0.6510678211016437,-3.405518269001465,0.686255762158821,0.17782554816784668,0.401500264497136,-1.0058785249490567,-1.8345971082979244,2.128770867454465,0.649512965400303,-0.1007092513709041,-0.9838560730913437,-0.9157256258452718,-0.03144144690755531,0.7465205086053748,-0.5358870971923346,0.3541261944486263,0.031806075158590665,0.22794389439215063,-0.1825796300765202,1.540819516191041,-0.46836686319978466,-0.29175392600440675,0.44759615539098446,-2.1655913173693686,-0.9534915928951316,1.113252107080874,-0.05621836294707149]},"ev_grand_major":{"intercept":-156.48854385612447,"coef":[-3.398691240195127,-0.05137624344311687,-0.438479186717534,3.5192710139408296,10.565278532737656,7.747261618937413,-5.4136431681044845,3.022452720512777,5.741654956441382,2.264189390895214,-2.081347282648958,2.2317362549215267,1.3900017620736793,0.8988420088302062,-0.7262838209732472,0.22069221860526345,1.1973975767629486,2.616103520508374,-1.5194510403249963,-0.43155090798676443,-0.05137624344519821,3.3815024563903373,-5.565220011276954,3.6952345647527256,-4.76619390060346,-5.072622464366134,1.5444247069162993,8.03675061550378,-3.139555730199247,-3.278102861236135,-0.46860631000083736,1.1573400846664341,-1.7005301018710302,-0.8959203295231188,-2.2793976270054115,-0.08927076930326792,-1.7163152570215856,0.5737394665575755,-2.820276671834228,-3.808134491165948,5.2079947182115465,-4.118959165035155,7.278687533143333,-3.4603372827626067,-6.165694917742689,5.090628203696065,-14.20606841860119,-3.6901336663364095,-4.07450972677883,2.990638232653783,-1.7404490795473617,-0.682085723935269,-0.9830835283365984,0.550740082257628,1.236605782042301,0.8473021451428778,2.2826120702866732,-1.4328688275255461,1.1528946389338703,2.4408351057240893,-1.5966478621717455,11.039579085477266,10.85735037216605,-8.580167523962029,9.263614054878797,7.414514427394666,4.951158289363455,-4.377943710520204,2.1527971525102236,1.5675099612651584,1.498767243384656,-1.4179509518167852,-1.235813613982056,0.09700660181484154,0.19988522458664185,-0.39577737756379777,-4.391737491071819,-1.7529846059216192,9.631910232071135,-2.8804442900034624,11.627906880732,1.2915603698911853,10.189636358327414,-7.1243474303078,7.433211045598283,0.28892870063428017,11.574972650470443,-5.145749647729787,5.017445608799597,-0.17287025952250543,-2.9168745688882813,3.2866649784405273,3.901741366215864,-0.07185985220047825,7.747261618940893,3.3079854853076816,6.5284089074610945,3.1735753566223943,-0.6979470689488382,-2.5330042234829118,10.642148038857176,-0.11307905398801163,4.437761026859866,1.7504484159994824,7.475238596752744,1.5474456184591425,4.430896671480863,3.016713782844603,6.867716188615428,1.0229667852352646,-0.07272574608640507,6.697728333849856,-7.233024408342289,-0.5464852312350762,-1.6156835998236545,7.569904217049943,3.4524905249045568,3.5653518036122405,1.6576745675340487,5.226199343677077,-0.733634160859695,3.200848481705263,2.0204299117062927,5.144710900267674,3.285403436435929,-9.363112896272224,9.268940292195795,5.680285784294927,3.4232960531067085,-7.34073531229526,1.2303431835870184,-1.1980609416683046,-0.22709402286875222,-4.409407493693177,3.3338547390708984,-0.9748590944701945,1.0547132271627462,-5.126407298179763,2.2633757151075726,-0.49058617319101455,2.1700415155656247,4.210164725766473,-1.6904353065100004,-0.18943753875493533,0.07962133323473401,1.1884270348204489,1.821830016314145,0.30169442850666633,0.8384975415846805,2.387560491973083,2.2282625268245577,-0.36426008911025154,2.264189390895101,0.12275396138233823,4.566699913912644,2.343323067670402,3.839848632062438,2.484250815331012,2.973562546358859,0.3023050156736086,1.1001949984699853,0.4578389776861276,4.5172542939215425,1.6842184463636325,-0.6805737552098384,2.3909454607009817,-3.281165735379361,2.766525226186916,2.2020930205207496,0.26609561767555306,-0.3307038891982981,0.9537028450712843,0.715126797222473,1.3246346741731503,-2.276630465666323,-3.836893808723504,4.0545163763176895,-0.8676212098782278,-0.8224252925425204,-1.1975104974294397,1.2518709065147349,0.5407303637649212,1.9549935988438611,-2.836103587373861,3.338821025062419,-0.28742336392255863,-1.7250471526736182,0.7851533329893875,1.4863694631260898,0.1639460414946985,-0.13477048220477117,1.7092191613190169,0.5998972027636581,0.41426439465872894,0.8988420088309343,0.4776587549418087,0.7908269418288595,0.2317268295014256,0.878777891306334,0.9833310785251326,0.5479444745678733,0.9122909962934526,0.2346247424991071,0.6006172151332424,-1.1466885911322213,-0.1024959545158646,0.018258004004389445,0.9045055982310966,-0.6168688387980457,-1.1216492997296452,1.2246266028055017,1.1095179395984174,2.1915489692096464,-2.0065171949841787,0.0686434487680662,-0.15471394709650177,0.4115334324990264,0.7852936045531781,0.7289263847370958,0.0035197084354628137,2.6161035205039966,2.0571699768140226,-0.46019549837616225,-0.4531284533454004,1.1907205902560518,1.3723705511227855,-1.6731824528175328,-1.9939761190851795,2.0357993348210783,0.07601179462891354]},"ev_major_minor":{"intercept":-136.8777076109008,"coef":[-2.796698476304606,-5.836802902907246,4.3064956750412025,4.437706861488212,-3.2291738466415696,-2.034818311485106,1.3868082957200598,3.5994131453786062,2.967416971159271,3.59830344846247,-1.9633350950240194,-2.288411168815038,3.460507134633937,0.9804897512406348,-0.969112740696559,1.0233209580750209,1.854742058166409,1.6060625717377428,-0.6996440426976327,-0.34918816536461517,-5.836802902906474,-6.897495477908137,2.5769822244254303,4.659592204610885,-1.4376650575394443,-1.1689786942062543,-1.6817648467137678,-1.8281419472616387,0.30263246958866835,0.5302433156543721,-2.703012068238439,16.245582681027177,0.32720784884035103,1.007928790000732,-3.2170449288056555,2.931583010351941,3.6684130513380016,3.525121092757341,-4.601530154197546,2.8024966259484865,-6.067170731794093,-0.6067528048248232,7.689270291154192,-2.0982683075667654,-0.8473756895160857,-4.456229728620674,4.2224028402024985,-7.9418611512795385,-7.892026206506056,1.2855139675602683,-19.31866552357265,-3.6160643067349754,-2.0357784487639417,-3.4111563827819587,-0.16276561853124918,1.024176711916835,1.434043452018663,-5.584343352200498,-2.8736516496845423,4.249151635331615,-5.577853526088734,-1.4414768992861746,-1.288717575286161,4.641978239194486,-1.8074399865512216,8.628991643393798,9.31767641831756,-2.994591444509879,16.992600037680308,5.876553864413964,2.6392167458356734,1.451033017827762,4.5021927166227895,0.6016358720170031,0.07310269077628187,3.6586731838722684,1.3103320052436511,-1.0050275343257309,2.725782693401729,-1.5169355006388674,2.5602426609462055,-0.22629630339322393,7.313981129234349,-4.459555519406586,9.893015097144552,1.5397101653941794,2.046325241886201,-1.8607178432731464,3.6932522052887564,0.2423141637345883,-4.430797158671627,6.322111428314555,5.365337965039081,0.17698358042565146,-2.0348183114841425,-0.6266233030636094,-2.446661065692895,3.7793838027149507,-2.8678958344071326,-1.2116761024706475,-1.799913823370843,7.0454215930503645,2.2284575191097646,1.2703792142821624,-3.896120807710996,-1.93517764198366,-0.33447439110803506,1.3652321669720582,-3.575697221031142,1.130056163376666,0.6333829582015817,-2.3690886359307517,7.19752683950345,-4.221776728817265,-4.7161047358266845,1.767343425922239,-11.554849800146227,0.052423366058499364,-0.17668025678360053,-1.7064678700791376,4.532152798354792,-1.6642363729297838,-0.7191813519608523,-1.140322181225258,1.5392902375665114,2.979276790458058,-3.0852715685268315,5.302105461240464,6.223268530677204,-2.8245030189672296,5.644753409306124,2.639553575216815,0.8766917408560883,0.4204104720808092,-1.8612797790165634,2.761546160012258,1.7728368941846726,0.22181017653862223,-1.0530456929201635,-1.077308461424872,8.937080021420766,-4.294900623227238,5.2503231181363645,0.7918203636323531,1.967591335742054,-3.10275486071576,5.111288154571015,-0.4479780364845355,1.7512842581169816,1.4907206318044244,2.6645218161004935,-0.42612274977095566,3.598303448462503,1.6342508429201739,1.4376722780238453,-2.4028317272420034,3.253297334116555,1.9508237762234073,0.9894821961177568,2.7599998763466016,-0.32594526511315874,-0.8248137327408105,3.6094006468616056,-0.8242339385563783,-0.21116243047734484,3.3133783481765806,-5.490390284800698,2.3846696801730403,1.2120667950474207,2.1002903854923756,-1.1731399513665888,0.014727249943095488,-0.8738784915387064,4.044313659505899,2.638699963717826,-3.6271225488485053,3.4801388309166548,1.5167555595362752,0.18506673887006095,-1.9942582711979016,4.344037149041455,2.0210716607232357,2.2928696092472247,-3.2593678045394223,-0.6603204374298317,-0.49621646596974955,0.2514106495555612,-1.4736691527118717,-1.270665702250844,0.2703620688042627,1.8126126245031176,-0.02837736247471153,0.7919277711525174,-0.3084848251584977,0.9804897512406365,-0.401454821781507,3.201636251911402,1.074487005893002,-1.3261141191903423,-0.7749201635630388,3.5461576953242977,2.385301479261385,-1.0587924971871514,1.6350861022889718,-2.332295778387851,-2.2398828231263193,-1.5157819572367734,1.8605193378283151,0.1846619947677983,-2.257838930349263,2.228157890160771,3.4421714633813467,2.68438714475722,-2.337576660556106,1.4466900408088805,-0.2287137858857142,-0.5224035204757586,0.36431793422826686,-1.5549744759453528,-0.036477579925660815,1.6060625717373018,-0.10061923418882233,1.701121953077274,-0.36664757365689765,-1.3539293279044478,2.3641266482950156,-2.2397220105340025,-1.9424347663131296,1.5974796662767863,0.059154078890572864]},"ev_minor_mini":{"intercept":-85.48843010581116,"coef":[1.3502867362483923,-2.3396843786335073,1.869530804270296,2.4969161168398335,-2.449088819279294,-4.074619344185256,2.349005195282605,1.1837104357073012,-1.7466410289486962,-0.9107133855952314,0.7373997927828649,-1.080164311529896,4.749525036564501,5.239985942713994,-3.2658049104065885,1.2051879786425228,3.0416098106720075,2.6550830315757863,-1.7466287483732712,0.6219926769562842,-2.3396843786356305,-4.817743192672129,4.722629606400883,2.6217619226609226,-0.18145658044431476,-0.863981209864734,1.385983885037426,4.1010608132731265,1.060602559093453,0.7655579571581226,0.4031225923722391,6.703801823664776,3.51989128466047,2.7288583664339043,-0.6401270901339715,-2.9089800861922925,4.180380060830611,2.477110969297834,-0.657512625848888,-2.116575533985285,-5.484979022497456,2.1304558846741193,1.4025632825893986,-1.6354576115782489,-1.0724998868061568,-1.3769032381914357,-2.9013570284881682,-1.9031578530072186,-1.2982971912711714,-0.9604145583967386,-8.161940822433143,0.7313039478521538,1.0047049059014108,-2.5686273293757655,5.669364617188238,2.6157064020253595,2.0888472318962954,-3.4738824177591203,3.0147718675173696,0.10622105303585005,-1.3128591518111445,-0.8320717122254584,-2.6251591015978435,3.1274484398441973,2.8353067292881633,0.06797194702740872,0.3057028629778672,1.3553692224739358,6.850053578879238,3.6385481864605924,3.827722925435209,-0.8893264729222634,-1.0396260749409523,0.6914242840916373,0.7509097418123188,1.1444114959608114,-0.25343359714423985,0.729693612235015,1.115694082902738,0.46701591458743785,-0.9454826137684579,-0.11870880388846017,-9.124185836572785,8.394420961938126,-2.4067343892517084,0.7097548689894789,-5.805792538839356,-1.263490734536537,5.778746065684144,-0.32814249277396046,-7.4733145829377134,4.784281739133801,2.3388719940281253,-0.17988120951751516,-4.074619344185117,-2.8676353650843245,-0.14543783821435743,1.2428959575266227,-1.359597193610373,-0.8934430692981724,-1.5418205581485869,2.8856863973142515,2.570932993748836,1.2482521783406493,-2.848127411867617,0.8728155121558018,0.4021866961229359,0.3949376323154766,-2.2859312115790322,0.20551539009089678,-1.1468560173611277,-2.7315069573862334,3.754129574689882,-1.9786397364678654,-1.4556688812491037,-2.430500699984977,-5.163937013108984,-0.42349608753921997,-1.3390259088017586,-2.3218905256477393,-0.018462400784415727,-2.1115989024804884,-1.437532428728589,-2.2586606500980015,0.30818702471850684,3.5752234386741586,-3.4781913904392434,-0.4708930995183325,-0.0371704642287083,2.156194589023462,-0.18313376596921596,3.9685554108332464,5.323859653730895,-1.5363540931807822,0.5822505255623647,3.7880155011602525,3.150071519222738,-0.2466974013950235,-0.10237378133956508,-0.48651074890154766,1.2758114648228542,-0.5631617015153204,0.12482606966188864,0.09192368551029292,4.355611849905175,-6.353869881433779,7.384367802702445,0.08685385299529998,1.169547249509811,-1.8623568221188034,3.3893808895153508,0.013051290045618977,-0.9107133855963865,-0.2598845240546669,-1.2644463976606832,-1.1341725271344933,0.19933680879787372,0.5640102706394275,-1.4213557425230172,4.781916952890558,-0.7561399278342462,-0.7822630298257999,-0.5051070932197054,1.179390711337492,0.11884699546728536,-0.8634063057729314,0.5557598754656765,-1.0459520339692714,-1.569963495106132,0.8223876990701389,-5.086468227986599,-2.675538267176723,-2.7322482013983698,1.68383761229825,0.497992034679185,1.31973991743647,-1.3012350950415563,4.718040618700728,5.541890808729225,-3.311282882653302,4.6664536259506875,4.307731954767707,4.148806837578034,-2.5909936868336834,-0.09300289282509604,-0.6222652671058411,3.736527404293024,-1.3772639831336264,3.6732789009121296,0.4305449563937514,7.926552397920277,-4.074735069376168,4.046635724003496,-0.23314116404583943,5.239985942714838,2.999282794998412,1.88321422945821,1.2654473775077995,1.8968482863563982,1.8652725371930325,2.855617930130071,1.4314986645181769,0.8281846150742235,3.8785764749207,-3.4208052901507076,1.3433077568317795,0.9451240547528454,3.8435965122436446,-0.02631032856273892,-5.1861143648401375,5.042182288778854,1.8616963536803348,1.666685583215712,-3.9281325681168013,2.167410296931828,-0.16766051919052294,0.2774946251160204,1.3160768469689845,0.6946257055625539,0.058852154161794235,2.6550830315742058,1.329240734877737,1.6586984424326654,0.6530923108716193,0.11459681409397046,2.208155049515435,-2.355862884293783,-2.9794095773229174,2.896298269279949,0.014881208350626072]}},"ciSingle":{"mega":[2650.8236869363086,1.979391528403461],"grand":[1375.25758806835,1.9622954131906734],"major":[749.3377933964302,1.9655938652486624],"minor":[350.00717171036325,1.9685307442612643],"mini":[274.6355535587941,1.972530099889823]},"ciCombo":{"ci_mega_grand":{"intercept":1876.2146916384927,"coef":[-124.20471571332685,-174.2627271156284,149.55593327471794,-92.11149323846955,-132.91614099676468,-53.03321271530369,40.24173750749198,-143.9592461936409,-3.58096111381585,-7.1557636958567015,-4.096275004364844,-6.308308138834675,-28.982218713161153,19.34712111326377,4.288188904646204,-10.604924413330474,11.833427507212203,6.138969344428472,-11.328890007491566,6.400815686573156,-174.26272711871215,-275.3221345626028,51.90265476014554,-96.71706786390669,70.49829933556506,216.63635803288895,-232.70465156698515,33.3039823441146,6.913253759189287,-23.622543951284097,-93.60259382482425,0.49764542540325113,28.693644769359384,-29.44826936594008,-86.55032584028204,-10.127313692235335,-84.07174402304449,-87.90821329339828,-20.034959096276253,-5.7610276291929265,-199.22993053097179,-22.937561909519605,22.651794420818458,-453.9205870068903,-130.43449025594458,10.344236490210958,257.9229084253568,-88.46192289438864,-41.59229604359972,-105.36652080076468,-26.47973349782716,-78.01657062183867,-41.64162952251332,-115.21915592797961,15.498852635858627,11.912313191402236,26.870930943181992,-142.18185112587148,-45.0567705780565,184.8045114247902,-177.63573454857715,280.78678360467825,115.58012837338815,-10.804164246643095,356.6822529109508,44.99917942525817,14.103401698803522,101.83559140588926,-41.535036579052175,51.91678446181038,60.51825725096939,95.16870723998471,1.9887541099418828,-9.475039164992872,-23.329452862309292,119.56190494865899,-59.50432909776758,-4.544855716197301,99.83072083308495,-4.490341873914353,204.98448372321727,4.923956216001296,36.26753318780452,-21.814369346933177,37.604456366730034,0.903725838917089,34.214166427351344,-50.34319408945002,-29.903651735720285,-0.8517297531311839,10.13577748614174,48.31682410985433,101.8938871813872,0.8720406563024053,-53.033212715192604,19.962251688100405,-120.55793830742371,-151.15720839397937,-57.67446848181218,-0.2886468523256957,-84.07416977121754,-14.001162311251406,56.66813623310394,-18.810063101647284,-65.85875967616951,15.15306862240926,1.6408501257931003,-72.71670241085769,-60.83386785547349,11.764853806783531,45.295472184867165,-77.65090329617156,-25.798927936908846,-3.52124656940032,20.05789805765378,-29.70676054780861,92.27402533394019,-42.304001253657056,-35.705213182193,16.6960614730735,-4.914336496786411,61.18142896196529,10.69129222139167,-50.6194577998372,30.750282869680948,90.60238187424711,-78.83501754054312,18.218613411685077,-0.7770417147746305,1.57912158623759,98.63188376939061,-18.675808591506623,35.58536630620566,-3.029301098900714,39.117759575453945,-6.015526084026848,28.198186669073237,4.45055328801038,70.12371939463917,-0.28614915119168916,2.5975140898648137,21.79968968052444,37.054628825782096,0.18657402975671228,0.2747207877550194,16.598060474595254,17.285455806633767,2.999117332215122,-17.74202185204529,-19.2263289905257,-36.824822790680834,1.6889191106081658,-7.155763696420322,3.3969306305015814,-17.43499721390482,-6.623723572040667,19.175780761171197,-47.46751582241764,25.075141494400704,-4.858207404471755,44.816502154257215,40.600320019583805,-23.768438508547455,-19.425662945559218,32.95072972785925,-37.74556605039909,-3.373948631296901,48.72847318334866,-28.92042068958019,1.885615049872766,-30.328091609446727,-67.1027947951514,-6.160003847257969,10.957708914275548,1.189932158849764,23.22305898682824,-0.22303078629228154,-73.95586555984355,28.246971290633365,2.377954545161385,-47.101320730861545,35.16475020466839,-2.727031766963478,-14.178376713019837,-38.44113444988447,0.2913784871138371,-10.734372384717146,-6.021334827155676,-22.63919862806762,-0.6377074876375421,12.974613054359919,-24.25571509458223,-22.076443682625694,-2.0570949891910115,19.34712111300541,3.237303819747988,-26.341054892057365,-11.135170607361106,-42.64090738503437,-34.332828374832005,0.45556365401666515,9.137420261147101,-17.443741414099705,23.740523358456723,17.290289549966793,31.995235328104016,36.53305769508878,-15.455572329008296,7.459022872528869,4.918411308627714,-11.227010010895274,26.095820678343,4.635958389311551,-3.823845330708444,20.9785265889033,-0.0718953127877154,1.3029322285221099,8.124356002920909,10.316434598520898,0.07795142442072196,6.1389693440459165,10.126875967048182,-5.5143524080210895,6.720856479669859,22.171308392920743,-20.64416088649652,-4.77652819011663,6.421507589825479,12.535132280943426,-0.054340624541704775]},"ci_grand_major":{"intercept":1021.636244925488,"coef":[-2.363325222929573,-15.290269283081866,-0.1265125514216049,-18.508335317274586,-65.86511050468891,-88.49078593128856,63.321118986871966,-10.998616067138823,-64.29272366033017,-20.566195962705724,27.908557291299335,-50.14015001508234,4.737389373240164,0.19051172468312902,-4.7189164451850605,-0.9668470021821963,-7.647011274499649,0.31778279207489424,11.904935939432743,-18.73179849344988,-15.290269283350334,14.529146017883399,-6.537180661825956,-19.433752091184356,46.70140793806731,-0.4871130972996442,2.673517491596757,-6.68077047899651,8.445757020210868,4.330070733559189,-10.550240590382899,-7.32975082961865,-39.522224200862574,10.300194916556945,15.189480645736834,-0.05623547928165879,6.499346988946266,5.1617387452670815,-0.4424369003325777,9.357085533638083,20.7109957653825,-24.395370907591612,-18.042114456981896,-47.198106461449235,-38.024567714094616,26.564739816584925,19.171353293204042,-25.92253011990218,-48.69430858839922,13.091633014808572,-31.15877650098114,-4.9848896251069625,41.27990450752795,-24.493318166087164,-5.589247549707771,24.92584940122306,-2.8393945608081785,-11.17694377797238,41.81181197854742,4.467805284005709,-1.188738449865174,-19.55550337071633,-42.622474594859376,20.70994764620412,5.716863548354752,-41.59600672190505,10.970868386029453,9.702545787274895,-57.41453027253433,8.800558906020825,-29.599373516508106,2.2322409064702016,-2.35505378217369,-8.769654558436637,16.398881012640413,-4.1615616707010705,70.3877601029714,0.10418839217489648,2.7236923316400663,-4.835132410879294,4.2619246542847575,-0.07875634553950131,-4.5926205221601295,-7.873831138418123,-19.85091380586728,-1.1529453567574026,10.75716863847146,15.025966878612033,39.0633643446395,0.6975654767438141,-1.7469289031720738,31.80513685483213,42.84787364523339,1.009682592315912,-88.49078592924815,-90.93724491720205,1.4534141611760931,-11.548546878308953,4.7606291450946445,55.88223594828674,-97.41421425628897,42.735332821280295,-52.28344900013351,-15.390959676840044,-31.634984098899167,-3.9335794288628185,9.568879832093094,-17.418794620789285,-48.5343053872091,-6.112385253802345,-56.87142102492108,-38.864375131359736,53.73913632859633,-140.41192115140527,-79.43540805265873,-19.150096218403753,87.20260911978733,-18.191620089448516,11.019085980538357,-74.47365375771676,-2.0013940781891053,-30.678361617780517,-33.237125655784745,-54.576144955395314,-27.39728519590366,86.56806881931426,-85.86665184988522,63.88165704811496,66.27020606666608,15.99144528958786,180.88177442911044,15.17315102058307,-9.67869086791928,49.69274729433622,-10.165243617351429,7.674913359992254,18.540788756861197,53.40529944466623,-46.561480139220095,-1.6548400790110003,8.040361704888069,-65.43767124872939,-33.35925991230171,2.260045717094227,11.58951981074813,4.623725259658093,26.083088484428522,-0.28645974657127915,2.7709788603580057,4.346522533139684,13.074718969888917,-0.6986967214761144,-20.566195962655435,-15.437399708787856,-41.06390786980616,-52.64715753915371,50.88397068128772,-9.386200595535435,-42.19411198244947,0.12674759441286848,-7.300243200017232,-26.104139208269096,-17.707112640898647,14.843831093618345,-15.961840268179667,-5.099299636502517,9.013208262240676,-11.784265124683964,-32.70887594349328,9.419446946476265,19.106965634522993,16.66062405064504,23.43074670771251,-20.655138371928135,22.511862000107236,37.57524813160405,-45.02745573862435,16.500280864396245,26.664851695062534,-3.1562683441512247,24.64360846962887,0.6492994153711081,2.62248689150479,19.134188902458774,63.048011921784344,-0.9380096638175504,-5.76549371329502,-16.412919039997316,-30.145065543155024,0.041998055681256564,-2.520280377535244,20.36512570818317,31.63046686080235,2.145081846841444,0.19051172476302097,6.542905464064854,-2.7211998252116243,-1.015189371422416,-25.423439378831596,27.089119226966904,-11.292963471166349,-0.04653203124717765,14.601942338315059,-10.73087444777048,-5.803338184484244,-28.664979713196157,8.161710918261724,-6.14266068062318,-6.341166755578436,0.3409263265705415,5.248586493129702,9.094125354499859,-12.412174666658707,15.448268981022082,-7.674191918630982,-0.17986209905590958,0.9907977842190633,0.4684576244465918,3.459411051969831,0.029083497693877036,0.31778279219416217,-25.774599579237126,11.97358630291223,-19.668388421483744,-38.420473037888414,27.970680249556384,-13.004796564757234,0.5036485495625435,-9.329488703937285,-0.7021701928193351]},"ci_major_minor":{"intercept":567.0856994968638,"coef":[5.9250722320503115,0.3894584422465156,-5.35880063536357,-5.745108544003104,3.4774563884899248,2.98132276475603,-3.5930650939282907,2.2178334664852,-18.313957466705926,-54.812852348547196,32.47808685549572,2.743255661890408,-27.225401147755793,-7.620730322110717,9.899122134281452,-22.035842591321323,-4.275167656815676,-1.0239504420387278,-1.4989115971843572,-4.302277424601049,0.3894584423363334,1.5384014782715236,-3.460124095703702,-6.032363977760772,-11.895321904235148,-3.3949813973981104,6.345199951924173,0.8596896264520137,-16.641108153791095,3.142056850313724,7.831174541273905,-0.0017893665157634787,-20.416435016111077,15.60286936059792,0.39390583180843175,-1.0266342214205226,-1.2924042556946669,4.716021907700738,6.818533977934804,2.26528175283163,17.48706727630958,-16.010048990628164,-12.25905440077404,7.617209228731301,18.4492485078621,-13.991853165904956,4.341570414116917,-16.66133663436379,11.947031341014464,-2.719977803596147,-20.807615253210535,-11.737058750609801,16.32011439925693,-4.420866253383708,-4.787909316435843,5.622104111261304,13.289536510277122,-3.276204974257084,5.468499793040125,6.2261270474607,6.3588669349589555,-2.3003396979598985,-9.413331460155518,1.8150330680178042,6.500094784821323,-8.75405259161382,-60.818882876388344,29.38406919703908,-18.27831874725784,-15.766793768106055,-18.72701261463259,7.297360370343928,-5.76978113247792,-2.7088699000106744,-7.230927945092152,-6.107754278752973,15.634638027474692,0.12632098641122053,0.4939321133488333,-12.60234531125142,-10.048294855145139,0.1482601731023516,1.7480735679340462,3.699499651453185,12.025620268675425,0.3971697687400749,2.661537404667701,15.76437294911289,28.676130606139402,0.21868098737390881,-2.0194491350183865,-4.29941023094664,-2.316269339412958,0.6942052688472132,2.981322764070824,-1.2815436135048976,-2.486044990202573,2.3287251348250178,8.55175354686757,-31.968633763466105,17.55392921381865,2.676344583570133,-13.933604599125335,15.305222792325488,-6.185704511121982,-0.3572288609620788,-2.0606631363489485,6.302924309508936,2.986437484272489,-1.0126367189021122,9.924046913981593,-7.206637925818155,-1.0322949931608614,15.823452197562096,-7.410990018355937,0.22728066587271537,3.029808380794168,-24.431840858977598,-2.4099410122118816,5.144589552508865,15.403343018712901,-1.0530172967957678,17.39648617441992,-4.604605356924081,-14.945721931209748,3.809607190592854,3.7793096701910267,-22.924725667652933,-35.30917684654529,22.374422365081465,8.822025231457287,-6.7368580300381415,-4.393792803269642,3.1360126431089896,15.96032709091136,-5.843905734499701,-14.819007939318011,2.0769311302868427,-16.073687716910722,0.11061154260185761,-7.5978612355471,-22.393648832278984,-31.916105079996584,0.10590101475991578,2.7810373864241718,-1.135288641070276,1.0793930585473193,-0.2315356765181715,0.5343945838405617,10.462079226231229,20.104179725931,0.40242149768801083,-54.81285234554329,-59.43485129890751,18.150090970491963,2.880418429976878,14.329835343001308,74.62931669330759,-66.87284860690279,3.630806514873271,32.854498502861,-15.580651731221547,-15.13033875693063,-0.8782452243619219,-30.421007092585597,-29.52868957394229,21.33839684216613,-120.46904053101726,-35.32433222482691,-14.54504382019901,41.06484338294482,-35.721260801173074,-37.21990039520251,-24.742366617757668,22.770530829597096,47.89263399003469,-40.07130343997209,66.24189721159267,21.990853889942613,10.014076774832919,57.67667975326917,19.86196785143346,28.512216944627674,9.072832602604038,21.853212364779864,-0.9979795137919514,19.334198352828075,-28.782909367258334,11.912302183562815,0.9396875739888938,4.887068545225661,-4.663518523633799,-9.993798190348185,-0.6245672326652567,-7.620730322045495,-9.228425433727006,-22.09915091443392,-23.13763467968682,5.586083307671215,-10.008223322942646,-17.216971383000242,-1.0315726573292556,2.877263509849963,-10.910713361449256,2.930884733971957,4.711667279272033,-2.9494243733269956,-3.6263502151179847,-12.388906965866441,22.566263700450794,-17.962552693619347,-2.5788431803891814,4.612098526380282,2.945130605529123,-16.135085205186307,-0.20719693374600642,-1.465472304262032,-10.233570325241548,-13.451337837282727,-0.0770042008756422,-1.0239504416276672,6.597961399804613,-9.10666988044369,-4.517391304848266,12.146934403182296,-9.667329400748722,-0.46809319864614224,3.8566616320274885,-0.6401323443284903,0.21958200625689167]},"ci_minor_mini":{"intercept":316.0785643271662,"coef":[0.988929237335431,0.21292092470525276,1.3053479263105048,0.759309090917133,-1.6299536725153039,2.2536399516717913,0.6398778623728887,-4.293814561071687,-2.0686478081078694,3.7795930856929383,2.232752065077897,0.9522035942309552,-16.75155864583148,-19.468438122416735,10.488031745856814,-4.274301490455634,-24.37646364459339,-17.7499769139991,13.46678211916235,-23.48626976724501,0.2129209246397523,-1.7442387056289672,4.3580122972166135,0.7972745456274013,6.132203878904498,-7.725020026563529,3.919732281523794,-0.03860404389295397,-11.016242000958794,-1.8796636533294149,3.1619651296518643,2.0175474647103853,-11.459357520628798,1.3346464050645792,-1.3176494139608341,1.1257096354584881,-16.394760726885,3.707776762494062,1.3316333991905778,-1.3938907658490027,-7.533360033693845,6.608511080208619,-0.151790963789219,2.115155111453879,-4.565892976262474,2.626937010766451,2.733400417856671,6.615695426764857,-0.8689092734605749,-1.3037679190697458,-3.4289206752989485,-3.374468523211376,3.4606298204737103,-2.905477289603924,2.8484821635488924,-12.814488494579274,4.051228045463983,0.4627054061113875,-5.62332571958937,-3.4762485844017452,-0.3305332868959894,-4.10430366245868,4.4163317686433246,0.5319590692284243,1.0374227371171207,-3.712151100042939,4.657144836908825,3.3691181998361177,-2.57353219271245,-6.053369423440764,-15.28331219743666,9.265060006195593,8.21155315287379,-10.046797142537004,-17.538023904250277,11.711366693043466,-9.333537795237591,-0.14365426432987768,1.6608862354737757,2.1496319068945984,5.825492129598312,0.03167839593322632,-1.1128738660632853,-8.080653473923038,-12.30849393563785,-0.10546123172362366,0.1656701374086239,-3.3428775713662024,-0.7156370722137226,0.3610138248178533,2.1083122256694686,4.519102755912306,9.836549079975738,-0.06716259788421376,2.2536399520644554,-3.1738119361439945,-0.7224573445317826,-4.50850528081075,4.29645654348945,16.40187784400408,-6.041634887941781,-0.9290202934920505,-4.297979912547894,6.719019197081097,-7.302707648383055,-3.75777041672285,-5.84083582960813,2.2826695582021146,0.8984965448774194,-0.7978095340898391,-2.8409370789024653,3.3455412389404273,-3.1039768759521382,-5.087788659127057,-1.8726513808174545,8.088875073347928,4.437407557315337,-16.00008421392632,-9.561259522670014,9.102160553276835,-10.43247505486445,1.9565663884771305,-2.344501771337911,6.2108160791751175,-4.578090562635098,0.7170787220697977,-0.42080820438174316,2.1569031708787136,2.896413185926453,-1.5646961042162728,6.500297284389128,-6.3895372759836455,-14.123996313504522,7.903252109028624,-20.270823379029242,-17.299748892148614,-11.033665533548351,6.66489046863917,-6.3631685318943845,-0.012846418827873123,0.5314024939421373,10.651424633718815,14.205660276717056,0.13902974161392964,1.8027943257251684,-4.8650824624392515,-4.0151677884395935,-0.35285139158923184,-1.1346831844055516,2.383476977096008,3.844577098767901,0.019120415686975038,3.7795930857892444,-3.9521951221090625,2.8338621948612093,0.9998137653298562,-9.194627233108566,6.317527956944241,-6.280418985606831,-2.131639833750479,5.957618733107589,0.048651134808015646,-4.3986905792529285,3.0671825750071964,-12.23212878181769,12.940165496080219,3.1184522713113454,-10.503980621830644,0.003570245110308809,4.17469682102366,-18.553433213283984,-4.075866639501849,-13.121816636420919,10.797586171648762,18.398885303468003,-3.989959846604703,-1.7441035684125374,-7.396362864053481,-18.90552356913609,12.054598010124339,-25.187477405310705,-12.311764243477354,-0.9876795224059728,4.111844146873731,30.415128363837816,-0.10957467350248103,1.5698174144323351,-3.641407426721723,0.47786294327565776,0.012271629257827757,-1.4909524429808683,-4.57440467410554,-8.2889277362676,0.44901585753878903,-19.468438123181166,-14.588092668606336,-10.22385162492106,-4.488016537108643,-7.524658780944517,25.898062951516145,-32.228676239252295,12.71184419657058,6.192704072163625,-23.46085300633044,12.039141295484843,-47.83775674848844,-75.49212690718085,40.02043503284386,30.556820091890092,25.776252007008047,-17.694483492615667,21.661103922617748,48.053018866897254,-28.077561269935675,48.65263915566367,-0.18904840072864582,16.212622890008333,14.467493637345441,34.94620612526909,0.11783985303253856,-17.749976914375242,-9.938812245705604,-13.18384020640935,-24.66058323075748,-4.319928842961669,-12.543264867519488,-1.5171487733232425,21.55579823402791,-20.273782156644742,-0.288164559509371]}}};

const SUP_RANGES={mega:[250,350],grand:[200,250],major:[150,200],minor:[100,150],mini:[75,125]};
const SUP_STRATEGIES=[
  ['Mega hits','ev_mega','ci_mega'],
  ['Grand hits','ev_grand','ci_grand'],
  ['Major hits','ev_major','ci_major'],
  ['Minor hits','ev_minor','ci_minor'],
  ['Mini hits','ev_mini','ci_mini'],
  ['Mega + Grand','ev_mega_grand','ci_mega_grand'],
  ['Grand + Major','ev_grand_major','ci_grand_major'],
  ['Major + Minor','ev_major_minor','ci_major_minor'],
  ['Minor + Mini','ev_minor_mini','ci_minor_mini']
];
function supNum(id,min,max){
  const el=$(id);if(!el)return {valid:false,value:0};
  const raw=String(el.value||'').trim().replace(/,/g,'');
  const value=Number(raw);
  return {valid:raw!==''&&Number.isFinite(value)&&value>=min&&value<=max,value};
}
function supBaseFeatures(s){
  const z=[];
  for(const m of ['mega','grand','major','minor','mini']){
    const [lo,hi]=SUP_RANGES[m],p=(s[m]-lo)/(hi-lo);
    z.push(p,p*p,1-Math.exp(-2*(1-p)),1/(0.05+(1-p)));
  }
  return z;
}
function supPolyFeatures(z){
  const out=z.slice();
  for(let i=0;i<z.length;i++)for(let j=i;j<z.length;j++)out.push(z[i]*z[j]);
  return out;
}
function supLinear(model,x){
  let y=model.intercept;
  const c=model.coef;
  for(let i=0;i<c.length;i++)y+=c[i]*x[i];
  return y;
}
function supSingleCoinIn(m,value){
  const [lo,hi]=SUP_RANGES[m],p=(value-lo)/(hi-lo),q=SUP_MODEL.ciSingle[m];
  return Math.max(0.01,q[0]*(1-Math.exp(-q[1]*(1-p))));
}
function supState(){
  const bet=supNum('supBet',0.01,100000),rtp=supNum('supRtp',86.09,94.16);
  const mega=supNum('supMega',250,349),grand=supNum('supGrand',200,249),major=supNum('supMajor',150,199),minor=supNum('supMinor',100,149),mini=supNum('supMini',75,124);
  if(!(bet.valid&&rtp.valid&&mega.valid&&grand.valid&&major.valid&&minor.valid&&mini.valid))return null;
  return {bet:bet.value,rtp:rtp.value,mega:mega.value,grand:grand.value,major:major.value,minor:minor.value,mini:mini.value};
}
function supCalculate(s){
  const x=supPolyFeatures(supBaseFeatures(s));
  const ci={
    ci_mega:supSingleCoinIn('mega',s.mega),
    ci_grand:supSingleCoinIn('grand',s.grand),
    ci_major:supSingleCoinIn('major',s.major),
    ci_minor:supSingleCoinIn('minor',s.minor),
    ci_mini:supSingleCoinIn('mini',s.mini)
  };
  ci.ci_mega_grand=Math.max(ci.ci_mega,ci.ci_grand,supLinear(SUP_MODEL.ciCombo.ci_mega_grand,x));
  ci.ci_grand_major=Math.max(ci.ci_grand,ci.ci_major,supLinear(SUP_MODEL.ciCombo.ci_grand_major,x));
  ci.ci_major_minor=Math.max(ci.ci_major,ci.ci_minor,supLinear(SUP_MODEL.ciCombo.ci_major_minor,x));
  ci.ci_minor_mini=Math.max(ci.ci_minor,ci.ci_mini,supLinear(SUP_MODEL.ciCombo.ci_minor_mini,x));
  const delta=s.rtp/100-0.90,rows=[];
  for(const [label,evKey,ciKey] of SUP_STRATEGIES){
    const ev90=supLinear(SUP_MODEL.ev[evKey],x),coinUnits=ci[ciKey],evUnits=ev90+delta*coinUnits;
    rows.push({label,evUnits,evDollars:evUnits*s.bet,coinIn:coinUnits*s.bet,pct:100*(1+evUnits/coinUnits)});
  }
  return rows;
}
function renderSupCalculator(){
  const host=$('supResults'),hint=$('supHint');if(!host)return;
  const s=supState();
  if(!s){host.innerHTML='Enter valid values for bet, RTP and all five meters.';if(hint)hint.textContent='';return}
  const rows=supCalculate(s);
  host.innerHTML=`<table class="data-table"><tr><th>Strategy</th><th>EV</th><th>EV%</th><th>Coin-in</th></tr>${rows.map(r=>`<tr><td>${r.label}</td><td class="${r.evUnits>0?'good':r.evUnits<0?'bad':''}">${r.evDollars>=0?'+':''}${money(r.evDollars)}</td><td class="${r.evUnits>0?'good':r.evUnits<0?'bad':''}">${r.pct.toFixed(1)}%</td><td>${money0(r.coinIn)}</td></tr>`).join('')}</table>`;
  const marginal=rows.some(r=>Math.abs(r.pct-100)<2);
  if(hint)hint.textContent=marginal?'One or more strategies are within 2 percentage points of break-even; treat those as marginal rather than a hard play/pass signal.':'Deterministic model output; dollar EV and coin-in scale with bet size.';
}

function initials(name){const parts=String(name||'?').trim().split(/\s+/).filter(Boolean);return(parts.length>1?(parts[0][0]+parts[1][0]):parts[0]?.slice(0,2)||'?').toUpperCase()}
function showPage(page){currentPage=['home','schedule','add','reports','calculators','more'].includes(page)?page:'home';for(const p of ['Home','Schedule','Add','Reports','Calculators','More'])$('page'+p).hidden=currentPage!==p.toLowerCase();for(const p of ['Home','Schedule','Add','Reports','More'])$('nav'+p).classList.toggle('active',currentPage===p.toLowerCase());if(currentPage==='schedule')renderSchedule();if(currentPage==='reports')renderReports();window.scrollTo({top:0,behavior:'instant'})}
function showCalculatorsHome(){showPage('calculators');$('calculatorHub').hidden=false;$('calculatorPhoenix').hidden=true;$('calculatorWre').hidden=true;$('calculatorMtg').hidden=true;$('calculatorRegal').hidden=true;$('calculatorSup').hidden=true}
function openCalculator(name){showPage('calculators');$('calculatorHub').hidden=true;$('calculatorPhoenix').hidden=name!=='phoenix';$('calculatorWre').hidden=name!=='wre';$('calculatorMtg').hidden=name!=='mtg';$('calculatorRegal').hidden=name!=='regal';$('calculatorSup').hidden=name!=='sup';if(name==='phoenix'){renderPhoenixCalculator();setTimeout(()=>{const el=$('phoenixCounter');if(el)el.focus()},0)}if(name==='wre'){renderWreCalculator();setTimeout(()=>{const el=$('wreMini');if(el)el.focus()},0)}if(name==='mtg'){renderMtgCalculator();setTimeout(()=>{const el=$('mtgGreen');if(el)el.focus()},0)}if(name==='regal'){renderRegalCalculator();setTimeout(()=>{const el=$('regalPurple');if(el)el.focus()},0)}if(name==='sup'){renderSupCalculator();setTimeout(()=>{const el=$('supMega');if(el)el.focus()},0)}}
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
async function verifySyncKeyRemote(keyOverride=syncKey){
  if(!endpointConfigured()||!keyOverride||!navigator.onLine) return false;
  const data=await cloudRequest('/verify',{keyOverride,timeout:12000});
  if(!data?.ok){
    if(data?.error==='UNAUTHORIZED') throw new Error('Private sync key was rejected');
    throw new Error(data?.error?('Key verification failed: '+data.error):'Key verification failed');
  }
  return true;
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
