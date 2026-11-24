# GPUChain

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

GPUChain은 **개발 중인 실험용 추론 크레딧 네트워크**입니다. RYZENStrata로 Qwen3.8-Flash-Next를 공급하면 추론을 요청한 사용자의 지갑에서 공급자의 지갑으로 코인이 이동합니다. 공급자는 자기 GPU를 끈 뒤에도 받은 코인으로 다른 공급자에게 추론을 요청하거나 다른 지갑에 송금할 수 있습니다. [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

## 실행

저장소 주소와 [에이전트 실행 문서](../AGENTS.md)를 에이전트에 전달하면 설치부터 상태 확인까지 진행할 수 있습니다. Node.js 24 이상이 있는 컴퓨터에서는 저장소 루트에서 한 명령으로 로컬 네트워크를 시작합니다.

~~~powershell
node scripts/bootstrap.mjs
~~~

첫 실행 때 `.local`에 세 지갑과 제네시스 파일이 생기고, 요청자 지갑에 로컬 네트워크에서 사용할 1코인이 배정됩니다. 다음 실행부터 기존 지갑과 잔액을 이어 씁니다. 프로그램은 원장(8787)과 공급 어댑터(8789)를 로컬에서 열고 각각의 준비 상태를 출력합니다. 창을 닫거나 Ctrl+C를 누르면 종료됩니다. 지갑 파일에는 개인 키가 있으므로 다른 사람과 공유할 때는 공개 주소와 제네시스 파일만 전달하세요.

실제 추론을 공급하려면 RYZENStrata에 `qwen3.8-flash-next-q2_0` 모델을 262,144토큰 컨텍스트로 로드합니다. 어댑터의 기본 접속 주소는 `http://127.0.0.1:8000/v1`입니다. 이미 설치한 모델을 사용하며, GPUChain 시작 명령에는 모델 다운로드가 없습니다. 구매자와 원장 노드는 모델 파일 없이 사용할 수 있습니다.

공급자가 준비되면 두 번째 PowerShell 창에서 다음처럼 실행합니다.

~~~powershell
$provider = (Get-Content -Raw .local/provider.json | ConvertFrom-Json).address
node src/cli.mjs chat --genesis .local/genesis.json --wallet .local/user.json --provider-url http://127.0.0.1:8789 --provider-address $provider --text "한국어로 한 문장만 인사해 줘." --max-input 1024 --max-output 64
node src/cli.mjs balance --genesis .local/genesis.json --address $provider
node src/cli.mjs transfer --genesis .local/genesis.json --wallet .local/user.json --to $provider --coins 0.01
node src/cli.mjs verify --genesis .local/genesis.json
~~~

다른 사람의 네트워크에 참여할 때는 운영자로부터 신뢰할 수 있는 제네시스 파일과 원장 주소를 받습니다. 요청할 때 `--ledger`, `--provider-url`, `--provider-address`에 실제 대상 값을 지정합니다. 각 컴퓨터에서 새 제네시스를 만들면 서로 다른 네트워크가 생성됩니다. 호스트 간 통신에는 HTTPS를 쓰고, 로컬 HTTP 포트는 기본 루프백 바인딩으로 운영할 수 있습니다. 운영자는 `add-provider` 명령으로 새 공급자의 공개 주소를 등록할 수 있습니다. [전체 CLI 예시](../README.md)

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

현재 원장은 한 명의 서명자(시퀀서)가 거래 순서를 정하고, 복제 노드는 제네시스와 서명을 이용해 최신 상태를 검증합니다. 추론 정산에는 공급자와 요청자의 서명이 모두 필요합니다. 독립적인 GPU 실행 증명, 무허가 분산 합의, 결과 전달 후 요청자가 서명을 거부했을 때의 대금 보장은 아직 개발 과제입니다. 과거 거래를 재생하려면 원장이 보관하지 않는 거래 원본이 필요합니다.

`node --test`로 지갑, 정산, 10억 토큰 경계, 저장·재시작, 복제 및 모의 백엔드 통합 테스트를 실행합니다. GPUChain 소스는 [MIT 라이선스](../LICENSE)로 제공합니다.
