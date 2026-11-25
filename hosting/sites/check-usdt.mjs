import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { checkPayment, checkRpcHealth, findQuotePayment, MERCHANT, NETWORKS, quoteMessage,
  transferData, verifyClaimSignature, verifyQuoteSignature } from './usdt.mjs';
import { checkoutPage, checkoutScript } from './checkout.mjs';
import { storeLocales,storeMessages } from './store-i18n.mjs';
import { ledgerPage,ledgerScript } from './ledger-page.mjs';

const artifactPath=process.env.GPUCHAIN_WORKER_ARTIFACT;
const artifact=artifactPath?(await import(pathToFileURL(artifactPath))).default:null;
const asset=path=>artifact?artifact.fetch(new Request('https://store.invalid'+path),{}):
  (path==='/'?checkoutPage():checkoutScript());

const secret=new Uint8Array(32);secret[31]=1; // published test scalar, never funded
const payer='0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const rpcUrls=['https://first.invalid','https://second.invalid'];
const topic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const time=1_700_000_000;
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
function fixture(chainId,signText=quoteMessage) {
  const claim={chainId,payer,gpuAddress:'a'.repeat(64),amountMicro:'1234567',
    requestId:'e'.repeat(32),issuedAt:time*1000,orderId:'order-public-123456',txHash:word(800),
    createdAt:time*1000,expiresAt:(time+1800)*1000,startBlock:'25'};
  const bytes=utf8ToBytes(signText(claim));
  const digest=keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n'+bytes.length),bytes));
  const sig=secp256k1.sign(digest,secret,{format:'recovered',prehash:false});
  claim.signature='0x'+bytesToHex(sig.slice(1))+(sig[0]+27).toString(16);
  const asset=NETWORKS[chainId], blockHash=word(1000), number='0x20';
  const tx={from:payer,to:asset.token,hash:claim.txHash,blockNumber:number,blockHash,value:'0x0',
    input:transferData(claim.amountMicro,asset.decimals,MERCHANT)};
  const event={address:asset.token,blockHash,blockNumber:number,transactionHash:claim.txHash,removed:false,logIndex:'0x3',
    topics:[topic,'0x'+payer.slice(2).padStart(64,'0'),'0x'+MERCHANT.slice(2).padStart(64,'0')],data:'0x'+tx.input.slice(-64)};
  const receipt={from:payer,to:asset.token,status:'0x1',transactionHash:claim.txHash,blockNumber:number,
    blockHash,logs:[event]};
  const rpc=(change=()=>{})=>async (url,init)=>{
    assert.equal(init.redirect,'manual');
    assert.equal(init.method,'POST');
    const {id,method,params}=JSON.parse(init.body);
    let result;
    if(method==='eth_chainId') result='0x'+chainId.toString(16);
    else if(method==='eth_getTransactionByHash') result=structuredClone(tx);
    else if(method==='eth_getTransactionReceipt') result=structuredClone(receipt);
    else if(method==='eth_call') result=word(asset.decimals);
    else if(method==='eth_getLogs') {
      const q=params[0];
      assert.equal(q.address,asset.token);
      result=BigInt(q.fromBlock)<=32n && BigInt(q.toBlock)>=32n ? [structuredClone(event)] : [];
    } else if(method==='eth_getBlockByNumber') {
      const n=params[0]==='finalized'?40n:BigInt(params[0]);
      result={hash:n===32n?blockHash:word(n),number:'0x'+n.toString(16),transactions:n===32n?[claim.txHash]:[],
        timestamp:'0x'+(time+(n===32n?15:1830)).toString(16)};
    } else assert.fail('Unexpected method '+method);
    const replaced=change(method,result,url);
    return Response.json({jsonrpc:'2.0',id,result:replaced===undefined?result:replaced});
  };
  return {claim,rpc};
}

