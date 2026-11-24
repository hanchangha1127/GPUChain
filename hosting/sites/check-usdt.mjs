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
  assert.match(html,/<html lang="en">/);assert.match(html,/1 USDT buys 10 GPUChain coins/);
  assert.match(html,/Payment amount \(USDT\)/);
  for(const lang of storeLocales)assert.ok(html.includes('value="'+lang+'"'));
  for(const key of Object.keys(storeMessages)){
    const values=storeMessages[key];assert.equal(values.length,5,key);
    const vars=s=>s.match(/\{\w+\}/g)?.sort() ?? [];
    for(const v of values){assert.ok(v.length>0,key);assert.deepEqual(vars(v),vars(values[0]),key);}
  }
  assert.match(html,/src="\/buy.js"/);assert.match(html,/href="\/ledger"/);
  assert.match(script,/personal_sign/);assert.match(script,/eth_sendTransaction/);
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

test('checkout shows ten coins for one USDT and transfers only the quoted USDT on either network',async()=>{
  for(const id of [1,56]){
    const {claim}=fixture(id), fields=new Map(), calls=[];
    const get=key=>{
      if(!fields.has(key)) fields.set(key,{value:'',events:{},addEventListener(type,cb){this.events[type]=cb;}});
      return fields.get(key);
    };
    get('network').value=String(id);get('amount').value='1';
    let order,remaining='10000000000';
    const networkStatus={accepting:true,paymentReady:true};
    const fetcher=async(path,options)=>{
      const input=options.body && JSON.parse(options.body);
      if(path==='/v1/sales/status') return Response.json({accepting:true,coinsPerUsdt:10,
        maxOrderMicro:'10000000',inventoryNano:remaining,networks:{[id]:networkStatus}});
      if(path==='/v1/sales/quote') {
        order={...input,id:'a'.repeat(64),status:'reserved',coinsPerUsdt:10,amountNano:remaining,expiresAt:Date.now()+60000};
        remaining='0';networkStatus.accepting=false;
      } else if(path==='/v1/sales/claim') {
        assert.equal(input.orderId,order.id);assert.equal(input.txHash,claim.txHash);calls.push('claim');order.status='delivered';
      }
      return Response.json(order);
    };
    const ethereum={async request({method,params}) {
      if(method==='eth_chainId') return '0x'+id.toString(16);
      if(method==='eth_accounts'||method==='eth_requestAccounts') return [payer];
      calls.push(method);
      if(method==='personal_sign'){
        const signed=Buffer.from(params[0].slice(2),'hex').toString('utf8');
        assert.match(signed,/USDT micro-units: 1000000\nPrice: 1 USDT = 10 GPUChain coins\nGPUChain nanocoins to receive: 10000000000/);
        return claim.signature;
      }
      assert.equal(method,'eth_sendTransaction');
      assert.equal(params[0].data,transferData('1000000',NETWORKS[id].decimals,MERCHANT));
      return claim.txHash;
    }};
    const saved=new Map(id===56?[['gpuchain.wallet.language','ja']]:[]),root={lang:'en'},node={dataset:{i18n:'signFirst'}};
    vm.runInNewContext(await (await asset('/buy.js')).text(),{document:{documentElement:root,getElementById:get,querySelectorAll(){return [node];},addEventListener(){}},window:{ethereum},
      location:{search:'?gpuAddress='+claim.gpuAddress},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
      fetch:fetcher,URLSearchParams,AbortSignal,Date,TextEncoder,crypto:globalThis.crypto,setInterval:()=>{}});
    await new Promise(r=>setImmediate(r));
    assert.equal(root.lang,id===56?'ja':'en');
    for(const [i,lng] of storeLocales.entries()){
      get('language').events.change({target:{value:lng}});
      assert.equal(root.lang,lng);assert.equal(saved.get('gpuchain.wallet.language'),lng);
      assert.equal(node.textContent,storeMessages.signFirst[i]);
      assert.equal(get('gpu').placeholder,storeMessages.gpuHint[i]);
      assert.ok(get('cost').textContent.includes('10'));
    }
    get('amount').value='1,25';get('amount').events.input();
    assert.match(get('cost').textContent,/12,5 coins GPUChain/);
    get('language').events.change({target:{value:'ko'}});
    assert.equal(get('amount').value,'1.25');assert.match(get('cost').textContent,/12\.5 GPUChain 코인/);
    get('amount').value='1';get('amount').events.input();
    await get('connect').onclick();await get('reserve').onclick();
    assert.equal(get('orderId').textContent,'a'.repeat(64));
    assert.match(get('terms').textContent,/결제 1 USDT · 받을 금액 10 GPUChain 코인/);
    await get('pay').onclick();
    assert.deepEqual(calls,['personal_sign','eth_sendTransaction','claim']);
    await get('pay').onclick();
    assert.equal(calls.length,3);
  }
});
