import { SALE_CONFIG } from './usdt.mjs';
import { storeLocales, storeMessages } from './store-i18n.mjs';

export function checkoutPage() {
  const en = key=>storeMessages[key][0];
  const label = key=>`<span data-i18n="${key}">${en(key)}</span>`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">
<title>${en('creditsTitle')}</title>
<style>
*{box-sizing:border-box}body{margin:0;color:#e9f0f3;background:#101718;font:1rem/1.5 system-ui,sans-serif}
main,header{max-width:66rem;margin:auto;padding:1.4rem}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #385050}
header b{font-size:1.15rem;letter-spacing:.02em}a{color:#8cf1cd}h1{font-size:clamp(2.15rem,5vw,3.8rem);line-height:1.12;letter-spacing:-.045em;margin:1.5rem 0 .7rem}
h2{font-size:1.22rem;margin:0 0 1rem}p{margin:.6rem 0}.intro{max-width:50rem;color:#bbcdca}.grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:1rem;margin-top:1.6rem}
section{padding:1.25rem;border:1px solid #3c5150;border-radius:.75rem;background:#172222;min-width:0}
label{display:block;font-weight:650;margin:.8rem 0 .3rem}input,select,button{font:inherit;border-radius:.4rem}
input,select{width:100%;padding:.6rem .75rem;border:1px solid #57726e;color:#e8f4ef;background:#111b1b}
button{padding:.65rem 1rem;border:1px solid #66807a;background:#263b37;color:#ebfbf6;font-weight:650;cursor:pointer;margin:.55rem .25rem 0 0}
button.primary{background:#a6f5d4;color:#10251c;border-color:#a6f5d4}button:disabled{opacity:.45;cursor:not-allowed}
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #e6e090;outline-offset:2px}
code,.mono{font-family:ui-monospace,monospace;overflow-wrap:anywhere}.muted{color:#b4ccc6}.status{color:#b2f1d9;font-weight:600;overflow-wrap:anywhere}
dl{margin:0}dt{color:#abc4bd;font-size:.9rem}dd{margin:.12rem 0 .75rem;overflow-wrap:anywhere}
details{margin-top:1rem}summary{cursor:pointer}small{color:#a9c3bb}.pending{margin-top:1rem}section[hidden],div[hidden],p[hidden]{display:none}
@media(max-width:45rem){.grid{grid-template-columns:1fr}main,header{padding:1rem}}
header{gap:1rem;flex-wrap:wrap}header nav{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}header nav label{font-size:.875rem;margin:0}header nav select{width:auto}
</style>
<header><b>GPUChain</b><nav><a href="/ledger">${label('ledger')}</a><label for="language">${label('language')}</label><select id="language"><option value="en">English</option><option value="ko">한국어</option><option value="ja">日本語</option><option value="zh-CN">简体中文</option><option value="fr">Français</option></select></nav></header><main>
<h1>${label('starterTitle')}</h1><p class="intro">${label('starterIntro')}</p>
<section class="pending" aria-labelledby="starterAddressLabel">
<label id="starterAddressLabel" for="starterAddress">${label('gpu')}</label>
<input id="starterAddress" class="mono" autocomplete="off" spellcheck="false" placeholder="${en('gpuHint')}" maxlength="64">
<p id="starterStatus" class="status" role="status" aria-live="polite"></p>
<button type="button" id="starterClaim" class="primary" disabled>${label('starterClaim')}</button>
<button type="button" id="starterCheck" disabled>${label('starterCheck')}</button>
</section>
<section class="pending" aria-labelledby="salesHeading"><h2 id="salesHeading">${label('salesPaused')}</h2>
<p>${label('salesPausedHelp')}</p>
<details><summary>${label('recover')}</summary><label for="restoreId">${label('orderId')}</label>
<input id="restoreId" class="mono" autocomplete="off" spellcheck="false" maxlength="64"><button id="restore">${label('restore')}</button></details>
<div class="pending" id="pending" hidden><dl>
<dt>${label('orderId')}</dt><dd id="orderId" class="mono"></dd><dt>${label('payer')}</dt><dd id="payer" class="mono"></dd>
<dt>${label('destination')}</dt><dd id="destination" class="mono"></dd><dt>${label('terms')}</dt><dd id="terms"></dd>
<dt>${label('status')}</dt><dd id="orderStatus"></dd></dl>
<details id="hashCheck"><summary>${label('transfer')}</summary><label for="hash">${label('hash')}</label>
<input id="hash" class="mono" placeholder="0x…" autocomplete="off"><button id="submitHash">${label('submitHash')}</button></details>
<button id="refresh">${label('refresh')}</button><button id="finish">${label('closeOrder')}</button></div>
<p id="notice" class="status" role="status" aria-live="polite"></p></section>
</main><script src="/buy.js" defer></script></html>`;
  return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
}

// Serialized by checkoutScript. This function has no closure over server secrets or helpers.
function checkout(genesis,locales,strings) {
  const el=id=>document.getElementById(id);
  const storageKey='gpuchain-usdt-order-'+genesis;
  const txt=(id,s)=>{el(id).textContent=s;};
  const hashValid=h=>typeof h==='string' && /^0x[0-9a-f]{64}$/.test(h);
  const idValid=i=>typeof i==='string' && /^[0-9a-f]{64}$/.test(i);
  let order=null, orderLookup=0, pendingHash='', busy=false, timerBusy=false;
  const languageKey='gpuchain.wallet.language';
  let lang='en', noticeKey='';
  const t=(key,vars={})=>(strings[key]?.[locales.indexOf(lang)] ?? strings.failed[0])
    .replace(/\{(\w+)\}/g,(_,name)=>String(vars[name]??''));
  const networkName=id=>t(id===1?'eth':'bsc');
  const grantAddress=()=>el('starterAddress').value.trim().toLowerCase();
  const validGrantAddress=s=>/^[a-f0-9]{64}$/.test(s);
  let lookupId=0, grant=null, grantMessage='', grantSubmitting=false;
  const grantReasons={wallet_not_recorded:'starterUnknown',ineligible_wallet:'starterIneligible',
    invalid_address:'gpuInvalid',program_inactive:'starterClosed',budget_exhausted:'starterExhausted',
    reserve_unavailable:'starterUnavailable',hosted_capacity:'starterUnavailable'};
  function renderGrant() {
    const address=grantAddress(), same=grant?.address===address;
    el('starterAddress').disabled=grantSubmitting;
    el('starterCheck').disabled=grantSubmitting || !validGrantAddress(address) || grantMessage==='starterChecking';
    const eligible=same && grant.active && grant.eligible && !grant.claimed && grant.remainingClaims>0 && grant.canClaim;
    el('starterClaim').disabled=grantSubmitting || !eligible;
    txt('starterStatus',grantMessage?t(grantMessage):'');
  }
  async function checkGrant() {
    if(grantSubmitting) return;
    const id=++lookupId, address=grantAddress();
    grant=null;
    grantMessage=!address?'':validGrantAddress(address)?'starterChecking':'gpuInvalid';
    renderGrant();
    if(!validGrantAddress(address)) return;
    try {
      const status=await api('/v1/starter/status?address='+address);
      if(id!==lookupId || grantAddress()!==address) return;
      if(!status || ['eligible','claimed','active','canClaim'].some(k=>typeof status[k]!=='boolean') ||
        !Number.isSafeInteger(status.remainingClaims) || status.remainingClaims<0 ||
        (status.address!==undefined && status.address!==address)) throw Error();
      grant={...status,address};
      grantMessage=status.claimed?'starterAlready':grantReasons[status.reason] ??
        (!status.active || !status.remainingClaims?'starterClosed':!status.eligible?'starterUnknown':
          status.canClaim?'starterEligible':'starterUnavailable');
    } catch {
      if(id!==lookupId || grantAddress()!==address) return;
      grantMessage='starterUnavailable';
    }
    renderGrant();
  }
  async function claimGrant() {
    if(grantSubmitting || el('starterClaim').disabled || grant?.address!==grantAddress()) return;
    const address=grant.address;
    grantSubmitting=true;grantMessage='starterSending';renderGrant();
    try {
      const result=await api('/v1/starter/claim',{address});
      if(result?.address!==address || result.claimed!==true || result.coins!=='100' || typeof result.alreadyClaimed!=='boolean') throw Error();
      grant={...grant,claimed:true,canClaim:false};
      grantMessage=result.alreadyClaimed?'starterAlready':'starterDone';
    } catch (error) {
      grant=null;
      grantMessage=grantReasons[error.remoteCode]??'starterUnconfirmed';
    } finally {grantSubmitting=false;renderGrant();}
  }
  function notice(key){noticeKey=key;txt('notice',key?t(key):'');}
  function langError(key){return Object.assign(Error(t(key)),{i18n:key});}
  function errorKey(e) {
    if(e?.i18n) return e.i18n;
    return 'failed';
  }
  const divider=()=>new Intl.NumberFormat(lang).formatToParts(1.1).find(p=>p.type==='decimal')?.value || '.';
  function setLanguage(value) {
    lang=locales.includes(value)?value:'en';
    document.documentElement.lang=lang;
    document.title=t('creditsTitle');
    el('language').value=lang;
    for(const node of document.querySelectorAll('[data-i18n]')) node.textContent=t(node.dataset.i18n);
    el('starterAddress').placeholder=t('gpuHint');
    notice(noticeKey);render();renderGrant();
  }
  function decimal(s,d=6) {
    const n=BigInt(s), f=10n**BigInt(d), rest=(n%f).toString().padStart(d,'0').replace(/0+$/,'');
    return (n/f).toLocaleString(lang)+(rest?divider()+rest:'');
  }
  async function api(path,body) {
    const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},
      body:body?JSON.stringify(body):undefined,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
    const j=await r.json();
    if(!r.ok) throw Object.assign(langError(r.status===404?'notFound':r.status===400?'badOrder':
      (r.status===409||r.status===429)?'conflict':'temporary'),{remoteCode:j.code});
    return j;
  }
  function stash() {
    try {
      if(!order) {localStorage.removeItem(storageKey);return;}
      localStorage.setItem(storageKey,JSON.stringify({id:order.id,hash:pendingHash}));
    } catch { notice('storageError'); }
  }
  function checkOrder(o) {
    if(!o || !idValid(o.id) || ![1,56].includes(o.chainId) || !/^0x[0-9a-f]{40}$/.test(o.payer) ||
      !/^[0-9a-f]{64}$/.test(o.gpuAddress) || !/^[1-9][0-9]{0,18}$/.test(o.amountMicro) ||
      !Number.isSafeInteger(o.expiresAt) || typeof o.status!=='string') throw langError('badOrder');
    return o;
  }
  const terminal=o=>['delivered','expired','cancelled','rejected'].includes(o.status);
  function render() {
    el('restore').disabled=busy;
    el('pending').hidden=!order;
    if(!order) return;
    txt('orderId',order.id);txt('payer',order.payer);txt('destination',order.gpuAddress);
    const coins=typeof order.amountNano==='string' && /^[0-9]+$/.test(order.amountNano)?decimal(order.amountNano,9):'—';
    txt('terms',t('orderLine',{network:networkName(order.chainId),usdt:decimal(order.amountMicro),coins,
      expiry:new Date(order.expiresAt).toLocaleString(lang)}));
    const keys={reserved:'unpaidPaused',quoted:'unpaidPaused',awaiting_payment:'unpaidPaused',open:'unpaidPaused',processing:'delivering'};
    const state=keys[order.status]||order.status;
    let review='';
    if(order.reviewReason) review=t(/replenish|authorization/i.test(order.reviewReason)?'reviewStock':
      /after quote expiry/i.test(order.reviewReason)?'reviewLate':/multiple|additional/i.test(order.reviewReason)?'reviewExtra':'review');
    const details=[t(Object.hasOwn(strings,state)?state:'pending'),pendingHash,review,order.latePaymentHash].filter(Boolean);
    txt('orderStatus',details.join(' · '));
    el('hashCheck').hidden=order.status==='delivered';
    el('submitHash').disabled=busy;
    el('refresh').disabled=busy;
    el('finish').disabled=busy;
  }
  async function loadOrder(id) {
    if(!idValid(id)) throw langError('badOrder');
    const requestId=++orderLookup;
    const fresh=checkOrder(await api('/v1/sales/orders/'+id));
    if(requestId!==orderLookup) return;
    if(fresh.id!==id) throw langError('badOrder');
    if(order && order.id!==id) pendingHash='';
    order=fresh;
    if(hashValid(fresh.txHash)) pendingHash=fresh.txHash;
    if(pendingHash) el('hash').value=pendingHash;
    stash();
  }
  async function claim(h) {
    if(!order || !hashValid(h)) throw langError('badHash');
    pendingHash=h;stash();
    await api('/v1/sales/claim',{orderId:order.id,txHash:h});
    await loadOrder(order.id);
  }
  async function action(work) {
    if(busy) return;
    busy=true;render();
    try {await work();}
    catch(e) {notice(errorKey(e));}
    finally {busy=false;render();}
  }
  el('refresh').onclick=()=>action(()=>loadOrder(order.id));
  el('submitHash').onclick=()=>action(()=>claim(el('hash').value.trim().toLowerCase()));
  el('restore').onclick=()=>action(()=>loadOrder(el('restoreId').value.trim()));
  el('finish').onclick=()=>action(async()=>{orderLookup++;order=null;pendingHash='';el('hash').value='';stash();notice('');});
  el('starterAddress').addEventListener('input',checkGrant);
  el('starterCheck').onclick=checkGrant;
  el('starterClaim').onclick=claimGrant;
  async function poll() {
    if(!order || terminal(order) || busy || timerBusy || document.hidden) return;
    timerBusy=true;
    try {await loadOrder(order.id);}catch(e){notice(errorKey(e));}
    finally {timerBusy=false;render();}
  }
  (async()=>{
    let saved='en';
    try {saved=localStorage.getItem(languageKey)||'en';} catch {}
    setLanguage(saved);
    el('language').addEventListener('change',event=>{
      setLanguage(event.target.value);
      try {localStorage.setItem(languageKey,lang);} catch {}
    });
    const prefill=new URLSearchParams(location.search).get('gpuAddress');
    if(validGrantAddress(prefill||'')) {el('starterAddress').value=prefill;checkGrant();}
    let stored;
    try {stored=JSON.parse(localStorage.getItem(storageKey));}catch {}
    if(stored?.id && idValid(stored.id)) {
      el('restoreId').value=stored.id;
      pendingHash=hashValid(stored.hash)?stored.hash:'';
      try {await loadOrder(stored.id);}catch(e){notice(errorKey(e));}
    }
    await poll();setInterval(poll,15000);document.addEventListener('visibilitychange',poll);
  })();
}

export function checkoutScript() {
  const js='('+checkout.toString()+')('+JSON.stringify(SALE_CONFIG.genesis)+','+JSON.stringify(storeLocales)+','+JSON.stringify(storeMessages)+');';
  return new Response(js,{headers:{'content-type':'text/javascript; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
