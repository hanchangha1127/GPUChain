import { decodeAmount, isAmount } from './amount.mjs';

const el = id => document.getElementById(id);
const numberFormat = new Intl.NumberFormat('ko-KR');
const clockFormat = new Intl.DateTimeFormat('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const dateFormat = new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const roles = {standby:'체크포인트 대기',verifier:'원장 검증',validator:'합의 검증기'};
const enrollments = {
  voting:'위원회 투표 참여', 'committee-fixed':'기존 위원회 구성 완료', 'identity-mismatch':'노드 식별 정보 불일치',
  'needs-public-origin':'공개 HTTPS 주소 필요', 'needs-registration':'검증 지갑 승인 필요',
  candidate:'검증기 후보', 'waiting-for-checkpoint':'첫 체크포인트 대기'
};
const adapterStates = {
  unavailable:'응답 없음', 'not-ready':'준비 중', 'different-chain':'다른 네트워크',
  incompatible:'호환되지 않는 설정', online:'연결됨'
};
let snapshot;
let loading = false;
let copyTimer;

function show(id,value) { el(id).textContent = value ?? '—'; }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? numberFormat.format(value) : '—'; }
function bool(value,yes,no) { return value === true ? yes : value === false ? no : '확인 불가'; }
function time(value,format) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? format.format(date) : '—';
}
function coins(nano) {
  if (!isAmount(nano)) return '—';
  const n = decodeAmount(nano);
  const whole = n/1000000000n;
  const fraction = (n%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');
  return numberFormat.format(whole)+(fraction ? '.'+fraction : '');
}
function badge(id,text,tone) {
  const item = el(id);
  item.querySelector('span').textContent = text;
  item.dataset.tone = tone;
}
function notice(text) {
  el('notice').hidden = !text;
  el('notice').textContent = text;
}
function render(data) {
  const {wallet,node,network,inference} = data;
  if (!wallet || !node || !network || !inference || !data.sampledAt) throw new Error('Invalid overview');
  const amount = coins(wallet.balanceNanocoins);
  show('balance',amount);
  el('balance').classList.toggle('long-amount',amount.length > 13);
  show('nano',amount === '—' ? '검증된 잔액 대기 중' : numberFormat.format(decodeAmount(wallet.balanceNanocoins))+' 나노코인');
  show('address',wallet.address);
  el('copy').disabled = !wallet.address;
  show('nonce',count(wallet.nonce));

  badge('node-badge',node.syncError ? '동기화 지연' : node.verified ? '검증됨' : '검증 대기',node.syncError ? 'warn' : node.verified ? 'ok' : 'neutral');
  show('node-mode',roles[node.mode] ?? '확인 불가');
  show('voting',bool(node.voting,'참여 중','미참여'));
  show('verified-at',time(node.lastVerifiedAt,dateFormat));
  show('instance',node.instanceId);
  show('pid',node.pid?.toString());
  show('ledger',node.ledgerUrl);
  show('enrollment',enrollments[node.enrollmentStatus] ?? node.enrollmentStatus);
  show('last-error',[node.syncError,node.enrollmentError].filter(Boolean).join(' · '));
  el('error-row').hidden = !(node.syncError || node.enrollmentError);

  const online = inference.adapter === 'online';
  if (online) {
    const activity = inference.inferenceActive === true ? '추론 중' :
      inference.busy === true ? '요청 처리 중' : inference.busy === false ? '요청 대기' : '연결됨';
    badge('inference-badge',activity,'ok');
  } else if (inference.adapter === 'unavailable') {
    badge('inference-badge','미연결','neutral');
  } else {
    badge('inference-badge',adapterStates[inference.adapter] ?? '확인 불가','warn');
  }
  show('node-inference',bool(inference.nodeRunsInference,'활성','꺼짐'));
  show('adapter',adapterStates[inference.adapter] ?? '확인 불가');
  show('registered',bool(inference.walletRegistered,'등록됨','미등록'));
  el('activity-row').hidden = !online;
  show('activity',bool(inference.inferenceActive,'추론 중',inference.busy ? '요청 처리 중' : '추론 대기'));
  show('model',inference.model);
  show('context',Number.isSafeInteger(inference.contextWindow) ? count(inference.contextWindow)+' 토큰' : null);
  show('provider-address',inference.providerAddress);
  show('same-wallet',bool(inference.sameWallet,'일치','다른 지갑'));
  show('provider-registered',bool(inference.providerRegistered,'등록됨','미등록'));

  show('consensus',({bootstrap:'시퀀서 운영',quorum:'위원회 합의'})[network.consensus] ?? '합의 상태 대기');
  show('height',count(network.height));
  show('providers',Number.isSafeInteger(network.registeredProviders) ? count(network.registeredProviders)+'대' : null);
  show('epoch-title',Number.isSafeInteger(network.epoch) ? '에포크 '+count(network.epoch)+' 진행량' : '에포크 진행량');
  const progress = el('progress');
  const known = Number.isSafeInteger(network.epochTokens) && network.epochTokens >= 0 && Number.isSafeInteger(network.epochTarget) && network.epochTarget > 0;
  progress.hidden = !known;
  if (known) {
    progress.max = network.epochTarget;
    progress.value = network.epochTokens;
    const ratio = network.epochTokens/network.epochTarget*100;
    show('percent',ratio > 0 && ratio < .01 ? '<0.01%' : numberFormat.format(Math.floor(ratio*100)/100)+'%');
  } else show('percent',null);
  show('work',known ? count(network.epochTokens)+' / '+count(network.epochTarget)+' 토큰' : '검증된 누적량 대기 중');
  show('network-name',network.name);
  show('chain-id',network.chainId);
  show('tip',network.tip);
  show('sample-time',time(data.sampledAt,clockFormat)+' 갱신');
  notice(node.syncError ? (node.verified ? '동기화를 기다리고 있습니다. 마지막으로 검증된 원장 값을 표시합니다.' : '첫 원장 동기화를 기다리고 있습니다.') : '');
}

async function refresh() {
  if (loading) return;
  loading = true;
  const button = el('refresh');
  button.disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),8000);
  try {
    const response = await fetch('/api/overview',{cache:'no-store',signal:controller.signal});
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    render(data);
    snapshot = data;
  } catch {
    const sampled = snapshot && time(snapshot.sampledAt,clockFormat);
    notice(sampled ? '로컬 노드에 연결할 수 없습니다. '+sampled+'에 받은 값을 표시합니다.' : '로컬 노드에 연결할 수 없습니다. 노드 실행 상태를 확인한 후 새로고침하세요.');
    badge('node-badge','연결 확인 불가','warn');
    badge('inference-badge','확인 불가','neutral');
    show('sample-time',sampled ? sampled+' 마지막 갱신' : '갱신 실패');
  } finally {
    clearTimeout(timeout);
    loading = false;
    button.disabled = false;
  }
}

el('refresh').addEventListener('click',refresh);
el('copy').addEventListener('click',async()=>{
  if (!snapshot?.wallet.address) return;
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(snapshot.wallet.address);
    show('copy-text','복사 완료');
    show('feedback','공개 지갑 주소를 복사했습니다.');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el('address'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    show('copy-text','직접 복사');
    show('feedback','주소를 선택했습니다. 기기의 복사 기능을 사용하세요.');
  }
  copyTimer = setTimeout(()=>{show('copy-text','주소 복사');show('feedback','');},2300);
});
document.addEventListener('visibilitychange',()=>{if (!document.hidden) refresh();});
setInterval(()=>{if (!document.hidden) refresh();},10000);
refresh();
