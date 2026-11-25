// The signing session is paired locally and survives only while this dialog is open.
const languages = ['ko','ja','zh-CN','fr'];
const phrases = {
  'Transfer':['송금','送金','转账','Virement'],
  'Send coins':['코인 보내기','コインを送る','发送代币','Envoyer des coins'],
  'Send coins to a public GPUChain wallet address.':['GPUChain 공개 지갑 주소로 코인을 보냅니다.','GPUChainの公開ウォレットアドレスにコインを送金します。','向 GPUChain 公开钱包地址发送代币。','Envoyez des coins vers une adresse publique GPUChain.'],
  'Unlock this wallet':['지갑 잠금 해제','ウォレットを解除','解锁钱包','Déverrouiller le portefeuille'],
  'Open GPUChain Unlock.cmd on this PC or run npm run wallet:unlock. Enter the displayed single-use code.':['이 PC에서 GPUChain Unlock.cmd를 열거나 npm run wallet:unlock을 실행하고 표시된 일회용 코드를 입력하세요.','このPCでGPUChain Unlock.cmdを開くか、npm run wallet:unlockを実行し、表示されたワンタイムコードを入力します。','在本机打开 GPUChain Unlock.cmd，或运行 npm run wallet:unlock，输入显示的一次性代码。','Sur ce PC, ouvrez GPUChain Unlock.cmd ou exécutez npm run wallet:unlock, puis saisissez le code à usage unique affiché.'],
  'Unlock code':['일회용 잠금 해제 코드','ワンタイムコード','一次性解锁码','Code à usage unique'],
  'Unlock':['잠금 해제','解除','解锁','Déverrouiller'],
  'Recipient address':['수취인 주소','受取先アドレス','收款地址','Adresse du destinataire'],
  'Amount (coins)':['수량 (코인)','金額（コイン）','数量（币）','Montant (coins)'],
  'Review transfer':['송금 내용 확인','送金内容を確認','核对转账','Vérifier le virement'],
  'Confirm transfer':['송금 확정','送金を確定','确认发送','Confirmer le virement'],
  'From':['보내는 지갑','送金元','发送地址','Expéditeur'],
  'Network fee (coins)':['네트워크 수수료 (코인)','手数料（コイン）','网络费（币）','Frais de réseau (coins)'],
  'Transaction nonce':['거래 순번','取引番号 (nonce)','交易序号','Numéro de séquence'],
  'Chain ID':['체인 ID','チェーンID','链 ID','Identifiant de chaîne'],
  'Confirm before':['확인 기한','確認期限','确认期限','Confirmer avant'],
  'Review the full recipient and amount before confirming.':['확정하기 전에 전체 수취 주소와 수량을 확인하세요.','確定する前に受取先アドレス全体と金額を確認してください。','确认前请核对完整收款地址和金额。','Vérifiez l’adresse complète du destinataire et le montant avant de confirmer.'],
  'Cancel':['취소','キャンセル','取消','Annuler'],
  'Edit':['수정','編集','修改','Modifier'],
  'Close':['닫기','閉じる','关闭','Fermer'],
  'Checking…':['확인 중…','確認中…','核对中…','Vérification…'],
  'A wallet operation is pending. Try again once it settles.':['지갑 거래가 진행 중입니다. 정산 후 다시 시도하세요.','ウォレットの処理中です。精算後に再試行してください。','钱包操作正在进行，请在结算后重试。','Une opération est en cours. Réessayez après son règlement.'],
  'Resolve the previous inference payment before sending coins.':['이전 추론 결제의 결과를 확인한 뒤 송금하세요.','前回の推論の支払い状況を確認してから送金してください。','请先核对上一笔推理支付，再转账。','Vérifiez le règlement de la dernière inférence avant le virement.'],
  'Waiting for ledger confirmation…':['원장 확정을 기다리는 중…','台帳の確定を待っています…','等待账本确认…','Confirmation du registre en cours…'],
  'Transfer confirmed':['송금 확정됨','送金が確定しました','转账已确认','Virement confirmé'],
  'Transaction hash':['거래 해시','取引ハッシュ','交易哈希','Empreinte de transaction'],
  'Ledger height':['원장 높이','台帳の高さ','账本高度','Hauteur du registre'],
  'Enter a valid 64-character recipient and a positive amount with up to nine decimal places.':['64자리 수취 주소와 소수점 이하 9자리 이내의 양수를 입력하세요.','64桁の受取先と、小数点以下9桁以内の正の金額を入力してください。','请输入 64 位收款地址和最多九位小数的正数金额。','Saisissez une adresse de 64 caractères et un montant positif avec neuf décimales au maximum.'],
  'Enter the 10-digit local code.':['로컬에서 발급한 10자리 코드를 입력하세요.','ローカルで発行した10桁のコードを入力します。','输入本机生成的 10 位代码。','Saisissez le code local à 10 chiffres.'],
  'The code is invalid or has expired.':['코드가 잘못됐거나 만료됐습니다.','コードが無効か期限切れです。','代码无效或已过期。','Le code est invalide ou a expiré.'],
  'Unlock the wallet again.':['지갑 잠금을 다시 해제하세요.','もう一度ウォレットを解除してください。','请重新解锁钱包。','Déverrouillez à nouveau le portefeuille.'],
  'Insufficient verified balance.':['검증된 잔액이 부족합니다.','検証済み残高が不足しています。','已验证余额不足。','Solde vérifié insuffisant.'],
  'The ledger changed or this draft expired. Review a new draft.':['원장이 변경됐거나 요청이 만료됐습니다. 새 송금 내용을 확인하세요.','台帳が更新されたか、期限が切れました。新しい送金内容を確認してください。','账本已更新或草稿已过期，请重新核对。','Le registre a changé ou le brouillon a expiré. Vérifiez un nouveau brouillon.'],
  'Too many attempts. Try later.':['시도 횟수가 많습니다. 잠시 후 다시 시도하세요.','試行回数が多すぎます。時間をおいてください。','尝试次数过多，请稍后再试。','Trop de tentatives. Réessayez plus tard.'],
  'The ledger is unavailable.':['현재 원장에 연결할 수 없습니다.','現在、台帳に接続できません。','账本暂时不可用。','Le registre est indisponible.'],
  'Transfer outcome is unknown. Check the wallet balance and nonce before another transfer.':['송금 결과를 확인할 수 없습니다. 다시 보내기 전에 지갑 잔액과 거래 순번을 확인하세요.','送金結果を確認できません。次の送金前に残高と取引番号を確認してください。','转账结果未知。再次转账前，请查看余额和交易序号。','Résultat incertain. Vérifiez le solde et le numéro de séquence avant tout autre virement.'],
  'Could not complete this request.':['요청을 완료하지 못했습니다.','要求を完了できませんでした。','未能完成请求。','La demande a échoué.']
};
const tr=label=>phrases[label]?.[languages.indexOf(document.documentElement.lang)] ?? label;
const translations={
  WALLET_BUSY:'A wallet operation is pending. Try again once it settles.',
  settlement_pending:'Resolve the previous inference payment before sending coins.',
  settlement_unconfirmed:'Resolve the previous inference payment before sending coins.',
  settlement_rejected:'Resolve the previous inference payment before sending coins.',
  INVALID_CODE:'The code is invalid or has expired.', AUTH_REQUIRED:'Unlock the wallet again.',
  RATE_LIMITED:'Too many attempts. Try later.', INSUFFICIENT_FUNDS:'Insufficient verified balance.',
  INVALID_INPUT:'Enter a valid 64-character recipient and a positive amount with up to nine decimal places.',
  STATE_CHANGED:'The ledger changed or this draft expired. Review a new draft.',
  EXPIRED:'The ledger changed or this draft expired. Review a new draft.', LEDGER_UNAVAILABLE:'The ledger is unavailable.'
};
const terminalFailure='Transfer outcome is unknown. Check the wallet balance and nonce before another transfer.';
const fixedLabels={
  amount:'Amount (coins)',destination:'Recipient address',sender:'From',fee:'Network fee (coins)',
  nonce:'Transaction nonce',chain:'Chain ID',deadline:'Confirm before',height:'Ledger height',receipt:'Transaction hash'
};
const dialog=document.createElement('dialog');
dialog.className='send-dialog';
dialog.setAttribute('aria-labelledby','send-title');
dialog.innerHTML=`
  <h2 id="send-title"></h2>
  <section id="send-unlock">
    <p class="send-help" data-send-label="Open GPUChain Unlock.cmd on this PC or run npm run wallet:unlock. Enter the displayed single-use code."></p>
    <label for="send-code" data-send-label="Unlock code"></label>
    <input type="password" id="send-code" inputmode="numeric" maxlength="10" autocomplete="off" spellcheck="false">
  </section>
  <section id="send-edit" hidden>
    <label for="send-to" data-send-label="Recipient address"></label>
    <input id="send-to" class="mono" maxlength="64" autocomplete="off" spellcheck="false">
    <label for="send-coins" data-send-label="Amount (coins)"></label>
    <input id="send-coins" inputmode="decimal" autocomplete="off">
  </section>
  <section id="send-review" hidden>
    <p id="send-check" class="send-help" data-send-label="Review the full recipient and amount before confirming."></p>
    <dl id="send-facts"></dl>
  </section>
  <p id="send-feedback" class="send-feedback" aria-live="polite" role="status" hidden></p>
  <div class="send-actions">
    <button id="send-close" type="button" class="send-secondary"></button>
    <button id="send-back" type="button" class="send-secondary" data-send-label="Edit" hidden></button>
    <button id="send-next" type="button" class="send-primary"></button>
  </div>`;
