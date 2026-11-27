import { decodeAmount, isAmount } from './amount.mjs';

const el = id => document.getElementById(id);
import { locales, translate } from './i18n.js';
let locale = 'en';
let numberFormat, clockFormat, dateFormat;
const t = (key,values) => translate(locale,key,values);
let offline = false;


const roles = {standby:"Waiting for checkpoint",verifier:"Ledger verifier",validator:"Consensus validator"};
const enrollments = {
  voting:"Voting member", 'committee-fixed':"Committee already formed", 'identity-mismatch':"Node identity mismatch",
  'needs-public-origin':"Dedicated HTTPS endpoint required to vote", 'needs-registration':"Wallet authorization required",
  candidate:"Validator candidate", 'waiting-for-checkpoint':"Waiting for first checkpoint"
};
const adapterStates = {
  unavailable:"No response", 'not-ready':"Not ready", 'different-chain':"Different network",
  incompatible:"Incompatible configuration", online:"Connected"
};
const engineStates={
  checking:'Checking', ready:'Connected', disabled:'Off', external_adapter:'External adapter',
  engine_unreachable:'No response on the configured local engine ports', unrecognized_service:'Local service is not a supported Strata engine',
  model_unloaded:'Engine online, model unloaded',profile_unavailable:'Model, KV or privacy checks failed',
  adapter_port_in_use:'Provider adapter port is in use'
};
const routeStates={
  ready:'Has an eligible remote provider',self_provider_only:'Only this wallet is registered as a provider',
  no_eligible_provider:'No eligible provider',no_registered_provider:'No registered providers',
  no_encrypted_provider:'Relay online, no ready provider',relay_unreachable:'Provider directories are unreachable',
  relay_partial:'Some relays are unreachable and the others have no matching provider', provider_capability_mismatch:'Offers do not meet the requested limits',
  output_limit_exceeded:'Current epoch output limit is below the OpenCode default',
  ledger_unavailable:'Cannot verify a writable ledger'
};
const starterStates={claimed:'Starter coins already claimed',unrecorded:'Receive a GPUChain transfer at this address, then check again.',
  recorded:'Address recorded. Check current grant availability on the claim site.',ineligible:'This address is ineligible'};
let routeCode=null;
let snapshot;
let loading = false;
let copyTimer;

