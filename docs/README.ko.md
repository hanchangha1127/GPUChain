# GPUChain

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

공개 Sites에서 GPUChain 수령 주소를 등록하고 결제 지갑으로 주문에 서명한 뒤 Ethereum USDT 또는 BNB Smart Chain의 Binance-Peg USDT로 결제할 수 있습니다. 판매가는 1 USDT당 10코인(1코인당 0.1 USDT)입니다. 확정된 입금은 Sites가 확인하고 배포 지갑에서 구매자의 지갑으로 지급합니다. [구매 화면](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/) · [결제 기준](usdt-sales.md)

GPUChain 공개 메인넷 `gpuchain-mainnet-1`은 소규모로 운영하는 추론 네트워크입니다. 기존 체인에서 서명된 승격 거래로 전환하므로 제네시스 해시, 지갑 주소, 잔액, 거래 순번을 계승합니다. `node src/cli.mjs verify`로 검증된 상태의 `networkStage`가 `mainnet`인지 확인하세요. 기존 설치본과의 호환을 위해 제네시스 파일명 `sites-testnet.json`은 유지합니다.

**저장소 URL만 에이전트에 건네면 공개 메인넷 검증 노드를 백그라운드로 시작합니다.** 직접 설치할 때는 Node.js 24 이상이 있는 PC에서 저장소를 복제하고 `npm start`를 실행하세요. 노드는 첫 실행에 전용 지갑과 데이터베이스를 준비하고, 서명된 체크포인트를 계속 검증해 최신 상태를 저장합니다. 에이전트 작업이나 터미널이 끝난 뒤에도 실행됩니다. GPU·모델 다운로드·공인 IP 없이 참여할 수 있습니다. [에이전트 설치 안내](../AGENTS.md) · [공개 메인넷 운영 안내](../hosting/sites/README.md)

`npm run status`로 로컬 노드의 검증 높이와 투표 여부를 확인합니다. `npm stop`으로 종료하고, `npm start`로 같은 지갑과 DB에서 재개합니다. 접속과 추론 공급자 상태를 한 번만 확인하려면 `npm run join`을 사용하세요.

**지갑 화면 열기** — `npm run gui`를 실행하거나 Windows에서 **GPUChain Wallet.cmd**를 더블클릭하세요. 노드를 시작하거나 실행 중인 노드를 재사용한 뒤 브라우저를 엽니다. 지갑 화면에서 공개 지갑 주소와 검증된 잔액, 노드 동기화와 투표 여부, 로컬 추론 공급 어댑터 상태를 확인할 수 있습니다. 화면은 별도의 루프백 포트로 제공됩니다. 실제 접속 주소는 `node scripts/open-wallet.mjs --print-url`로 확인하세요. 송금하려면 `GPUChain Unlock.cmd` 또는 `npm run wallet:unlock`으로 일회용 코드를 발급받아 로컬 화면에 입력하고, 수취 주소와 정확한 수량을 검토한 뒤 확정하세요.

지갑의 기본 언어는 영어이며 한국어·일본어·중국어 간체·프랑스어로 전환할 수 있습니다. `GPUChain Backup.cmd`에서 암호화 백업을 만든 뒤 파일과 비밀번호를 분리해 보관하세요. 합의에 투표하는 노드는 기존의 최신 DB도 함께 보존해야 합니다. [백업·복구](wallet-backup.md)

## 다른 PC의 OpenCode에서 추론 요청하기

**추론을 사용할 PC**에 Node.js 24 이상과 OpenCode 2.x를 설치한 뒤 GPUChain 저장소에서 다음 명령을 실행하세요.

~~~powershell
npm run opencode:setup
~~~

OpenCode를 다시 열고 `/models`에서 `gpuchain/qwen3.8-flash-next`를 선택하세요. 설치 명령은 기존 기본 모델을 보존하고 GPUChain 공급자를 추가합니다. OpenCode의 기본 접속 주소는 **요청자 PC의** `http://127.0.0.1:8792/v1`입니다. 실제 주소는 설치 결과의 `baseURL` 또는 노드 상태의 `openAiUrl`에서 확인할 수 있습니다. 로컬 `opencode.token`은 해당 PC의 참여 지갑에서 유료 추론을 요청할 권한이 있으므로 그 PC에만 보관하세요.