document.body.append(dialog);
const el=id=>document.getElementById(id);
let step='unlock',csrf='',draft=null,receipt=null,feedback='',working=false;

function fact(name,value,mono=false) {
  const row=document.createElement('div'), dt=document.createElement('dt'), dd=document.createElement('dd');
  dt.textContent=tr(fixedLabels[name]);
  dd.textContent=String(value);
  if(mono)dd.className='mono';
  row.append(dt,dd);el('send-facts').append(row);
}

function render() {
  for(const item of document.querySelectorAll('[data-send-label]')) item.textContent=tr(item.dataset.sendLabel);
  el('send-title').textContent=tr(step==='unlock'?'Unlock this wallet':step==='review'?'Review transfer':
    step==='sent'?'Transfer confirmed':'Send coins');
  el('send-unlock').hidden=step!=='unlock';
  el('send-edit').hidden=step!=='edit';
  el('send-review').hidden=!(step==='review'||step==='sent');
  el('send-check').hidden=step!=='review';
  el('send-facts').replaceChildren();
  if(draft && (step==='review'||step==='sent')) {
    fact('destination',draft.to,true);fact('amount',draft.coins);fact('fee',draft.feeCoins);
    fact('sender',draft.from,true);fact('nonce',draft.nonce);fact('chain',draft.chainId,true);
    if(step==='review') fact('deadline',new Date(draft.expiresAt).toLocaleTimeString(document.documentElement.lang));
    if(receipt) {fact('height',receipt.height);fact('receipt',receipt.hash,true);}
  }
  const msg=working?step==='review'?'Waiting for ledger confirmation…':'Checking…':feedback;
  el('send-feedback').hidden=!msg;el('send-feedback').textContent=msg?tr(msg):'';
  el('send-back').hidden=step!=='review';el('send-back').disabled=working;
  el('send-close').textContent=tr(['sent','uncertain'].includes(step)?'Close':'Cancel');
  el('send-close').disabled=working;
  el('send-next').textContent=tr(step==='unlock'?'Unlock':step==='edit'?'Review transfer':'Confirm transfer');
  el('send-next').hidden=['sent','uncertain'].includes(step);el('send-next').disabled=working;
  for(const id of ['send-code','send-to','send-coins']) el(id).disabled=working;
}