function show(id,value) { el(id).textContent = typeof value === 'string' ? t(value) : value ?? '—'; }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? numberFormat.format(value) : '—'; }
function bool(value,yes,no) { return value === true ? yes : value === false ? no : "Unavailable"; }
function time(value,format) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? format.format(date) : '—';
}
function coins(nano) {
  if (!isAmount(nano)) return '—';
  const n = decodeAmount(nano);
  const whole = n/1000000000n;
  const fraction = (n%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');
  return numberFormat.format(whole)+(fraction ? numberFormat.formatToParts(1.1).find(part=>part.type==='decimal').value+fraction : '');
}
function badge(id,text,tone) {
  const item = el(id);
  item.querySelector('span').textContent = t(text);
  item.dataset.tone = tone;
}
function notice(text) {
  el('notice').hidden = !text;
  el('notice').textContent = t(text);
}
const paymentStates={confirmed:'Confirmed',pending:'Awaiting confirmation',unconfirmed:'Proof unavailable',
  rejected:'Rejected',unavailable:'Unavailable',busy:'Wallet transaction pending'};
let reviewResult,reviewing=false;
function renderPayments(wallet) {
  const last=wallet.lastTransfer;
  el('last-transfer-row').hidden=!last;
  if (last) show('last-transfer',[t(paymentStates[last.status]),last.coins+' '+t('coins'),last.to,
    t('Wallet nonce')+' '+count(last.nonce),last.height ? t('Ledger height')+' '+count(last.height) : null,last.txHash].filter(Boolean).join(' · '));
  const records=[...(wallet.unconfirmedPayments ?? [])];
  if (last?.status==='pending') records.unshift(last);
  el('payment-result-row').hidden=!reviewResult;
  if (reviewResult) {
    const {status,txHash,height}=reviewResult;
    show('payment-result',[t(paymentStates[status] ?? 'Unavailable'),height?t('Ledger height')+' '+count(height):null,txHash].filter(Boolean).join(' · '));
  }
  el('payment-review-row').hidden=!records.length;
  const box=el('payment-reviews');
  box.replaceChildren();
  for (const {nonce,txHash} of records) {
    const row=document.createElement('p'),button=document.createElement('button');
    button.type='button';button.className='refresh';button.disabled=reviewing;
    button.textContent=t('Check payment outcome')+' · '+t('Wallet nonce')+' '+count(nonce);
    button.addEventListener('click',async()=>{
      reviewing=true;renderPayments(wallet);
      try {
        const reply=await fetch('/api/payment-outcome/'+txHash,{cache:'no-store',signal:AbortSignal.timeout(30000)});
        if (!reply.ok) throw Error();
        const {status,height}=await reply.json();
        reviewResult={status,txHash,height};
        if (status==='confirmed') await refresh();
      } catch {reviewResult={status:'unavailable',txHash};}
      reviewing=false;
      if (snapshot) renderPayments(snapshot.wallet);
    });
    row.append(button,document.createTextNode(' '+txHash));
    box.append(row);
  }
}
function render(data) {
  const {wallet,node,network,inference} = data;
  if (!wallet || !node || !network || !inference || !data.sampledAt) throw new Error('Invalid overview');
  const amount = coins(wallet.balanceNanocoins);
  show('balance',amount);
  el('balance').classList.toggle('long-amount',amount.length > 13);
  show('nano',amount === '—' ? "Waiting for a verified balance" : t('{n} nanocoins',{n:numberFormat.format(decodeAmount(wallet.balanceNanocoins))}));
  show('address',wallet.address);
  el('copy').disabled = !wallet.address;
  show('nonce',count(wallet.nonce));
  el('spend-activity').hidden=!wallet.spendActivity;
  show('spend-activity',wallet.spendActivity==='inference' ? 'Waiting for inference settlement' : 'Wallet transaction pending');
  renderPayments(wallet);

  badge('node-badge',node.syncError ? "Sync delayed" : node.verified ? "Verified" : "Awaiting verification",node.syncError ? 'warn' : node.verified ? 'ok' : 'neutral');
  show('node-mode',roles[node.mode] ?? "Unavailable");
  show('voting',bool(node.voting,"Participating","Not participating"));
  show('verified-at',time(node.lastVerifiedAt,dateFormat));
  show('instance',node.instanceId);
  show('pid',node.pid?.toString());
  show('ledger',node.ledgerUrl);
  show('enrollment',enrollments[node.enrollmentStatus] ?? node.enrollmentStatus);
  show('last-error',[node.syncError,node.enrollmentError].filter(Boolean).map(k=>t(k)).join(' · '));
  el('error-row').hidden = !(node.syncError || node.enrollmentError);

  const online = inference.adapter === 'online';
  if (online) {
    const activity = inference.inferenceActive === true ? "Generating" :
      inference.busy === true ? "Handling a request" : inference.busy === false ? "Waiting for requests" : "Connected";
    badge('inference-badge',activity,'ok');
  } else if (inference.adapter === 'unavailable') {
    badge('inference-badge',"Disconnected",'neutral');
  } else {
    badge('inference-badge',adapterStates[inference.adapter] ?? "Unavailable",'warn');
  }
  show('node-inference',bool(inference.nodeRunsInference,"On","Off"));
  show('adapter',adapterStates[inference.adapter] ?? "Unavailable");
  show('engine-check',engineStates[inference.engineStatus]);
  el('starter-record-panel').hidden=!data.starterRecord;
  show('starter-record',starterStates[data.starterRecord]);
  show('registered',bool(inference.walletRegistered,"Registered","Not registered"));
  show('relay-mode',({ready:'Connected',busy:'Handling a request',draining:'Finishing accepted requests',offline:'Disconnected',
    error:'Unavailable',connecting:'Checking',disabled:'Off','waiting-for-model':'Waiting for local model',
    'waiting-for-registration':'Wallet authorization required'})[data.relay?.mode]);
  show('engine-origin',data.relay?.backendUrl);
  el('activity-row').hidden = !online;
  show('activity',bool(inference.inferenceActive,"Generating",inference.busy ? "Handling a request" : "Idle"));
  show('model',inference.model);
  show('engine',({strata:'Strata',ryzenstrata:'RYZENStrata'})[inference.engine]);
  show('kv-cache',inference.kvCache ? 'K '+inference.kvCache.k+' / V '+inference.kvCache.v : null);
  show('context',Number.isSafeInteger(inference.contextWindow) ? t('{n} tokens',{n:count(inference.contextWindow)}) : null);
  show('provider-address',inference.providerAddress);
  show('same-wallet',bool(inference.sameWallet,"Same wallet","Different wallet"));
  show('provider-registered',bool(inference.providerRegistered,"Registered","Not registered"));

  show('consensus',({bootstrap:"Bootstrap sequencer",quorum:"Committee consensus"})[network.consensus] ?? "Awaiting consensus status");
  show('height',count(network.height));
  show('providers',Number.isSafeInteger(network.registeredProviders) ? count(network.registeredProviders) : null);
  show('epoch-title',Number.isSafeInteger(network.epoch) ? t('Epoch {n} progress',{n:count(network.epoch)}) : "Epoch progress");
  const progress = el('progress');
  const known = Number.isSafeInteger(network.epochTokens) && network.epochTokens >= 0 && Number.isSafeInteger(network.epochTarget) && network.epochTarget > 0;
  progress.hidden = !known;
  if (known) {
    progress.max = network.epochTarget;
    progress.value = network.epochTokens;
    const ratio = network.epochTokens/network.epochTarget*100;
    show('percent',ratio > 0 && ratio < .01 ? '<'+numberFormat.format(0.01)+'%' : numberFormat.format(Math.floor(ratio*100)/100)+'%');
  } else show('percent',null);
  show('work',known ? t('{n} tokens',{n:count(network.epochTokens)+' / '+count(network.epochTarget)}) : "Waiting for verified usage");
  show('network-name',network.name);
  show('network-stage',network.stage === 'mainnet' ? 'Mainnet' : (network.name ?? 'GPUChain'));
  show('chain-id',network.chainId);
  show('tip',network.tip);
  show('sample-time',t('Updated {time}',{time:time(data.sampledAt,clockFormat)}));
  notice(node.syncError ? (node.verified ? "Waiting for sync. Showing the last verified ledger state." : "Waiting for the first ledger sync.") : '');
}

async function refresh() {
  if (loading) return;
  loading = true;
  const button = el('refresh');
  button.disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),8000);
  try {
    const response = await fetch('/api/overview',{cache:'no-store',signal:controller.signal});
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    offline = false;
    render(data);
    snapshot = data;
  } catch {
    offline = true;
    renderOffline();
  } finally {
    clearTimeout(timeout);
    loading = false;
    button.disabled = false;
  }
}

