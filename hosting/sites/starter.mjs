import { formatCoins } from '../../src/amount.mjs';
import { nextCheckpoint } from '../../src/checkpoint.mjs';
import { addressFromPrivateKey, sign } from '../../src/crypto.mjs';
import { DISTRIBUTION_RESERVE, spendableBalance } from '../../src/ledger.mjs';
import { SALE_PRICE_NANO_PER_MICRO } from '../../src/sale-policy.mjs';
import { STARTER_GRANT_AMOUNT, activeStarterMandate, knownStarterWallet, remainingStarterClaims, starterAddressEligible,
  starterClaimAmount, starterClaimHeight, starterGrantAmount } from '../../src/starter-grants.mjs';
import { GRANT_HEAD_BYTES, commitHostedTransaction, heldSaleUnitsSql, holdArgs } from './sale-holds.mjs';
import { readHostedLedger, quorumCommit } from './sale-settlement.mjs';

const response=(data,status=200)=>Response.json(data,{status,headers:{
  'cache-control':'no-store','x-content-type-options':'nosniff'
}});
const failure=(code,status)=>response({error:code,code},status);
const normalize=value=>typeof value==='string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;

async function statusFor(live,db,address) {
  const {head}=live, state=head.state, mandate=activeStarterMandate(state);
  const authorized=state.chainId===DISTRIBUTION_RESERVE.chainId && state.networkStage==='mainnet' && mandate?.active===true;
  const active=authorized && starterGrantAmount(state)===STARTER_GRANT_AMOUNT;
  const height=address ? starterClaimHeight(state,address) : null;
  const claimed=height!==null;
  const known=Boolean(address && knownStarterWallet(state,address));
  const eligible=known && starterAddressEligible(state,address);
  let remaining=0, reason;
  if (active) {
    remaining=remainingStarterClaims(state);
    let available=spendableBalance(state,DISTRIBUTION_RESERVE.address);
    if (!head.authority) {
      const row=await db.prepare('SELECT CAST('+heldSaleUnitsSql+' AS TEXT) AS held')
        .bind(...holdArgs(state.lastSale?.sequence ?? 0,state.lastSale?.paymentId)).first();
      available-=BigInt(row.held)*SALE_PRICE_NANO_PER_MICRO;
      // Keep room for a new claim marker and balance/nonce growth. The
      // final atomic write also checks the actual encoded next checkpoint.
      if (new TextEncoder().encode(JSON.stringify(head)).length+512>GRANT_HEAD_BYTES) reason='hosted_capacity';
    } else if (!live.quorumEscrowSupported) reason='unavailable';
    if (available<BigInt(STARTER_GRANT_AMOUNT)) reason??='reserve_unavailable';
    if (remaining===0) reason='budget_exhausted';
  } else reason=authorized?'program_updating':'program_inactive';
  if (address && !known) reason='wallet_not_recorded';
  else if (address && !eligible) reason='ineligible_wallet';
  return {coins:active?formatCoins(STARTER_GRANT_AMOUNT):null,address,eligible,claimed,active,requiresProof:false,remainingClaims:remaining,
    canClaim:Boolean(eligible && !claimed && !reason),reason:claimed?'already_claimed':reason??null,
    ledgerHeight:state.height,...(claimed?{height,claimedCoins:formatCoins(starterClaimAmount(state,address))}:{})};
}

async function commitGrant(live,db,tx,signer) {
  if (live.head.authority) return quorumCommit(live,tx);
  const {next}=nextCheckpoint(live.head,tx,signer);
  await commitHostedTransaction(db,live.head.state,next.state,JSON.stringify(next),'starter-grant');
  return {head:next};
}

// Produce a success only from the current signed ledger or an authenticated
// commit. A retry uses the persistent address marker, including after retirement.
export function createStarterRoute({read=readHostedLedger,commit=commitGrant}={}) {
  let processing=0;
  return async function starter(request,env,readBody) {
    const url=new URL(request.url);
    const checking=url.pathname==='/v1/starter/status',claiming=url.pathname==='/v1/starter/claim';
    if (!checking && !claiming) return failure('unknown_route',404);
    if (request.method!==(checking?'GET':'POST')) return failure('method_not_allowed',405);

    let address;
    if (checking && url.searchParams.has('address')) {
      address=normalize(url.searchParams.get('address'));
      if (!address) return failure('invalid_address',400);
    } else if (claiming) {
      const origin=request.headers.get('origin');
      if (origin!==null && origin!==url.origin) return failure('wrong_origin',403);
      let data;
      try {data=await readBody();}
      catch (err) {return failure('invalid_request',[400,413,415].includes(err.status)?err.status:400);}
      if (!data || typeof data!=='object' || Object.keys(data).length!==1 || !Object.hasOwn(data,'address')) {
        return failure('invalid_request',400);
      }
      address=normalize(data.address);
      if (!address) return failure('invalid_address',400);
    }

    if (claiming && processing>=8) return failure('ledger_busy',429);
    if (claiming) processing++;
    try {
      const db=env.DB.withSession('first-primary');
      const latest=()=>read(db,{starterGrants:true});
      let live=await latest();
      if (checking) return response(await statusFor(live,db,address??null));
      const paid=(state,alreadyClaimed)=>response({address,coins:formatCoins(starterClaimAmount(state,address)),
        claimed:true,alreadyClaimed,height:starterClaimHeight(state,address)},alreadyClaimed?200:201);
      for (let attempt=0;attempt<2;attempt++) {
        const status=await statusFor(live,db,address);
        if (status.claimed) return paid(live.head.state,true);
        if (!status.canClaim) return failure(status.reason,{
          wallet_not_recorded:404,ineligible_wallet:422,hosted_capacity:507,unavailable:503
        }[status.reason]??409);
        const {state}=live.head;
        const key=env.GPUCHAIN_SIGNER_PKCS8;
        const signer={privateKey:key,address:addressFromPrivateKey(key)};
        if (signer.address!==state.sequencer) return failure('unavailable',503);
        const payload={type:'starter-grant',chainId:state.chainId,from:signer.address,
          nonce:(state.nonces[signer.address]??0)+1,to:address,amount:STARTER_GRANT_AMOUNT,
          mandateVersion:activeStarterMandate(state).version};
        try {
          const confirmed=await commit(live,db,{payload,signature:sign(key,payload)},signer);
          const height=starterClaimHeight(confirmed.head.state,address);
          if (height===null || height!==confirmed.head.state.height) return failure('unavailable',503);
          return paid(confirmed.head.state,false);
        } catch (err) {
          if (err.status===507) return failure('hosted_capacity',507);
          live=await latest();
          const height=starterClaimHeight(live.head.state,address);
          if (height!==null) return paid(live.head.state,true);
          // Only a compare-and-swap rejection is known to be uncommitted.
          if (err.status!==409) return failure('unavailable',503);
        }
      }
      return failure('ledger_busy',409);
    } catch {return failure('unavailable',503);}
    finally {if (claiming) processing--;}
  };
}

export const starterRoute=createStarterRoute();
