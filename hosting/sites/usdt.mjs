// Settlement is scoped to the designated GPUChain public genesis and the two
// selected USDT contracts. Normal GPUChain participants do not import this module.
import { DISTRIBUTION_RESERVE } from '../../src/ledger.mjs';
import { RESERVE_NANOCOINS } from '../../src/amount.mjs';
import { SALE_MERCHANT, SALE_TOKENS, SALE_COINS_PER_USDT, SALE_NANO_PER_MICRO,
  SALE_PRICE_TERMS, SALE_PRICE_COINS_PER_USDT, SALE_PRICE_NANO_PER_MICRO } from '../../src/sale-policy.mjs';

export const MERCHANT = SALE_MERCHANT;
export const NETWORKS = Object.freeze({
  1:Object.freeze({name:'Ethereum',symbol:'ETH',token:SALE_TOKENS[1],decimals:6}),
  56:Object.freeze({name:'BNB Smart Chain',symbol:'BNB',token:SALE_TOKENS[56],decimals:18})
});
export const SALE_CONFIG = Object.freeze({merchant:MERCHANT,networks:NETWORKS,genesis:DISTRIBUTION_RESERVE.chainId,
  quoteVersion:3,coinsPerUsdt:SALE_PRICE_COINS_PER_USDT,nanoPerMicro:SALE_PRICE_NANO_PER_MICRO.toString()});
const originalConfig=Object.freeze({...SALE_CONFIG,quoteVersion:2,coinsPerUsdt:SALE_COINS_PER_USDT,
  nanoPerMicro:SALE_NANO_PER_MICRO.toString()});
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const evmAddress = /^0x[0-9a-f]{40}$/;
const txHash = /^0x[0-9a-f]{64}$/;
const gpuAddress = /^[0-9a-f]{64}$/;
const micro = /^[1-9][0-9]{0,18}$/;
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
function requireThat(condition,status,message) {
  if (!condition) throw Object.assign(Error(message),{status});
}
function network(id) {
  requireThat(id === 1 || id === 56,400,'Unsupported payment network');
  return NETWORKS[id];
}

// This pure formatter is also embedded verbatim in the checkout browser code.
// EIP-191 personal_sign signs its UTF-8 bytes; no token allowance is requested.
export function paymentMessage(input, config) {
  const delivery=(BigInt(input.amountMicro)*BigInt(config.nanoPerMicro)).toString();
  return [
    'GPUChain USDT purchase quote v'+config.quoteVersion,
    'GPUChain genesis: '+config.genesis, 'EVM chain ID: '+input.chainId,
    'USDT contract: '+config.networks[input.chainId].token, 'Merchant: '+config.merchant,
    'Payer: '+input.payer, 'GPUChain recipient: '+input.gpuAddress, 'USDT micro-units: '+input.amountMicro,
    'Price: 1 USDT = '+config.coinsPerUsdt+' GPUChain coins', 'GPUChain nanocoins to receive: '+delivery,
    'Request ID: '+input.requestId,'Issued at (Unix ms): '+input.issuedAt,
    'Pay before (Unix ms): '+(input.issuedAt+1800000)
  ].join('\n');
}
function orderConfig(order) {
  if (!Object.hasOwn(order,'terms')) return originalConfig;
  requireThat(order.terms===SALE_PRICE_TERMS,400,'Invalid purchase price terms');
  return SALE_CONFIG;
}
export const quoteMessage = q => paymentMessage(q,orderConfig(q));

export function transferData(amountMicro, decimals, merchant) {
  const units = BigInt(amountMicro)*10n**BigInt(decimals-6);
  return '0xa9059cbb'+merchant.slice(2).padStart(64,'0')+units.toString(16).padStart(64,'0');
}