요청자 지갑에 사용 가능한 잔액이 있고 다른 지갑으로 등록한 공급자가 온라인이어야 합니다. 게이트웨이는 공급자에게 직접 HTTPS로 요청하거나 공개 원장의 암호화 릴레이를 사용합니다. Sites 주소는 원장·릴레이용이며 8080은 공급자 PC에서 엔진에 연결하는 포트입니다. OpenCode에서는 텍스트, 추론 과정, 도구 호출을 스트리밍으로 받고 정산 후 최종 사용량을 받습니다. 후속 요청은 같은 공급자를 우선 선택해 프롬프트 접두부의 KV 캐시를 재사용할 수 있습니다. 공급자가 바뀌거나 엔진 캐시가 사라지면 적중량은 0일 수 있습니다. 캐시 할인은 영수증의 실측 `usage.prompt_tokens_details.cached_tokens`에만 적용됩니다.

**추론 단계 선택**은 요청자 쪽에서 할 수 있습니다. OpenCode 2.4.1 터미널 화면의 `/models`에서 GPUChain을 선택한 뒤 **Ctrl+T**를 눌러 `none`(끄기), `low`, `medium`, `high` 중 하나를 선택하세요. 한 번만 높은 단계로 실행하려면 다음 명령을 사용하세요.

~~~powershell
opencode run --model "gpuchain/qwen3.8-flash-next#high" "이 변경 사항을 검토해 줘."
~~~