for (const id of [1,56]) {
  test('paid quote and independent finalized scanning on chain '+id,async()=>{
    const {claim,rpc}=fixture(id),options={rpcUrls,fetcher:rpc(),minBlock:'25'};
    assert.equal(await verifyQuoteSignature(claim),payer);
    assert.match(quoteMessage(claim),/Price: 1 USDT = 10 GPUChain coins\nGPUChain nanocoins to receive: 12345670000\n/);
    assert.equal(await verifyClaimSignature(claim),payer);
    const pay=await checkPayment(claim,options);
    assert.equal(pay.eventId,'eip155:'+id+':'+claim.txHash+':3');
    assert.equal(pay.amountMicro,'1234567');assert.equal(pay.to,claim.gpuAddress);
    assert.equal(pay.blockTimestamp,String(time+15));
    const page=await findQuotePayment(claim,options);
    assert.equal(page.complete,true);assert.equal(page.nextBlock,'41');
    assert.deepEqual(page.matches,[pay]);
    const sent=BigInt('0x'+transferData('1234567',NETWORKS[id].decimals,MERCHANT).slice(-64));
    assert.equal(sent,id===1?1234567n:1234567000000000000n);
  });
}

test('legacy price signatures and amounts exceeding the reserve at ten coins per USDT are rejected',async()=>{
  const legacy=q=>quoteMessage(q).replace('quote v2','quote v1')
    .split('\n').filter(line=>!line.startsWith('Price:')&&!line.startsWith('GPUChain nanocoins to receive:')).join('\n');
  const splitPrice=q=>quoteMessage(q).replace('1 USDT = 10 GPUChain coins','1 USDT = 1 GPUChain coin');
  await assert.rejects(verifyQuoteSignature(fixture(1,legacy).claim),/signature/i);
  await assert.rejects(verifyQuoteSignature(fixture(56,splitPrice).claim),/signature/i);
  await assert.rejects(verifyQuoteSignature({...fixture(1).claim,amountMicro:'100000000000000001'}),/amount/);
});

test('a captured quote cannot change the payer, recipient, amount, chain or order nonce',async()=>{
  const {claim,rpc}=fixture(1);
  for(const mod of [{payer:'0x'+'0'.repeat(40)},{gpuAddress:'b'.repeat(64)},{amountMicro:'1'},
    {chainId:56},{requestId:'f'.repeat(32)},{issuedAt:claim.issuedAt+1}]) {
    await assert.rejects(checkPayment({...claim,...mod},{rpcUrls,fetcher:rpc(),minBlock:'25'}),/signature|payer/i);
  }
});

test('indirect, counterfeit, reverted, orphaned and ambiguous transfers cannot earn credit',async()=>{
  const {claim,rpc}=fixture(1);
  const changes=[
    (m,r)=>{if(m==='eth_getTransactionByHash')r.input='0x';},
    (m,r)=>{if(m==='eth_getTransactionByHash')r.from=MERCHANT;},
    (m,r)=>{if(m==='eth_getTransactionReceipt')r.status='0x0';},
    (m,r)=>{if(m==='eth_getTransactionReceipt')r.logs[0].address=MERCHANT;},
    (m,r)=>{if(m==='eth_getTransactionReceipt')r.logs[0].topics[2]=word(1);},
    (m,r)=>{if(m==='eth_getTransactionReceipt')r.logs[0].removed=true;},
    (m,r)=>{if(m==='eth_getTransactionReceipt')r.logs[0].data=word(1);},
    (m,r)=>{if(m==='eth_getTransactionReceipt')r.logs.push(r.logs[0]);},
    (m,r)=>{if(m==='eth_getTransactionReceipt')r.blockHash=word(1);},
    (m,r)=>{if(m==='eth_getBlockByNumber')r.transactions=[];},
    (m,r,url)=>{if(m==='eth_getTransactionReceipt' && url===rpcUrls[1])r.logs[0].logIndex='0x4';}
  ];
  for(const change of changes) await assert.rejects(checkPayment(claim,{rpcUrls,fetcher:rpc(change),minBlock:0}));
  await assert.rejects(checkPayment(claim,{rpcUrls,fetcher:rpc(),minBlock:33}),/predates/);
  await assert.rejects(checkPayment(claim,{rpcUrls,fetcher:rpc((m,r)=>m==='eth_getTransactionReceipt'?null:r),minBlock:0}),
    err=>err.status===425);
  await assert.rejects(checkPayment(claim,{rpcUrls,fetcher:rpc((m,r)=>{
    if(m==='eth_getBlockByNumber'&&r.number==='0x28')r.number='0x1f';
  }),minBlock:0}),err=>err.status===425);
});