function renderOffline() {
  const sampled = snapshot && time(snapshot.sampledAt,clockFormat);
  notice(sampled ? t('Local node unavailable. Showing the data received at {time}.',{time:sampled})
    : 'Local node unavailable. Check that it is running and refresh.');
  badge('node-badge','Connection unknown','warn');
  badge('inference-badge','Unavailable','neutral');
  show('sample-time',sampled ? t('Last update {time}',{time:sampled}) : 'Refresh failed');
}

function setLanguage(language) {
  locale = locales.includes(language) ? language : 'en';
  numberFormat = new Intl.NumberFormat(locale);
  const clock = {hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'};
  clockFormat = new Intl.DateTimeFormat(locale,clock);
  dateFormat = new Intl.DateTimeFormat(locale,{...clock,year:'numeric',month:'2-digit',day:'2-digit'});
  document.documentElement.lang = locale;
  document.title = t('GPUChain Wallet');
  if (routeCode) show('route-diagnosis',routeStates[routeCode] ?? 'Unavailable');
  el('language').value = locale;
  for (const item of document.querySelectorAll('[data-i18n]')) item.textContent = t(item.dataset.i18n);
  clearTimeout(copyTimer);
  show('copy-text','Copy address');
  show('feedback','');
  if (snapshot) render(snapshot);
  if (offline) renderOffline();
  window.dispatchEvent(new CustomEvent('gpuchain-languagechange',{detail:{locale}}));
}

let saved = 'en';
try { saved = localStorage.getItem('gpuchain.wallet.language') || 'en'; } catch { /* Private browser mode. */ }
setLanguage(saved);
el('language').addEventListener('change',event=>{
  setLanguage(event.target.value);
  try { localStorage.setItem('gpuchain.wallet.language',locale); } catch { /* Selection still applies to this tab. */ }
});
el('refresh').addEventListener('click',refresh);
el('check-routes').addEventListener('click',async()=>{
  const button=el('check-routes');
  button.disabled=true;
  el('route-diagnosis').hidden=false;
  show('route-diagnosis','Checking');
  try {
    const r=await fetch('/api/inference-routes',{cache:'no-store',signal:AbortSignal.timeout(45000)});
    if (!r.ok) throw Error();
    routeCode=(await r.json()).code;
  } catch {routeCode='unavailable';}
  show('route-diagnosis',routeStates[routeCode] ?? 'Unavailable');
  button.disabled=false;
});
el('copy').addEventListener('click',async()=>{
  if (!snapshot?.wallet.address) return;
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(snapshot.wallet.address);
    show('copy-text',"Copied");
    show('feedback',"Public address copied.");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el('address'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    show('copy-text',"Copy selection");
    show('feedback',"Address selected. Use your device’s copy command.");
  }
  copyTimer = setTimeout(()=>{show('copy-text',"Copy address");show('feedback','');},2300);
});
document.addEventListener('visibilitychange',()=>{if (!document.hidden) refresh();});
setInterval(()=>{if (!document.hidden) refresh();},10000);
refresh();
