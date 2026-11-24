import { storeLocales } from './store-i18n.mjs';

const words={
  title:['GPUChain ledger','GPUChain 원장','GPUChain 台帳','GPUChain 账本','Registre GPUChain'],
  store:['Coin store','코인 상점','コインストア','代币商店','Boutique de coins'],
  language:['Language','언어','言語','语言','Langue'],
  stage:['Network stage','네트워크 단계','ネットワーク段階','网络阶段','Phase du réseau'],
  mainnet:['Mainnet','메인넷','メインネット','主网','Réseau principal'],
  testnet:['Testnet','테스트넷','テストネット','测试网','Réseau de test'],
  role:['Settlement authority','거래 확정 주체','取引の確定主体','交易确认方','Autorité de règlement'],
  bootstrap:['Bootstrap sequencer','초기 시퀀서','初期シーケンサー','初始排序器','Séquenceur initial'],
  quorum:['Validator committee','검증 위원회','検証委員会','验证委员会','Comité de validation'],
  active:['This sequencer settles signed transfers and inference receipts.','이 시퀀서는 서명된 송금과 추론 영수증을 정산합니다.','このシーケンサーが署名済み送金と推論レシートを決済します。','该排序器对签名转账及推理凭据进行结算。','Ce séquenceur règle les transferts signés et les reçus d’inférence.'],
  retired:['Participating validators now settle transactions. The values below are from the certified transition checkpoint.','현재 거래는 참여 검증기가 확정합니다. 아래는 전환 시점에 인증된 체크포인트의 값입니다.','現在は参加検証ノードが取引を確定します。以下は認証された移行時チェックポイントの値です。','交易现由参与验证节点确认。以下数据来自切换时已认证的检查点。','Les validateurs participants règlent désormais les transactions. Les valeurs affichées proviennent du point de contrôle certifié lors de la transition.'],
  genesis:['Genesis hash','제네시스 해시','ジェネシスハッシュ','创世哈希','Hash de genèse'],
  height:['Accepted transactions','확정 거래 수','確定済み取引数','已确认交易数','Transactions confirmées'],
  providers:['Registered providers','등록 공급자','登録済み供給者','已注册供应者','Fournisseurs enregistrés'],
  validators:['Validator-only authorizations','검증 전용 승인 지갑','検証専用の承認数','仅验证授权数','Autorisations de validation seule'],
  epochs:['Completed epochs','완료된 에포크','完了したエポック','已完成周期','Époques terminées'],
  progress:['Eligible tokens in this epoch','현재 에포크 산입 토큰','このエポックの対象トークン','本周期计入的词元','Tokens comptabilisés dans cette époque'],
  file:['Genesis file','제네시스 파일','ジェネシスファイル','创世文件','Fichier de genèse'],
  checkpoint:['Signed checkpoint','서명된 체크포인트','署名済みチェックポイント','已签名检查点','Point de contrôle signé'],
  status:['Node status (JSON)','노드 상태 (JSON)','ノードの状態 (JSON)','节点状态 (JSON)','État du nœud (JSON)']
};
export function ledgerPage(state,retired) {
  const label=key=>`<span data-i18n="${key}">${words[key][0]}</span>`;
  const number=n=>Number.isSafeInteger(n)&&n>=0?`<span data-count="${n}">${n.toLocaleString('en')}</span>`:'—';
  const genesis=/^[0-9a-f]{64}$/.test(state.chainId)?state.chainId:'—';
  const row=(key,value)=>`<dt>${label(key)}</dt><dd>${value}</dd>`;
  const body=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPUChain ledger</title><style>*{box-sizing:border-box}body{margin:2rem auto;padding:0 1.5rem;max-width:48rem;font:1rem/1.6 system-ui;color:#192b3a;background:#f5f9fc}
h1{font-size:2rem;margin:.9rem 0 0}dl{background:white;padding:1.4rem;border:1px solid #bdcbd5;border-radius:.6rem}
dt{font-weight:650}dd{margin:0 0 .8rem;overflow-wrap:anywhere}a{color:#045a84}nav,header{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
header{justify-content:space-between}select{font:inherit;padding:.25rem .45rem}</style>
<header><a href="/">${label('store')}</a><div><label for="language">${label('language')}</label>
<select id="language"><option value="en">English</option><option value="ko">한국어</option><option value="ja">日本語</option><option value="zh-CN">简体中文</option><option value="fr">Français</option></select></div></header>
<main><h1>${label('title')}</h1><p>${label(retired?'retired':'active')}</p><dl>
${row('stage',label(state.networkStage==='mainnet'?'mainnet':'testnet'))}${row('role',label(retired?'quorum':'bootstrap'))}
${row('genesis','<code>'+genesis+'</code>')}${row('height',number(state.height))}${row('providers',number(state.providers.length))}
${row('validators',number((state.validatorAddresses??[]).length))}${row('epochs',number(state.epoch))}
${row('progress',number(state.epochTokens)+' / '+number(1_000_000_000))}</dl>
<nav><a href="/v1/genesis">${label('file')}</a><a href="/v1/checkpoint">${label('checkpoint')}</a><a href="/v1/status">${label('status')}</a></nav></main>
<script src="/ledger.js" defer></script></html>`;
  return new Response(body,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
}
function localize(locales,copy) {
  const selector=document.getElementById('language'),key='gpuchain.wallet.language';
  function set(value) {
    const language=locales.includes(value)?value:'en',index=locales.indexOf(language);
    document.documentElement.lang=language;document.title=copy.title[index];selector.value=language;
    for(const el of document.querySelectorAll('[data-i18n]')) el.textContent=copy[el.dataset.i18n][index];
    for(const el of document.querySelectorAll('[data-count]')) el.textContent=BigInt(el.dataset.count).toLocaleString(language);
  }
  let saved='en';try {saved=localStorage.getItem(key)||'en';}catch{}
  set(saved);
  selector.addEventListener('change',()=>{set(selector.value);try{localStorage.setItem(key,selector.value);}catch{}});
}
export function ledgerScript() {
  return new Response('('+localize.toString()+')('+JSON.stringify(storeLocales)+','+JSON.stringify(words)+');',
    {headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
}