선택한 값은 요청의 `reasoning_effort`로 전달됩니다. 생각 토큰 예산을 지정하려면 GPUChain 모델의 `variants`에 `{"id":"high-512","body":{"reasoning_effort":"high","reasoning_budget_tokens":512}}`를 추가하고 `#high-512`로 선택하세요. API를 직접 사용할 때도 같은 두 필드를 요청에 넣을 수 있습니다. 생각 토큰과 답변 토큰은 하나의 출력 한도를 공유하며 OpenCode의 기본 출력 한도는 4,096입니다. 생각 예산의 범위는 0부터 요청의 `max_tokens`까지입니다. RYZENStrata는 양수 예산에 도달하면 생각을 마무리하기 시작하며, 마무리 문구도 생각 토큰으로 계량할 수 있습니다. 0은 별도의 생각 예산을 해제합니다. `none`으로 생각을 끌 때는 예산을 생략하거나 0으로 설정하세요. [OpenCode 모델 변형 안내](https://opencode.ai/docs/models/#variants)

**공개 릴레이를 직접 지정해 확인하려면** 요청자 PC의 PowerShell에서 아래 명령을 사용하세요. 출력된 공개 주소가 코인을 충전한 지갑인지 확인한 뒤 마지막 유료 추론 명령을 실행하세요. 아래 명령에서 `--ledger $ledger`를 생략하면 현재 공개 원장을 자동으로 탐색합니다.

~~~powershell
$dataDir = if ($env:GPUCHAIN_PARTICIPANT_DIR) { $env:GPUCHAIN_PARTICIPANT_DIR } else { Join-Path $env:USERPROFILE '.gpuchain/participant' }
$buyer = Get-Content -Raw -LiteralPath (Join-Path $dataDir 'participant.json') | ConvertFrom-Json
$status = node scripts/participant.mjs status | ConvertFrom-Json
if ($buyer.address -ne $status.address) { throw 'Check the participant wallet and directory' }
$buyer.address
$ledger = 'https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site'
node src/cli.mjs balance --ledger $ledger --address $buyer.address
node src/cli.mjs routes --ledger $ledger --transport relay --wallet $buyer.walletFile
node src/cli.mjs chat --ledger $ledger --transport relay --wallet $buyer.walletFile --text "Reply with OK." --max-input 1024 --max-output 32
~~~

## 원장 검증과 합의 투표

기본 노드는 원장을 검증합니다. 거래 확정에 투표하려면 승인된 지갑과 외부에서 접속 가능한 HTTPS 주소도 필요합니다. 운영자는 노드의 공개 지갑 주소를 `add-validator`로 승인할 수 있고, 이미 등록된 추론 공급자 지갑도 참여 자격이 있습니다. HTTPS 주소를 로컬 리스너(기본 8790번 포트)에 연결하고 `GPUCHAIN_VALIDATOR_ORIGIN`을 지정한 뒤 노드를 재시작하세요. 지갑과 DB는 같은 데이터 디렉터리(기본 `~/.gpuchain/participant`)에 보관합니다.

Sites는 준비된 세 노드의 참여 서명·접속 주소·데이터베이스 식별자를 확인해 위원회를 인증합니다. 이후 거래 확정에는 세 노드 중 두 대의 서명이 필요합니다. 위원회 외의 노드도 체크포인트 검증을 계속합니다. [합의 전환과 운영 조건](../hosting/sites/README.md)

## 독립된 로컬 개발 네트워크 실행

자체 제네시스와 테스트 코인으로 실험할 때만 다음 명령을 실행하세요.

~~~powershell
node scripts/bootstrap.mjs
~~~

첫 실행 때 `.local`에 세 지갑과 제네시스 파일이 생기고, 요청자 지갑에 로컬 네트워크에서 사용할 1코인이 배정됩니다. 다음 실행부터 기존 지갑과 잔액을 이어 씁니다. 프로그램은 원장(8787)과 공급 어댑터(8789)를 로컬에서 열고 각각의 준비 상태를 출력합니다. 창을 닫거나 Ctrl+C를 누르면 종료됩니다. 지갑 파일에는 개인 키가 있으므로 다른 사람과 공유할 때는 공개 주소와 제네시스 파일만 전달하세요.

공급 엔진은 `--engine ryzenstrata`(기본) 또는 `--engine strata`로 선택합니다. `provider` 명령과 `scripts/bootstrap.mjs` 모두 이 옵션과 `--strata`, `--model-id`를 지원합니다. RYZENStrata의 기본 모델 ID는 `qwen3.8-flash-next-q2_0`입니다. 원본 Strata는 조건에 맞는 로드된 모델이 하나면 자동으로 선택하며 여러 개면 모델 ID를 지정해야 합니다. 지원 모델은 **Qwen3.8-Flash-Next**와 해당 가중치의 호환 양자화본으로 한정됩니다. 컨텍스트는 **262,144토큰(256K) 이상**이어야 하고 실행 중인 **K와 V 캐시 각각 Q8 이상**이어야 합니다. Q2_0 가중치와 Q8 KV 캐시를 함께 쓸 수 있습니다. 추론 전과 영수증 서명 전에 엔진 `/metrics`로 실행 모델·컨텍스트·KV 형식을 확인합니다. [원본 Strata](https://github.com/Niko1221/Strata) · [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

실행 중인 GPUChain 노드는 로컬 Strata를 **8080 → 8000** 순으로 확인하고, 모델·256K 컨텍스트·K/V 정밀도 조건에 맞는 엔진을 `127.0.0.1:8789` 공급 어댑터에 자동 연결합니다. RYZENStrata를 나중에 켜도 됩니다. 감지 과정에서는 모델을 로드하거나 토큰을 생성하지 않습니다. 다른 로컬 주소는 `GPUCHAIN_STRATA_URL`로 지정하고, 자동 연결은 `GPUCHAIN_AUTO_PROVIDER=0`으로 끌 수 있습니다. 변경 후 노드를 다시 시작하세요.

원장에 등록된 공급자는 아웃바운드 HTTPS(보통 443번)를 쓰는 암호화 릴레이로 유료 추론을 제공할 수 있습니다. 공급자 PC의 포트 개방·터널·검증기 공개 주소·위원회 투표권은 필요하지 않습니다. 운영 시퀀서가 거래를 확정하는 동안에도 실제로 처리하고 요청자와 정산한 작업에서 코인을 받습니다. 검증기 3대의 위원회 구성은 별도 절차입니다. `routes --transport relay`로 공급 상태를 확인하고, `chat --transport auto`는 적격 직접 연결 후 릴레이 순으로 선택합니다. 직접 연결을 운영하려면 공개 HTTPS를 8789번에 전달하고 그 주소를 등록합니다. `GPUCHAIN_INFERENCE_RELAY=0`은 릴레이만 끕니다. 릴레이의 요청·응답은 각각 암호화 전 JSON 최대 8 MiB입니다.

요청자는 `--reasoning-effort none|low|medium|high`로 추론 강도를 정합니다. `max`와 `xhigh`는 `high`로 처리합니다. `--reasoning-budget-tokens N`의 범위는 0부터 `--max-output`까지입니다. RYZENStrata는 양수 예산에 도달하면 생각을 마무리하기 시작하며, 마무리 문구도 생각 토큰으로 계량할 수 있습니다. 0은 별도의 생각 예산을 해제합니다. 사고를 끄려면 `none`을 쓰고 예산은 생략하거나 0으로 지정하세요. 두 옵션을 생략하면 엔진 기본 설정을 씁니다. 사고 토큰은 최대 출력 한도에 포함되고 출력 사용량으로 한 번만 정산됩니다.

~~~powershell
node src/cli.mjs chat --wallet user.wallet.json --text "두 방법을 비교해 줘." --max-input 1024 --max-output 512 --reasoning-effort high --reasoning-budget-tokens 256
~~~

공급자가 준비되면 두 번째 PowerShell 창에서 다음처럼 실행합니다.

~~~powershell
$provider = (Get-Content -Raw .local/provider.json | ConvertFrom-Json).address
node src/cli.mjs routes --genesis .local/genesis.json
node src/cli.mjs chat --genesis .local/genesis.json --wallet .local/user.json --text "한국어로 한 문장만 인사해 줘." --max-input 1024 --max-output 64
node src/cli.mjs balance --genesis .local/genesis.json --address $provider
node src/cli.mjs transfer --genesis .local/genesis.json --wallet .local/user.json --to $provider --coins 0.01
node src/cli.mjs verify --genesis .local/genesis.json
~~~

다른 사람의 네트워크에 참여할 때는 운영자로부터 신뢰할 수 있는 제네시스 파일과 원장 주소를 받고 `--ledger URL`을 지정합니다. 운영자는 시퀀서 지갑으로 `add-provider --address ADDRESS --url URL`을 실행해 공급자의 지갑 주소와 HTTPS 서비스 주소를 함께 공지합니다. 기존 공급자는 `set-provider-endpoint --address ADDRESS --url URL`로 주소를 갱신하고 `--url URL` 대신 `--withdraw`를 주면 목록에서 접속 주소를 내립니다. 로컬 부트스트랩은 자체 공급 주소를 자동 등록합니다. [전체 CLI 예시](../README.md)

`chat`에서 공급자 옵션을 생략하면 내 PC가 공지된 후보 최대 64곳 중 3초 이내에 측정한 노드를 비교합니다. 같은 체인의 준비된 공급자인지 서명으로 확인하고, 후보당 최대 세 번의 HTTP 왕복 시간(원격은 HTTPS)의 중앙값이 가장 작은 곳에만 프롬프트를 보냅니다. 이 값은 현재 접속 응답성이므로 지리적 거리나 추론 속도 순위와 다를 수 있습니다. 직접 지정하려면 `--provider-url URL --provider-address ADDRESS`를 함께 사용합니다.

## 단가와 블록 기준

| 구분 | 100만 토큰당 정산액 | 블록 누적량 |
|---|---:|---|
| 캐시 미적중 입력 | 0.15코인 | 포함 |
| 생성 출력 | 0.47코인 | 포함 |
| 캐시 적중 입력 | 0.016코인 | 제외 |

단가는 QwenCloud International의 수치를 코인 단위에 적용합니다. 계산에는 정수 나노코인(1코인 = 10억 나노코인)을 씁니다. 전체 입력 64토큰 중 32토큰이 캐시 적중이고 출력이 10토큰이면 0.000010012코인을 지급하고 42토큰을 누적합니다. [공식 가격표](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

네트워크 전체의 **캐시 미적중 입력 + 출력이 10억 토큰**에 이를 때마다 블록 해시 하나를 확정합니다. 운영자가 다음 구간의 요청당 최대 출력 길이를 예약해 두면 경계를 넘긴 요청을 정산한 후부터 적용합니다. 초과 토큰은 다음 구간으로 이월합니다. 거래 수를 나타내는 `height`와 10억 토큰 구간 수를 나타내는 `epoch`는 별도로 집계합니다.

## 저장 공간과 검증 범위

SQLite에는 최신 잔액·순번·설정·누적량·체인 끝값과 완료된 구간당 32바이트 해시 하나가 남습니다. 개별 송금과 추론 영수증, 프롬프트, 응답 본문은 원장에 저장하지 않습니다. 한 요청을 처리하는 공급자는 프롬프트를 볼 수 있고, 어댑터는 재시도를 위해 가장 최근 응답을 일시적으로 메모리에 보관합니다.

복제 노드는 고정된 제네시스를 기준으로 초기에는 시퀀서 서명을, 전환 후에는 검증자 과반 서명을 확인합니다. 이 합의는 검증자가 규칙을 따르는 경우 한 대의 중단을 견딥니다. 추론 정산에는 공급자와 요청자의 서명이 모두 필요합니다. 독립적인 GPU 실행 증명, 무허가 분산 합의, 결과 전달 후 요청자가 서명을 거부했을 때의 대금 보장은 아직 개발 과제입니다. 과거 거래를 재생하려면 원장이 보관하지 않는 거래 원본이 필요합니다.

`node --test`로 지갑, 정산, 10억 토큰 경계, 저장·재시작, 복제 및 모의 백엔드 통합 테스트를 실행합니다. GPUChain 소스는 [MIT 라이선스](../LICENSE)로 제공합니다.
