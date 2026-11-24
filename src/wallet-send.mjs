import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { decodeAmount, formatCoins, parseCoins } from './amount.mjs';
import { authenticate, verifyAdvance } from './checkpoint.mjs';
import { addressFromPrivateKey, hash, sign } from './crypto.mjs';
import { publicGenesis, resolvePublicLedger } from './public-network.mjs';
import { submitSignedTransaction } from './submit-transaction.mjs';

const PAIR_MS=120_000, SESSION_MS=300_000;
const token=()=>randomBytes(32).toString('hex');
const exact=(value,names)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).length===names.length && names.every(k=>Object.hasOwn(value,k));

class SendError extends Error {
  constructor(status,code,message) { super(message);this.status=status;this.code=code; }
}
function expect(ok,status,code,message) { if (!ok) throw new SendError(status,code,message); }
function equal(a,b) {
  if (typeof a!=='string' || typeof b!=='string' || a.length>128 || a.length!==b.length) return false;
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
}

/** All unlock state is process-local. The control channel alone can issue a code. */
export function createWalletSender({wallet,pin=publicGenesis.hash,resolveLedger=()=>resolvePublicLedger({write:true}),
  submit=submitSignedTransaction,now=Date.now}) {
  if (addressFromPrivateKey(wallet.privateKey)!==wallet.address) throw Error('Incorrect local wallet key');
  let pairing, session, sending=false;
  function issueCode() {
    expect(!sending,409,'SENDING','A transfer is pending');
    session=undefined;
    const code=String(randomInt(10_000_000_000)).padStart(10,'0');
    pairing={code,expiresAt:now()+PAIR_MS,attempts:0};
    return {code,expiresAt:pairing.expiresAt};
  }
  function unlock(input,origin) {
    expect(pairing && now()<pairing.expiresAt,403,'INVALID_CODE','Request a current code from the local wallet console');
    expect(pairing.attempts<5,429,'RATE_LIMITED','Request a new code from the local wallet console');
    pairing.attempts++;
    expect(exact(input,['code']) && equal(input.code,pairing.code),403,'INVALID_CODE','Invalid local wallet code');
    pairing=undefined;
    session={token:token(),csrfToken:token(),origin,expiresAt:now()+SESSION_MS,draft:null};
    return {token:session.token,csrfToken:session.csrfToken,expiresAt:session.expiresAt};
  }
  function authorize(auth) {
    expect(session && now()<session.expiresAt && auth.origin===session.origin &&
      equal(auth.token,session.token) && equal(auth.csrfToken,session.csrfToken),
    403,'AUTH_REQUIRED','Unlock this wallet for one transfer');
    return session;
  }
  async function latest() {
    try {
      const result=await resolveLedger();
      const checkpoint=authenticate(result.checkpoint,pin);
      return {url:result.url,state:checkpoint.state,checkpoint};
    } catch { throw new SendError(503,'LEDGER_UNAVAILABLE','A current verified writable ledger is unavailable'); }
  }
  function nextNonce(state,amount) {
    expect(state.saleMandate?.authority!==wallet.address,403,'INVALID_INPUT','Dedicated sale signer cannot transfer funds');
    expect(decodeAmount(state.balances[wallet.address] ?? 0)>=decodeAmount(amount),
      409,'INSUFFICIENT_FUNDS','Insufficient verified balance');
    const nonce=(state.nonces[wallet.address] ?? 0)+1;
    expect(Number.isSafeInteger(nonce),409,'STATE_CHANGED','Wallet nonce is out of range');
    return nonce;
  }
  async function prepare(input,auth) {
    const owner=authorize(auth);
    expect(exact(input,['to','coins']) && typeof input.to==='string' && /^[a-f0-9]{64}$/.test(input.to) &&
      input.to!==wallet.address,400,'INVALID_INPUT','Enter a different 64-character lowercase wallet address');
    let amount;
    try {amount=parseCoins(input.coins);} catch {throw new SendError(400,'INVALID_INPUT','Enter a positive coin amount with up to nine decimals');}
    const draftId=token();
    owner.draft=null;
    owner.preparing=draftId;
    const ledger=await latest();
    authorize(auth);
    expect(owner.preparing===draftId,409,'STATE_CHANGED','A newer transfer draft replaced this one');
    const nonce=nextNonce(ledger.state,amount);
    const payload={type:'transfer',chainId:pin,from:wallet.address,to:input.to,amount,nonce};
    owner.draft={draftId,payload,checkpoint:ledger.checkpoint};
    return {draftId,chainId:pin,from:wallet.address,to:input.to,coins:formatCoins(amount),amountNano:String(amount),
      feeCoins:'0',nonce,expiresAt:owner.expiresAt};
  }
  async function confirm(input,auth) {
    const owner=authorize(auth), draft=owner.draft;
    expect(exact(input,['draftId']) && draft && equal(input.draftId,draft.draftId),
      409,'STATE_CHANGED','Prepare and review a current transfer');
    // Burn authorization synchronously before any await. Parallel confirmations
    // cannot both sign, including if the ledger connection drops after commit.
    session=undefined;
    sending=true;
    try {
      const ledger=await latest();
      try {verifyAdvance(draft.checkpoint,ledger.checkpoint);}
      catch {throw new SendError(409,'STATE_CHANGED','Ledger changed; prepare a new transfer');}
      expect(hash(ledger.checkpoint.authority ?? null)===hash(draft.checkpoint.authority ?? null) &&
        ledger.state.epoch===draft.checkpoint.state.epoch,409,'STATE_CHANGED','Ledger settings changed; review again');
      const {payload}=draft;
      expect(nextNonce(ledger.state,payload.amount)===payload.nonce,409,'STATE_CHANGED','Wallet nonce changed; review again');
      expect(now()<owner.expiresAt,403,'EXPIRED','Wallet authorization expired');
      const tx={payload,signature:sign(wallet.privateKey,payload)};
      let receipt;
      try {receipt=await submit(ledger,tx);}
      catch {throw new SendError(503,'UNCERTAIN','Confirmation unavailable. Check your balance and nonce before considering another transfer.');}
      return {confirmed:true,chainId:pin,to:payload.to,coins:formatCoins(payload.amount),feeCoins:'0',...receipt};
    } finally {sending=false;}
  }
  return {issueCode,unlock,prepare,confirm};
}