test('scan disagreements do not clear the inventory reservation or advance its cursor',async()=>{
  const {claim,rpc}=fixture(56);
  const fetcher=rpc((m,r,url)=>m==='eth_getLogs'&&url===rpcUrls[1]?[]:r);
  await assert.rejects(findQuotePayment(claim,{rpcUrls,fetcher}),/disagree/);
  await assert.rejects(checkRpcHealth(56,{rpcUrls:[rpcUrls[0],rpcUrls[0]+'/alias'],fetcher:rpc()}),/Independent/);
  await assert.rejects(checkRpcHealth(56,{rpcUrls,fetcher:rpc((m,r)=>m==='eth_chainId'?'0x1':r)}),/chain mismatch/);
  const expired={...claim,expiresAt:claim.issuedAt+2000000};
  await assert.rejects(findQuotePayment(expired,{rpcUrls,fetcher:rpc()}),/window/);
});

test('public checkout uses a same-origin script and explicit user wallet actions',async()=>{
  const page=await asset('/'),html=await page.text(),script=await (await asset('/buy.js')).text();
  assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  assert.match(html,/<html lang="en">/);assert.match(html,/Claim free inference coins/);
  assert.doesNotMatch(html,/1,000 free inference coins|Claim 100 starter coins/);
  assert.match(html,/USDT payments temporarily paused/);
  for(const lang of storeLocales)assert.ok(html.includes('value="'+lang+'"'));
  for(const key of Object.keys(storeMessages)){
    const values=storeMessages[key];assert.equal(values.length,5,key);
    const vars=s=>s.match(/\{\w+\}/g)?.sort() ?? [];
    for(const v of values){assert.ok(v.length>0,key);assert.deepEqual(vars(v),vars(values[0]),key);}
  }
  assert.match(html,/src="\/buy.js"/);assert.match(html,/href="\/ledger"/);
  assert.doesNotMatch(script,/personal_sign|eth_sendTransaction|eth_requestAccounts|\/v1\/sales\/quote/);
  assert.doesNotMatch(html,/id="(?:pay|merchant|connect|reserve)"/);
  assert.doesNotThrow(()=>new vm.Script(script));
});

test('ledger localizes the stage and the authority independently and shares the checkout language choice',async()=>{
  const s={networkStage:'mainnet',height:1203,epoch:0,epochTokens:0,providers:[],chainId:'0'.repeat(64)};
  const html=await ledgerPage(s,false).text();
  assert.match(html,/data-i18n="mainnet">Mainnet/);assert.match(html,/data-i18n="bootstrap">Bootstrap sequencer/);
  assert.match(html,/href="\/"/);assert.match(html,/src="\/ledger.js"/);
  const script=artifact?await (await artifact.fetch(new Request('https://store.invalid/ledger.js'),{})).text():await ledgerScript().text();
  const saved=new Map([['gpuchain.wallet.language','fr']]),root={},stage={dataset:{i18n:'mainnet'}},height={dataset:{count:'1203'}};
  const select={addEventListener(_,fn){this.change=fn;}};
  vm.runInNewContext(script,{document:{documentElement:root,getElementById:()=>select,
    querySelectorAll:q=>q==='[data-i18n]'?[stage]:[height]},
    localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)}});
  assert.equal(root.lang,'fr');assert.equal(stage.textContent,'Réseau principal');
  for(const lng of storeLocales){select.value=lng;select.change();assert.equal(root.lang,lng);
    assert.equal(saved.get('gpuchain.wallet.language'),lng);assert.equal(height.textContent,BigInt(1203).toLocaleString(lng));}
});