async function signed(input,kind) {
  requireThat(input && typeof input === 'object',400,'Expected a purchase request');
  network(input.chainId);
  const config=orderConfig(input);
  if (kind==='quote') requireThat(config===SALE_CONFIG,400,'New quotes require the current signed price terms');
  const maxMicro=BigInt(RESERVE_NANOCOINS)/BigInt(config.nanoPerMicro);
  requireThat(typeof input.payer === 'string' && evmAddress.test(input.payer) && input.payer !== MERCHANT &&
    typeof input.gpuAddress === 'string' && gpuAddress.test(input.gpuAddress) &&
    typeof input.amountMicro === 'string' && micro.test(input.amountMicro) && BigInt(input.amountMicro)<=maxMicro &&
    /^0x[0-9a-fA-F]{130}$/.test(input.signature),400,'Invalid payer, recipient, amount or signature');
  requireThat(typeof input.requestId === 'string' && /^[0-9a-f]{32}$/.test(input.requestId) &&
    Number.isSafeInteger(input.issuedAt) && input.issuedAt>0 && Number.isSafeInteger(input.issuedAt+1800000),
    400,'Invalid quote request ID or issuance time');
  if (kind === 'claim') {
    requireThat(typeof input.orderId === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(input.orderId) &&
      typeof input.txHash === 'string' && txHash.test(input.txHash),400,'Invalid order or transaction ID');
  }
  const [{secp256k1},{keccak_256},{bytesToHex,hexToBytes,concatBytes,utf8ToBytes}] = await Promise.all([
    import('@noble/curves/secp256k1.js'),import('@noble/hashes/sha3.js'),import('@noble/hashes/utils.js')
  ]);
  const bytes = utf8ToBytes(paymentMessage(input,config));
  const digest = keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n'+bytes.length),bytes));
  const sig = hexToBytes(input.signature.slice(2));
  const v = sig[64]>=27 ? sig[64]-27 : sig[64];
  requireThat(v===0 || v===1,400,'Invalid signature recovery bit');
  let payer;
  try {
    const sigObject = secp256k1.Signature.fromBytes(concatBytes(Uint8Array.of(v),sig.slice(0,64)),'recovered');
    if (sigObject.hasHighS()) throw Error();
    const pub = sigObject.recoverPublicKey(digest).toBytes(false).slice(1);
    payer = '0x'+bytesToHex(keccak_256(pub).slice(-20));
  } catch { requireThat(false,400,'Invalid payer signature'); }
  requireThat(payer===input.payer,400,'The signature does not match the paying account');
  return payer;
}
export const verifyQuoteSignature = q => signed(q,'quote');
export const verifyClaimSignature = c => signed(c,'claim');

