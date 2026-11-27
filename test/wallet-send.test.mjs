import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWallet, sign } from '../src/crypto.mjs';
import { createGenesis, replay } from '../src/ledger.mjs';
import { checkpointProof } from '../src/checkpoint-base.mjs';
import { nextCheckpoint } from '../src/checkpoint.mjs';
import { createWalletSender } from '../src/wallet-send.mjs';
import { startWalletUi } from '../src/wallet-ui.mjs';
import { requestJson } from '../src/http.mjs';
import { submitSignedTransaction } from '../src/submit-transaction.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walletSpendCoordinator } from '../src/wallet-spend.mjs';
import { startNode, readCheckpoint } from '../src/node.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

function fixture(spendRoot) {
  const seq=generateWallet(), wallet=generateWallet(), recipient=generateWallet();
  const genesis=createGenesis(seq,{allocations:{[wallet.address]:100},providers:[]});
  let head={genesis,state:replay([genesis]),epochHashes:[],signature:null}, now=100_000, posts=0, dropped=false;
  // Synthetic signed funded head avoids real wallets; all submissions terminate in this fixture.
  const state={...head.state,balances:{[wallet.address]:'1000000000000000000000'},supply:'1000000000000000000000',
    height:1,tip:'1'.repeat(64)};
  head={...head,state,signature:sign(seq.privateKey,checkpointProof(state,[]))};
  const read=async()=>({url:'http://127.0.0.1:0',checkpoint:head,state:head.state});
  async function submit(ledger,tx) {
    posts++;
    return submitSignedTransaction(ledger,tx,async()=>{
      const {block,next}=nextCheckpoint(head,tx,seq);
      head=next;
      if (dropped) throw Error('Lost message after commit');
      return {block};
    });
  }
  const spends=spendRoot && walletSpendCoordinator(genesis.hash,wallet.address,{root:spendRoot});
  const sender=createWalletSender({wallet,pin:genesis.hash,spends,resolveLedger:read,submit,now:()=>now});
  return {wallet,seq,recipient,sender,spends,genesis,read,getHead:()=>head,getPosts:()=>posts,
    drop:()=>{dropped=true;},advance:ms=>{now+=ms;},
    otherSpend:()=>{
      const payload={type:'transfer',chainId:genesis.hash,from:wallet.address,to:recipient.address,amount:1,nonce:1};
      head=nextCheckpoint(head,{payload,signature:sign(wallet.privateKey,payload)},seq).next;
    }};
}

function pair(sender,origin='http://127.0.0.1:1234') {
  const {code}=sender.issueCode();
  return {...sender.unlock({code},origin),origin};
}