function reset() {
  step='unlock';csrf='';draft=null;receipt=null;feedback='';working=false;
  el('send-code').value='';el('send-to').value='';el('send-coins').value='';
}
function nano(coins) {
  if(typeof coins!=='string'||!/^\d{1,16}(?:\.\d{1,9})?$/.test(coins)) return null;
  const [a,b='']=coins.split('.');
  const n=BigInt(a)*1000000000n+BigInt(b.padEnd(9,'0'));
  return n>0n?n.toString():null;
}
async function api(path,body) {
  const headers={'content-type':'application/json'};
  if(csrf) headers['x-gpuchain-csrf']=csrf;
  const response=await fetch('/api/send/'+path,{method:'POST',credentials:'same-origin',redirect:'error',
    cache:'no-store',signal:AbortSignal.timeout(90000),headers,body:JSON.stringify(body)});
  const json=await response.json();
  if(!response.ok) throw Object.assign(Error(),{code:json.code});
  return json;
}

el('send-open').addEventListener('click',()=>{
  if(dialog.open) return;
  reset();render();dialog.showModal();el('send-code').focus();
});
el('send-close').addEventListener('click',()=>{if(!working)dialog.close();});
dialog.addEventListener('cancel',e=>{if(working)e.preventDefault();});
dialog.addEventListener('close',()=>{reset();render();el('send-open').focus();});
el('send-back').addEventListener('click',()=>{if(!working){step='edit';draft=null;feedback='';render();el('send-to').focus();}});
el('send-next').addEventListener('click',async()=>{
  if(working||!dialog.open||step==='sent'||step==='uncertain') return;
  const previous=step;
  working=true;feedback='';render();
  try {
    if(step==='unlock') {
      const code=el('send-code').value.trim();
      el('send-code').value='';
      if(!/^\d{10}$/.test(code)) {feedback='Enter the 10-digit local code.';return;}
      const result=await api('unlock',{code});
      if(!result.unlocked||typeof result.csrfToken!=='string'||!result.csrfToken) throw Error();
      csrf=result.csrfToken;step='edit';
    } else if(step==='edit') {
      const to=el('send-to').value.trim().toLowerCase(),coins=el('send-coins').value.trim(), amount=nano(coins);
      if(!/^[a-f0-9]{64}$/.test(to)||!amount){feedback=translations.INVALID_INPUT;return;}
      const d=await api('prepare',{to,coins});
      const address=el('address')?.textContent.trim();
      if(!d || d.to!==to || d.feeCoins!=='0' || d.amountNano!==amount || nano(d.coins)!==amount ||
        !/^[a-f0-9]{64}$/.test(d.from) || (/^[a-f0-9]{64}$/.test(address)&&address!==d.from) ||
        !/^[a-f0-9]{64}$/.test(d.chainId) || typeof d.draftId!=='string' || !d.draftId ||
        !Number.isSafeInteger(d.nonce)||d.nonce<1||!Number.isSafeInteger(d.expiresAt)||d.expiresAt<=Date.now()) throw Error();
      draft=d;step='review';
    } else if(step==='review') {
      if(!draft || draft.expiresAt<=Date.now()){step='edit';draft=null;feedback=translations.EXPIRED;return;}
      const result=await api('confirm',{draftId:draft.draftId});
      if(result.confirmed!==true||result.chainId!==draft.chainId||result.to!==draft.to||
        result.coins!==draft.coins||result.feeCoins!=='0'||!Number.isSafeInteger(result.height)||
        !/^[a-f0-9]{64}$/.test(result.hash)) throw Error();
      receipt=result;csrf='';step='sent';
      el('refresh')?.click();
    }
  } catch(e) {
    feedback=translations[e.code]||'Could not complete this request.';
    if(e.code==='AUTH_REQUIRED'||previous==='unlock') {csrf='';step='unlock';}
    else if(previous==='review') {
      csrf='';
      if(['WALLET_BUSY','settlement_pending','settlement_unconfirmed','settlement_rejected',
        'STATE_CHANGED','EXPIRED','INSUFFICIENT_FUNDS','INVALID_INPUT'].includes(e.code)) {
        step='unlock';draft=null;
      } else {step='uncertain';feedback=terminalFailure;}
    }
  } finally {
    working=false;render();
    if(previous!==step) {
      if(step==='edit') el('send-to').focus();
      else if(step==='unlock') el('send-code').focus();
      else el('send-close').focus(); // An Enter key used for the previous step cannot authorize the next one.
    }
  }
});
window.addEventListener('gpuchain-languagechange',render);
window.addEventListener('pagehide',()=>{csrf='';el('send-code').value='';});
render();
