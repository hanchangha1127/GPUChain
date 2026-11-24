import { SALE_CONFIG, paymentMessage, transferData } from './usdt.mjs';
import { storeLocales, storeMessages } from './store-i18n.mjs';

export function checkoutPage() {
  const en = key=>storeMessages[key][0].replace('{rate}',String(SALE_CONFIG.coinsPerUsdt));
  const label = key=>`<span data-i18n="${key}">${en(key)}</span>`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">
<title>${en('title')}</title>
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
<h1>${label('heading')}</h1><p class="intro">${label('intro')}</p>
<div class="grid"><section><h2>${label('buy')}</h2>
<label for="network">${label('network')}</label><select id="network"><option value="1" id="networkEth">Ethereum · USDT (ERC-20)</option><option value="56" id="networkBsc">BNB Smart Chain · Binance-Peg USDT (BEP-20)</option></select>
<label for="gpu">${label('gpu')}</label><input id="gpu" class="mono" autocomplete="off" placeholder="${en('gpuHint')}" spellcheck="false" maxlength="64">
<label for="amount">${label('amount')}</label><input id="amount" inputmode="decimal" value="1" autocomplete="off">
<p id="cost"></p><p id="availability" class="status" role="status">${en('checking')}</p>
<button id="connect">${label('connect')}</button><button id="reserve" class="primary" disabled>${label('reserve')}</button>
<p id="account" class="mono muted"></p><p class="muted">${label('evm')}</p>
</section><section><h2>${label('guide')}</h2>
<p>${label('signFirst')}</p><p>${label('fees')}</p>
<details><summary>${label('contracts')}</summary><p>${label('eth')} USDT<br><code>${SALE_CONFIG.networks[1].token}</code></p><p>${label('bsc')} Binance-Peg USDT<br><code>${SALE_CONFIG.networks[56].token}</code></p></details>
</section></div>
<section class="pending" id="pending" hidden><h2>${label('registered')}</h2><dl>
<dt>${label('orderId')}</dt><dd id="orderId" class="mono"></dd><dt>${label('payer')}</dt><dd id="payer" class="mono"></dd>
<dt>${label('destination')}</dt><dd id="destination" class="mono"></dd><dt>${label('terms')}</dt><dd id="terms"></dd>
<dt>${label('status')}</dt><dd id="orderStatus"></dd></dl>
<div id="payment" hidden><p>${label('payOnce')}</p><code id="merchant"></code>
<p><button id="pay" class="primary">${label('pay')}</button></p></div>
<details><summary>${label('transfer')}</summary><label for="hash">${label('hash')}</label><input id="hash" class="mono" placeholder="0x…" autocomplete="off"><button id="submitHash">${label('submitHash')}</button></details>
<button id="refresh">${label('refresh')}</button><button id="finish" hidden>${label('finish')}</button>
</section>
<details><summary>${label('recover')}</summary><label for="restoreId">${label('orderId')}</label><input id="restoreId" class="mono" autocomplete="off"><button id="restore">${label('restore')}</button></details>
<p id="notice" class="status" role="status" aria-live="polite"></p></main><script src="/buy.js" defer></script></html>`;
  return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
}

// Serialized by checkoutScript. This function has no closure over server secrets or helpers.
function checkout(config,message,encodeTransfer,locales,strings) {
  const el=id=>document.getElementById(id);
  const storageKey='gpuchain-usdt-order-'+config.genesis;
  const txt=(id,s)=>{el(id).textContent=s;};
  const hashValid=h=>typeof h==='string' && /^0x[0-9a-f]{64}$/.test(h);
  const idValid=i=>typeof i==='string' && /^[a-zA-Z0-9_-]{16,128}$/.test(i);
  const chain=()=>Number(el('network').value);
  let payer='', sale=null, order=null, pendingHash='', attempted=false, busy=false,timerBusy=false;
  const languageKey='gpuchain.wallet.language';
  let lang='en', noticeKey='',loadingSale=true;
  const t=(key,vars={})=>(strings[key]?.[locales.indexOf(lang)] ?? strings.failed[0])
    .replace(/\{(\w+)\}/g,(_,name)=>String(vars[name]??''));
  const networkName=id=>t(id===1?'eth':'bsc');
  function notice(key){noticeKey=key;txt('notice',key?t(key):'');}
  function langError(key){return Object.assign(Error(t(key)),{i18n:key});}
  function errorKey(e) {
    if(e?.i18n) return e.i18n;
    if(e?.code===4001) return 'walletCancelled';
    return 'failed';
  }
  const divider=()=>new Intl.NumberFormat(lang).formatToParts(1.1).find(p=>p.type==='decimal')?.value || '.';
  function setLanguage(value) {
    if(lang==='fr' && value!=='fr') el('amount').value=el('amount').value.replace(',','.');
    lang=locales.includes(value)?value:'en';
    document.documentElement.lang=lang;
    document.title=t('title');
    el('language').value=lang;
    for(const node of document.querySelectorAll('[data-i18n]')) node.textContent=t(node.dataset.i18n,{rate:config.coinsPerUsdt});
    el('gpu').placeholder=t('gpuHint');
    txt('networkEth',t('eth')+' · USDT (ERC-20)');
    txt('networkBsc',t('bsc')+' · Binance-Peg USDT (BEP-20)');
    notice(noticeKey);render();
  }
  function decimal(s,d=6) {
    const n=BigInt(s), f=10n**BigInt(d), rest=(n%f).toString().padStart(d,'0').replace(/0+$/,'');
    return (n/f).toLocaleString(lang)+(rest?divider()+rest:'');
  }
  function amount() {
    const text=el('amount').value.trim().replace(divider(),'.');
    const m=/^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,6}))?$/.exec(text);
    if(!m) throw langError('amountPrecision');
    const n=BigInt(m[1])*1000000n+BigInt((m[2]||'').padEnd(6,'0'));
    if(n<=0n) throw langError('amountPositive');
    return n.toString();
  }
  function provider() {
    if(!window.ethereum?.request) throw langError('walletMissing');
    return window.ethereum;
  }
  async function api(path,body) {
    const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},
      body:body?JSON.stringify(body):undefined,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
    const j=await r.json();
    if(!r.ok) throw langError(r.status===404?'notFound':r.status===400?'badOrder':
      (r.status===409||r.status===429)?'conflict':'temporary');
    return j;
  }
  function stash() {
    try {
      if(!order) {localStorage.removeItem(storageKey);return;}
      localStorage.setItem(storageKey,JSON.stringify({id:order.id,hash:pendingHash,attempted}));
    } catch { notice('storageError'); }
  }
  function checkOrder(o) {
    if(!o || !idValid(o.id) || !config.networks[o.chainId] || !/^0x[0-9a-f]{40}$/.test(o.payer) ||
      !/^[0-9a-f]{64}$/.test(o.gpuAddress) || !/^[1-9][0-9]{0,18}$/.test(o.amountMicro) ||
      !Number.isSafeInteger(o.expiresAt) || typeof o.status!=='string') throw langError('badOrder');
    return o;
  }
  const unexpired=o=>Date.now()<o.expiresAt;
  const deliveryNano=micro=>BigInt(micro)*BigInt(config.nanoPerMicro);
  const correctRate=()=>sale?.coinsPerUsdt===config.coinsPerUsdt;
  const payable=o=>o.status==='reserved' && unexpired(o) && correctRate() &&
    o.coinsPerUsdt===config.coinsPerUsdt && o.amountNano===deliveryNano(o.amountMicro).toString() &&
    sale?.networks?.[o.chainId]?.paymentReady===true;
  const terminal=o=>['delivered','expired','cancelled','rejected'].includes(o.status);
  function render() {
    const id=chain(), net=config.networks[id], enabled=correctRate() && sale?.accepting===true && sale?.networks?.[id]?.accepting===true;
    let n;
    try {n=amount();txt('cost',t('cost',{coins:decimal(deliveryNano(n),9),gas:net.symbol}));}
    catch {txt('cost',t('rate',{rate:config.coinsPerUsdt}));}
    txt('account',payer?t('account',{payer}):'');
    const reason=sale?.networks?.[id]?.reason;
    txt('availability',loadingSale?t('checking'):enabled?t('available',{inventory:decimal(sale.inventoryNano,9)}):
      t(reason && Object.hasOwn(strings,reason)?reason:'unavailable'));
    el('connect').disabled=busy;
    el('reserve').disabled=busy || !enabled || !payer || !n || !/^[a-f0-9]{64}$/.test(el('gpu').value.trim()) ||
      deliveryNano(n)>BigInt(sale.inventoryNano) || BigInt(n)>BigInt(sale.maxOrderMicro) || !!order;
    el('pending').hidden=!order;
    if(!order) return;
    txt('orderId',order.id);txt('payer',order.payer);txt('destination',order.gpuAddress);
    const coins=typeof order.amountNano==='string' && /^[0-9]+$/.test(order.amountNano)?decimal(order.amountNano,9):'—';
    txt('terms',t('orderLine',{network:networkName(order.chainId),usdt:decimal(order.amountMicro),coins,
      expiry:new Date(order.expiresAt).toLocaleString(lang)}));
    const keys={quoted:'reserved',awaiting_payment:'reserved',open:'reserved',processing:'delivering'};
    const state=keys[order.status]||order.status;
    let review='';
    if(order.reviewReason) review=t(/replenish|authorization/i.test(order.reviewReason)?'reviewStock':
      /after quote expiry/i.test(order.reviewReason)?'reviewLate':/multiple|additional/i.test(order.reviewReason)?'reviewExtra':'review');
    const details=[t(Object.hasOwn(strings,state)?state:'pending'),pendingHash,review,order.latePaymentHash].filter(Boolean);
    txt('orderStatus',details.join(' · '));
    const canSend=payable(order) && !attempted && !pendingHash;
    el('payment').hidden=!canSend;
    txt('merchant',canSend?config.merchant:'');
    el('pay').disabled=busy||!canSend;
    el('submitHash').disabled=busy;
    el('finish').hidden=!terminal(order);
    el('refresh').disabled=busy;
  }
  async function selectWallet(id) {
    const p=provider(), accounts=await p.request({method:'eth_requestAccounts'});
    if(!accounts?.[0]) throw langError('walletNeeded');
    if(BigInt(await p.request({method:'eth_chainId'}))!==BigInt(id)) {
      await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x'+Number(id).toString(16)}]});
    }
    const current=await p.request({method:'eth_accounts'});
    if(!current?.[0] || BigInt(await p.request({method:'eth_chainId'}))!==BigInt(id)) throw langError('wrongNetwork');
    payer=current[0].toLowerCase();return p;
  }
  async function syncSale() {
    try {sale=await api('/v1/sales/status');} catch(e) {sale=null;throw e;} finally {loadingSale=false;}
  }
  async function loadOrder(id) {
    if(!idValid(id)) throw langError('badOrder');
    const fresh=checkOrder(await api('/v1/sales/orders/'+id));
    if(fresh.id!==id) throw langError('badOrder');
    if(order && order.id!==id) {pendingHash='';attempted=false;}
    order=fresh;
    if(hashValid(fresh.txHash)) {pendingHash=fresh.txHash;attempted=true;}
    if(pendingHash) el('hash').value=pendingHash;
    stash();
  }
  async function claim(h) {
    if(!order || !hashValid(h)) throw langError('badHash');
    pendingHash=h;attempted=true;stash();
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
  el('connect').onclick=()=>action(async()=>{await selectWallet(order?.chainId??chain());notice('connected');});
  el('reserve').onclick=()=>action(async()=>{
    if(order) throw langError('existing');
    await syncSale();
    const chainId=chain(), gpuAddress=el('gpu').value.trim(),amountMicro=amount();
    if(!correctRate() || !sale?.accepting || !sale?.networks?.[chainId]?.accepting ||
      deliveryNano(amountMicro)>BigInt(sale.inventoryNano) || BigInt(amountMicro)>BigInt(sale.maxOrderMicro))
      throw langError('quantity');
    if(!/^[0-9a-f]{64}$/.test(gpuAddress)) throw langError('gpuInvalid');
    const p=await selectWallet(chainId);
    const q={chainId,payer,gpuAddress,amountMicro,requestId:crypto.randomUUID().replaceAll('-',''),issuedAt:Date.now()};
    const bytes=new TextEncoder().encode(message(q,config));
    const hex='0x'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    const signature=await p.request({method:'personal_sign',params:[hex,payer]});
    const result=checkOrder(await api('/v1/sales/quote',{...q,signature}));
    if(result.chainId!==q.chainId||result.gpuAddress!==q.gpuAddress||result.payer!==q.payer||result.amountMicro!==q.amountMicro||
      result.coinsPerUsdt!==config.coinsPerUsdt||result.amountNano!==deliveryNano(q.amountMicro).toString())
      throw langError('mismatch');
    order=result;pendingHash='';attempted=false;stash();notice('placed');
  });
  el('pay').onclick=()=>action(async()=>{
    if(!order||attempted||pendingHash) throw langError('alreadyPaid');
    await Promise.all([syncSale(),loadOrder(order.id)]);
    if(!payable(order)||attempted||pendingHash) throw langError('unavailableOrder');
    const p=await selectWallet(order.chainId);
    if(order.payer!==payer) throw langError('wrongWallet');
    if(!payable(order)) throw langError('expired');
    attempted=true;stash();render();
    let tx;
    try {
      const n=config.networks[order.chainId];
      tx=await p.request({method:'eth_sendTransaction',params:[{from:payer,to:n.token,value:'0x0',
        chainId:'0x'+order.chainId.toString(16),data:encodeTransfer(order.amountMicro,n.decimals,config.merchant)}]});
    } catch(e) {
      if(e.code===4001) {attempted=false;stash();}
      else throw langError('uncertain');
      throw e;
    }
    if(!hashValid(String(tx).toLowerCase())) throw langError('badHash');
    notice('submitted');
    await claim(tx.toLowerCase());
  });
  el('refresh').onclick=()=>action(()=>loadOrder(order.id));
  el('submitHash').onclick=()=>action(()=>claim(el('hash').value.trim().toLowerCase()));
  el('restore').onclick=()=>action(()=>loadOrder(el('restoreId').value.trim()));
  el('finish').onclick=()=>action(async()=>{if(order&&terminal(order)){order=null;pendingHash='';attempted=false;stash();el('hash').value='';await syncSale();notice('');}});
  for(const id of ['gpu','amount','network']) el(id).addEventListener('input',render);
  if(window.ethereum?.on) {
    window.ethereum.on('accountsChanged',a=>{payer=a?.[0]?.toLowerCase()||'';render();});
    window.ethereum.on('chainChanged',()=>{payer='';render();});
  }
  async function poll() {
    if(busy||timerBusy||document.hidden) return;
    timerBusy=true;
    try {if(order) await loadOrder(order.id);await syncSale();}catch(e){notice(errorKey(e));}
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
    if(/^[a-f0-9]{64}$/.test(prefill||'')) el('gpu').value=prefill;
    let stored;
    try {stored=JSON.parse(localStorage.getItem(storageKey));}catch {}
    if(stored?.id && idValid(stored.id)) {
      el('restoreId').value=stored.id;
      pendingHash=hashValid(stored.hash)?stored.hash:'';
      attempted=stored.attempted===true || !!pendingHash;
      try {await loadOrder(stored.id);}catch(e){notice(errorKey(e));}
    }
    await poll();setInterval(poll,15000);document.addEventListener('visibilitychange',poll);
  })();
}

export function checkoutScript() {
  const js='('+checkout.toString()+')('+JSON.stringify(SALE_CONFIG)+', '+paymentMessage.toString()+', '+transferData.toString()+','+JSON.stringify(storeLocales)+','+JSON.stringify(storeMessages)+');';
  return new Response(js,{headers:{'content-type':'text/javascript; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