function trustedPair(rpcUrls) {
  requireThat(Array.isArray(rpcUrls) && rpcUrls.length===2,503,'Two RPC providers are required');
  const origins = rpcUrls.map(value=>{
    let parsed;
    try { parsed = new URL(value); } catch { requireThat(false,503,'Invalid RPC configuration'); }
    requireThat(parsed.protocol === 'https:' && !parsed.password && !parsed.username && !parsed.hash,
      503,'RPC providers must use HTTPS');
    return parsed.hostname.toLowerCase().replace(/\.$/,'');
  });
  requireThat(origins[0]!==origins[1],503,'Independent RPC provider hostnames are required');
  return rpcUrls;
}
async function rpc(url,method,params,fetcher) {
  try {
    const res = await fetcher(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(9000),
      headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if (!res.ok || !res.body) throw Error();
    const reader = res.body.getReader();
    let size=0;
    const chunks=[];
    try {
      for (;;) {
        const {value,done} = await reader.read();
        if (done) break;
        size+=value.byteLength;
        if (size>4*1024*1024) {await reader.cancel();throw Error();}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    const arr=new Uint8Array(size);
    let pos=0;
    for(const chunk of chunks) {arr.set(chunk,pos);pos+=chunk.length;}
    const j=JSON.parse(new TextDecoder().decode(arr));
    if(j.jsonrpc!=='2.0'||j.id!==1||j.error||!Object.hasOwn(j,'result')) throw Error();
    return j.result;
  } catch { requireThat(false,503,'Payment node is unavailable; retry verification'); }
}
function qHex(value) {
  requireThat(typeof value==='string' && quantity.test(value),503,'Invalid chain quantity from payment node');
  return BigInt(value);
}
function parseBlock(b) {
  requireThat(b && txHash.test(b.hash),503,'Finalized block information unavailable');
  return {number:qHex(b.number),hash:b.hash,timestamp:qHex(b.timestamp)};
}
async function finalized(url,chainId,fetcher) {
  const chain = await rpc(url,'eth_chainId',[],fetcher);
  requireThat(qHex(chain)===BigInt(chainId),503,'Payment RPC chain mismatch');
  return parseBlock(await rpc(url,'eth_getBlockByNumber',['finalized',false],fetcher));
}
export async function checkRpcHealth(chainId,{rpcUrls,fetcher=fetch}={}) {
  const asset=network(chainId);
  const urls=trustedPair(rpcUrls);
  const tips=await Promise.all(urls.map(url=>finalized(url,chainId,fetcher)));
  const lower=tips[0].number<=tips[1].number?tips[0]:tips[1];
  const number='0x'+lower.number.toString(16);
  await Promise.all(urls.map(async url=>{
    const [raw,decimals,logs]=await Promise.all([
      rpc(url,'eth_getBlockByNumber',[number,false],fetcher),
      rpc(url,'eth_call',[{to:asset.token,data:'0x313ce567'},number],fetcher),
      rpc(url,'eth_getLogs',[{address:asset.token,fromBlock:number,toBlock:number,
        topics:[transferTopic,null,'0x'+MERCHANT.slice(2).padStart(64,'0')]}],fetcher)
    ]);
    const b=parseBlock(raw);
    requireThat(Array.isArray(logs) && b.number===lower.number && b.hash===lower.hash && b.timestamp===lower.timestamp &&
      /^0x[0-9a-fA-F]{64}$/.test(decimals) && BigInt(decimals)===BigInt(asset.decimals),
    503,'Payment nodes disagree on the finalized chain or USDT contract');
  }));
  return {chainId,blockNumber:lower.number.toString(),blockHash:lower.hash,blockTimestamp:lower.timestamp.toString()};
}
async function observe(claim,url,minBlock,fetcher) {
  const asset=network(claim.chainId);
  const tip=await finalized(url,claim.chainId,fetcher);
  const [tx,receipt]=await Promise.all([rpc(url,'eth_getTransactionByHash',[claim.txHash],fetcher),
    rpc(url,'eth_getTransactionReceipt',[claim.txHash],fetcher)]);
  requireThat(tx && receipt && receipt.blockNumber!=null,425,'Waiting for the payment receipt');
  const height=qHex(receipt.blockNumber);
  requireThat(height>=minBlock,409,'Payment predates this sale or quote');
  requireThat(tip.number>=height,425,'Waiting for finalized payment');
  requireThat(receipt.status==='0x1',409,'USDT transfer execution failed');
  const input=transferData(claim.amountMicro,asset.decimals,MERCHANT);
  requireThat(tx.hash===claim.txHash && receipt.transactionHash===claim.txHash &&
    tx.to?.toLowerCase()===asset.token && tx.from?.toLowerCase()===claim.payer &&
    receipt.to?.toLowerCase()===asset.token && receipt.from?.toLowerCase()===claim.payer &&
    qHex(tx.value)===0n && tx.input?.toLowerCase()===input && Array.isArray(receipt.logs),
  409,'Expected a direct USDT transfer for the signed order');
  const raw=await rpc(url,'eth_getBlockByNumber',[receipt.blockNumber,false],fetcher);
  const canonical=parseBlock(raw);
  requireThat(tx.blockHash===canonical.hash && receipt.blockHash===canonical.hash &&
    canonical.number===height && qHex(tx.blockNumber)===height && Array.isArray(raw.transactions) &&
    raw.transactions.includes(claim.txHash),503,'Payment is not in the canonical finalized block');
  const transfers=receipt.logs.filter(l=>l?.address?.toLowerCase()===asset.token && l.topics?.[0]===transferTopic);
  requireThat(transfers.length===1,409,'Expected one USDT Transfer event');
  const log=transfers[0];
  const topic = a=>'0x'+a.slice(2).padStart(64,'0');
  requireThat(log.removed!==true && log.transactionHash===claim.txHash && log.blockHash===canonical.hash &&
    qHex(log.blockNumber)===height && log.topics.length===3 && log.topics[1]?.toLowerCase()===topic(claim.payer) &&
    log.topics[2]?.toLowerCase()===topic(MERCHANT) && log.data?.toLowerCase()==='0x'+input.slice(-64),
  409,'Transfer event does not match the order amount, payer or merchant');
  const logIndex=qHex(log.logIndex).toString();
  return {chainId:claim.chainId,eventId:'eip155:'+claim.chainId+':'+claim.txHash+':'+logIndex,txHash:claim.txHash,
    logIndex,payer:claim.payer,to:claim.gpuAddress,amountMicro:claim.amountMicro,blockNumber:height.toString(),
    merchant:MERCHANT,blockHash:canonical.hash,blockTimestamp:canonical.timestamp.toString()};
}
export async function checkPayment(claim,{rpcUrls,fetcher=fetch,minBlock}={}) {
  await verifyClaimSignature(claim);
  requireThat(minBlock!==undefined && /^(?:0|[1-9][0-9]{0,19})$/.test(String(minBlock)),503,'Missing sale start block');
  const observations=await Promise.allSettled(trustedPair(rpcUrls).map(url=>observe(claim,url,BigInt(minBlock),fetcher)));
  const failures=observations.filter(result=>result.status==='rejected');
  if (failures.length) {
    if (failures.length===2 && failures[0].reason?.status===failures[1].reason?.status) throw failures[0].reason;
    requireThat(false,503,'Payment nodes have not agreed on a finalized transfer');
  }
  const [a,b]=observations.map(r=>r.value);
  requireThat(JSON.stringify(a)===JSON.stringify(b),503,'Payment nodes disagree on the receipt');
  return a;
}

// Each page is cursor-based and bounded. A caller persists nextBlock only after
// processing all returned matches; faults/disagreement never advance the cursor.
export async function findQuotePayment(order,{rpcUrls,fetcher=fetch,fromBlock,minBlock=order.startBlock}={}) {
  await signed(order,'stored-quote');
  const id=order.orderId ?? order.id;
  requireThat(typeof id==='string' && /^[a-zA-Z0-9_-]{16,128}$/.test(id) &&
    Number.isSafeInteger(order.createdAt) && Number.isSafeInteger(order.expiresAt) &&
    order.expiresAt>=order.createdAt && order.expiresAt<=order.issuedAt+1800000,
  400,'Invalid quote monitoring window');
  const checkHeight=value=>{
    requireThat(/^(0|[1-9][0-9]{0,19})$/.test(String(value)),503,'Invalid quote scan height');
    return BigInt(value);
  };
  const floor=checkHeight(minBlock), start=checkHeight(order.startBlock);
  const low=checkHeight(fromBlock??order.startBlock);
  requireThat(low>=floor && low>=start,503,'Invalid scan cursor');
  const head=await checkRpcHealth(order.chainId,{rpcUrls,fetcher});
  if(low>BigInt(head.blockNumber)) {
    return {matches:[],nextBlock:low.toString(),complete:false,hasMoreFinalized:false,finalizedThroughTimestamp:head.blockTimestamp};
  }
  // ETH public endpoints may cap getLogs at 100 blocks. BSC produces more
  // blocks per minute and the configured BSC readers permit 512-block pages.
  const last=low+(order.chainId===1?63n:511n);
  const high=last<BigInt(head.blockNumber)?last:BigInt(head.blockNumber);
  const hex=n=>'0x'+n.toString(16);
  const asset=network(order.chainId);
  const topics=[transferTopic,'0x'+order.payer.slice(2).padStart(64,'0'),'0x'+MERCHANT.slice(2).padStart(64,'0')];
  const query={address:asset.token,fromBlock:hex(low),toBlock:hex(high),topics};
  const amount='0x'+transferData(order.amountMicro,asset.decimals,MERCHANT).slice(-64);
  const observations=await Promise.all(trustedPair(rpcUrls).map(async url=>{
    const [logs,raw]=await Promise.all([rpc(url,'eth_getLogs',[query],fetcher),
      rpc(url,'eth_getBlockByNumber',[hex(high),false],fetcher)]);
    const b=parseBlock(raw);
    requireThat(b.number===high && Array.isArray(logs) && logs.length<=4096,503,'Incomplete transfer scan');
    const hashes=new Set();
    for(const l of logs) {
      requireThat(l && l.removed!==true && l.address?.toLowerCase()===asset.token && l.topics?.length===3 &&
        topics.every((t,i)=>l.topics[i]?.toLowerCase()===t) && qHex(l.blockNumber)>=low && qHex(l.blockNumber)<=high &&
        txHash.test(l.transactionHash) && /^0x[0-9a-f]{64}$/i.test(l.data),503,'Invalid RPC transfer log');
      if(l.data.toLowerCase()===amount) hashes.add(l.transactionHash);
    }
    requireThat(hashes.size<=8,503,'Too many matching transfers; order needs reconciliation');
    return {hashes:[...hashes].sort(),hash:b.hash,time:b.timestamp.toString()};
  }));
  const [a,b]=observations;
  requireThat(JSON.stringify(a)===JSON.stringify(b),503,'Payment nodes disagree on scan results');
  const matches=[];
  for(const h of a.hashes) {
    const payment=await checkPayment({...order,orderId:id,txHash:h},{rpcUrls,fetcher,minBlock:floor});
    const ts=BigInt(payment.blockTimestamp);
    if(ts>=BigInt(Math.floor(order.createdAt/1000)) && ts<=BigInt(Math.floor(order.expiresAt/1000))) matches.push(payment);
  }
  return {matches,nextBlock:(high+1n).toString(),complete:BigInt(a.time)>BigInt(Math.floor(order.expiresAt/1000)),
    hasMoreFinalized:high<BigInt(head.blockNumber),
    finalizedThroughTimestamp:a.time};
}