async function openCreditPage(fetcher,{saved=new Map(),search=''}={}) {
  const fields=new Map(), root={}, nodes=['starterTitle','salesPaused'].map(i18n=>({dataset:{i18n}}));
  const get=id=>{
    if(!fields.has(id)) fields.set(id,{value:'',events:{},addEventListener(type,fn){this.events[type]=fn;}});
    return fields.get(id);
  };
  vm.runInNewContext(await (await asset('/buy.js')).text(),{
    document:{documentElement:root,getElementById:get,querySelectorAll:()=>nodes,addEventListener(){}},
    location:{search},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
    fetch:fetcher,URLSearchParams,AbortSignal,Date,setInterval:()=>{}
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {get,root,nodes};
}

test('starter form verifies existing addresses, excludes stale lookups and submits only one explicit claim',async()=>{
  const old='1'.repeat(64), address='a'.repeat(64), unknown='b'.repeat(64);
  const prior=Promise.withResolvers(), pending=Promise.withResolvers(), claims=[];
  const eligible={coins:'1000',active:true,eligible:true,canClaim:true,claimed:false,remainingClaims:1_000_000};
  const {get,root,nodes}=await openCreditPage(async(path,{method,body})=>{
    if(method==='GET') {
      const a=new URL(path,'https://local.invalid').searchParams.get('address');
      if(a===old) await prior.promise;
      return Response.json({address:a,...eligible,...(a===unknown||a===old?
        {eligible:false,canClaim:false,reason:'wallet_not_recorded'}:{})});
    }
    assert.equal(path,'/v1/starter/claim');
    claims.push(JSON.parse(body));await pending.promise;
    return Response.json({address,coins:'1000',claimed:true,alreadyClaimed:false});
  });
  const input=get('starterAddress'), claim=get('starterClaim'), status=get('starterStatus');
  assert.equal(claim.disabled,true);
  input.value='INVALID';await input.events.input();
  assert.equal(status.textContent,storeMessages.gpuInvalid[0]);
  input.value=old;const oldLookup=input.events.input();
  input.value=address.toUpperCase();await input.events.input();prior.resolve();await oldLookup;
  assert.equal(claim.disabled,false); assert.deepEqual(claims,[]);
  for(const [index,lang] of storeLocales.entries()) {
    get('language').events.change({target:{value:lang}});
    assert.equal(root.lang,lang);assert.equal(nodes[1].textContent,storeMessages.salesPaused[index]);
    const formatted=(1000).toLocaleString(lang);
    assert.equal(status.textContent,storeMessages.starterEligible[index].replace('{coins}',formatted));
    assert.equal(claim.textContent,storeMessages.starterClaimAmount[index].replace('{coins}',formatted));
  }
  const first=claim.onclick();await claim.onclick();
  assert.equal(claim.disabled,true);assert.deepEqual(claims,[{address}]);
  pending.resolve();await first;
  assert.equal(claim.disabled,true);assert.equal(status.textContent,storeMessages.starterDone[4].replace('{coins}',(1000).toLocaleString('fr')));
  input.value=unknown;await input.events.input();await claim.onclick();
  assert.equal(status.textContent,storeMessages.starterUnknown[4]);assert.deepEqual(claims,[{address}]);
});

test('starter form reports failures and rechecks the ledger after an uncertain claim without posting twice',async()=>{
  const address='c'.repeat(64);
  let mode='offline',posts=0;
  const {get}=await openCreditPage(async(path,{method})=>{
    if(method==='GET'){
      if(mode==='offline') return Response.json({error:'unavailable'},{status:503});
      return Response.json({address,active:mode!=='closed',eligible:true,canClaim:mode==='ready',
        coins:mode==='closed'?null:'1000',claimed:mode==='done',claimedCoins:mode==='done'?'1000':null,
        remainingClaims:mode==='closed'?0:5});
    }
    posts++;mode='done';throw Error('Delivery reply lost');
  },{search:'?gpuAddress='+address});
  assert.equal(get('starterStatus').textContent,storeMessages.starterUnavailable[0]);
  mode='closed';await get('starterCheck').onclick();
  assert.equal(get('starterStatus').textContent,storeMessages.starterClosed[0]);
  mode='ready';await get('starterCheck').onclick();await get('starterClaim').onclick();
  assert.equal(get('starterStatus').textContent,storeMessages.starterUnconfirmed[0]);
  assert.equal(get('starterClaim').disabled,true);await get('starterCheck').onclick();
  assert.equal(get('starterStatus').textContent,storeMessages.starterAlready[0].replace('{coins}','1,000'));assert.equal(posts,1);
});

test('the page displays the authorized amount only after activation and retains each historical payout',async()=>{
  const address='d'.repeat(64);
  let upgraded=false, historical=false;
  const {get}=await openCreditPage(async(path,{method})=>{
    assert.equal(method,'GET');
    return Response.json({address:path.includes('?')?address:null,
      active:upgraded,coins:upgraded?'1000':null,eligible:true,
      claimed:historical,claimedCoins:historical?'100':null,
      canClaim:upgraded && !historical,remainingClaims:upgraded?10:0,reason:upgraded?null:'program_updating'});
  });
  const heading=get('starterHeading'),claim=get('starterClaim'),status=get('starterStatus');
  assert.equal(heading.textContent,storeMessages.starterTitle[0]);
  assert.equal(claim.disabled,true);assert.equal(status.textContent,storeMessages.starterUpdating[0]);
  get('starterAddress').value=address;await get('starterCheck').onclick();
  assert.equal(claim.disabled,true);
  upgraded=true;await get('starterCheck').onclick();
  assert.equal(heading.textContent,'Claim 1,000 free inference coins');
  assert.equal(claim.disabled,false);
  historical=true;await get('starterCheck').onclick();
  assert.equal(claim.disabled,true);assert.equal(status.textContent,storeMessages.starterAlready[0].replace('{coins}','100'));
});

test('suspended checkout can recover existing orders and verify an already sent transfer without requesting a payment',async()=>{
  const id='e'.repeat(64),txHash='0x'+'d'.repeat(64),gpuAddress='a'.repeat(64),requests=[];
  let status='reserved';
  const {get}=await openCreditPage(async(path,{method,body})=>{
    if(path==='/v1/starter/status') return Response.json({active:false,coins:null,reason:'program_inactive'});
    requests.push([method,path]);
    if(method==='POST') {
      assert.equal(path,'/v1/sales/claim');assert.deepEqual(JSON.parse(body),{orderId:id,txHash});
      status='delivered';
    } else assert.equal(path,'/v1/sales/orders/'+id);
    return Response.json({id,status,chainId:56,payer,gpuAddress,amountMicro:'1000000',amountNano:'10000000000',
      expiresAt:time*1000,txHash:status==='delivered'?txHash:null});
  });
  get('restoreId').value=id;await get('restore').onclick();
  assert.equal(get('orderId').textContent,id);assert.equal(get('orderStatus').textContent,storeMessages.unpaidPaused[0]);
  get('hash').value=txHash;await get('submitHash').onclick();
  assert.equal(get('hashCheck').hidden,true);assert.match(get('orderStatus').textContent,/Delivered/);
  assert.deepEqual(requests.map(([verb])=>verb),['GET','POST','GET']);
});