test('lost transfer ACK across a GUI restart recovers the approved debit without signing the retry',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuchain-gui-recovery-'));
  const wallet=generateWallet(), recipient=generateWallet(), seq=generateWallet();
  const genesis=createGenesis(seq,{allocations:{[wallet.address]:100},providers:[]});
  const node=await startNode({dir:join(root,'node'),genesis,wallet:seq,port:0});
  let posts=0,connected=true,hideProof=false;
  const proxy=createServer(async(req,res)=>{
    if (req.url==='/v1/transactions' && req.method==='POST') {
      posts++;
      const data=[];
      for await (const chunk of req) data.push(chunk);
      const result=await fetch(node.url+req.url,{method:'POST',body:Buffer.concat(data),headers:{'content-type':'application/json'}});
      assert.equal(result.status,201);
      await result.arrayBuffer();
      connected=false;
      return res.destroy();
    }
    if (req.url.startsWith('/v1/transaction-outcomes/')) {
      assert.equal(req.method,'GET');
      if (hideProof) return res.writeHead(404).end();
      return res.writeHead(200,{'content-type':'application/json'}).end(await (await fetch(node.url+req.url)).text());
    }
    res.writeHead(404).end();
  });
  proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
  t.after(async()=>{await new Promise(resolve=>proxy.close(resolve));await node.close();await rm(root,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+proxy.address().port;
  const resolveLedger=async()=>{
    if (!connected) throw Error('Connection interrupted');
    const checkpoint=await readCheckpoint(node.url,genesis.hash);
    return {url,checkpoint,state:checkpoint.state};
  };
  const sender=()=>createWalletSender({wallet,pin:genesis.hash,resolveLedger,
    spends:walletSpendCoordinator(genesis.hash,wallet.address,{root})});
  const first=sender(), auth=pair(first), input={to:recipient.address,coins:'0.000000007'};
  const draft=await first.prepare(input,auth);
  await assert.rejects(first.confirm({draftId:draft.draftId},auth),{code:'settlement_pending'});
  const second=sender(), {lastTransfer}=second.paymentStatus();
  assert.equal(lastTransfer.status,'pending');
  assert.equal(lastTransfer.to,draft.to);
  assert.equal(lastTransfer.coins,draft.coins);
  assert.equal((await readCheckpoint(node.url,genesis.hash)).state.balances[recipient.address],7);
  connected=true;
  await assert.rejects(second.prepare(input,pair(second)),{code:'previous_transfer_recovered'});
  assert.equal(second.paymentStatus().lastTransfer.status,'confirmed');
  assert.equal((await second.checkOutcome(lastTransfer.txHash)).height,1);
  assert.equal(posts,1);
  await assert.rejects(second.confirm({draftId:draft.draftId},auth),{code:'AUTH_REQUIRED'});

  hideProof=true;
  const a=pair(second), d=await second.prepare(input,a);
  await assert.rejects(second.confirm({draftId:d.draftId},a),{code:'settlement_pending'});
  connected=true;
  await assert.rejects(second.prepare(input,pair(second)),{code:'settlement_unconfirmed'});
  const signedHash=second.paymentStatus().lastTransfer.txHash;
  const reviewed=pair(second);
  const different=await second.prepare({...input,coins:'0.000000009'},reviewed);
  assert.equal(different.unconfirmedTransfer,undefined);
  const repeated=await second.prepare(input,reviewed);
  assert.equal(repeated.unconfirmedTransfer,signedHash);
  await assert.rejects(second.confirm({draftId:repeated.draftId},reviewed),{code:'STATE_CHANGED'});
  assert.equal(posts,2);
  await assert.rejects(second.confirm({draftId:repeated.draftId,acknowledgeUnconfirmed:signedHash},reviewed),{code:'settlement_pending'});
  assert.equal(posts,3);
});

test('wallet transfer preparation waits for another spend and reviews the fresh nonce',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuchain-gui-spend-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const f=fixture(root),auth=pair(f.sender),started=Promise.withResolvers(),finish=Promise.withResolvers();
  const inference=f.spends.run('inference',f.read,async()=>{
    started.resolve();
    await finish.promise;
    f.otherSpend();
  });
  await started.promise;
  const draft=f.sender.prepare({to:f.recipient.address,coins:'0.000000001'},auth);
  try { assert.equal(f.spends.activity(),'inference'); } finally { finish.resolve(); }
  await inference;
  const reviewed=await draft;
  assert.equal(reviewed.nonce,2);
  assert.ok((await f.sender.confirm({draftId:reviewed.draftId},auth)).confirmed);
  assert.equal(f.getHead().state.nonces[f.wallet.address],2);
});

test('a local confirmation signs only the reviewed exact transfer and consumes its unlock exactly once',async()=>{
  const f=fixture(), auth=pair(f.sender);
  const draft=await f.sender.prepare({to:f.recipient.address,coins:'999999999999.999999999'},auth);
  assert.equal(draft.amountNano,'999999999999999999999');
  assert.equal(draft.feeCoins,'0');
  assert.equal(f.getPosts(),0);
  await assert.rejects(f.sender.confirm({draftId:draft.draftId,to:f.wallet.address},auth),{code:'STATE_CHANGED'});
  const results=await Promise.allSettled(Array.from({length:2},()=>f.sender.confirm({draftId:draft.draftId},auth)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const receipt=results.find(r=>r.status==='fulfilled').value;
  assert.equal(receipt.hash,f.getHead().state.tip);
  assert.equal(receipt.coins,draft.coins);
  assert.equal(f.getHead().state.balances[f.wallet.address],1);
  assert.equal(f.getPosts(),1);
});

test('wallet pairing cannot be guessed, replayed or kept past its TTL, and checks CSRF and origin',async()=>{
  const f=fixture(), s=f.sender, origin='http://127.0.0.1:9991';
  const first=s.issueCode();
  const wrong=first.code==='0000000000'?'0000000001':'0000000000';
  for(let i=0;i<5;i++) assert.throws(()=>s.unlock({code:wrong},origin),{code:'INVALID_CODE'});
  assert.throws(()=>s.unlock({code:first.code},origin),{code:'RATE_LIMITED'});
  const second=s.issueCode(); f.advance(120_001);
  assert.throws(()=>s.unlock({code:second.code},origin),{code:'INVALID_CODE'});
  const third=s.issueCode();
  const a={...s.unlock({code:third.code},origin),origin};
  assert.throws(()=>s.unlock({code:third.code},origin),{code:'INVALID_CODE'});
  const request={to:f.recipient.address,coins:'0.000000001'};
  await assert.rejects(s.prepare(request,{...a,csrfToken:'0'.repeat(64)}),{code:'AUTH_REQUIRED'});
  await assert.rejects(s.prepare(request,{...a,origin:'http://localhost:9991'}),{code:'AUTH_REQUIRED'});
  await assert.rejects(s.prepare({...request,coins:'1000000000000.000000001'},a),{code:'INSUFFICIENT_FUNDS'});
  await assert.rejects(s.prepare({...request,to:f.wallet.address},a),{code:'INVALID_INPUT'});
  f.advance(300_001);
  await assert.rejects(s.prepare(request,a),{code:'AUTH_REQUIRED'});
});

test('a changed nonce or an uncertain acknowledgment never causes automatic resubmission',async()=>{
  const f=fixture(), s=f.sender, auth=pair(s);
  const input={to:f.recipient.address,coins:'0.000000001'};
  const d=await s.prepare(input,auth);
  f.otherSpend();
  await assert.rejects(s.confirm({draftId:d.draftId},auth),{code:'STATE_CHANGED'});
  assert.equal(f.getPosts(),0);
  const b=pair(s), second=await s.prepare(input,b);
  f.drop();
  await assert.rejects(s.confirm({draftId:second.draftId},b),{code:'UNCERTAIN'});
  await assert.rejects(s.confirm({draftId:second.draftId},b),{code:'AUTH_REQUIRED'});
  assert.equal(f.getPosts(),1);
  assert.equal(f.getHead().state.balances[f.recipient.address],2);
});

test('the HTTP wallet requires exact Origin, local Host, JSON, session cookie and per-session CSRF',async t=>{
  const f=fixture(), s=await startWalletUi({getSnapshot:()=>({}),port:0,sender:f.sender});
  t.after(s.close);
  const post=(path,x,headers={})=>fetch(s.url+'/api/send/'+path,{method:'POST',
    headers:{origin:s.url,'content-type':'application/json',...headers},body:JSON.stringify(x)});
  const code=f.sender.issueCode().code;
  await assert.rejects(requestJson(s.url+'/api/send/unlock',{
    headers:{origin:s.url,host:'untrusted.example'},body:{code}
  }),{status:403});
  for(const headers of [{origin:'https://example.org'},{origin:'null'},
    {'x-forwarded-host':'example.org'},{'sec-fetch-site':'same-site'}]) {
    assert.equal((await post('unlock',{code},headers)).status,403,JSON.stringify(headers));
  }
  assert.equal((await fetch(s.url+'/api/send/unlock',{method:'POST',body:'{}'})).status,403);
  assert.equal((await post('unlock',{code},{'content-type':'text/plain'})).status,415);
  const unlocked=await post('unlock',{code});
  assert.equal(unlocked.status,200);
  const header=unlocked.headers.get('set-cookie');
  assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/);assert.match(header,/Path=\/api\/send/);
  const cookie=header.split(';')[0], {csrfToken}=await unlocked.json();
  const input={to:f.recipient.address,coins:'1'};
  assert.equal((await post('prepare',input,{cookie})).status,403);
  const transferHeaders={cookie,'x-gpuchain-csrf':csrfToken};
  const prepared=await post('prepare',input,transferHeaders);
  const draft=await prepared.json();
  assert.equal(prepared.status,200);
  assert.equal(draft.coins,'1');
  const confirmed=await post('confirm',{draftId:draft.draftId},transferHeaders);
  assert.equal(confirmed.status,200);
  assert.equal((await confirmed.json()).hash,f.getHead().state.tip);
  assert.equal((await post('confirm',{draftId:draft.draftId},transferHeaders)).status,403);
});
