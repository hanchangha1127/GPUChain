# GPUChain 지갑 백업과 복구

검증 노드에서 이미 사용 중인 지갑을 비밀번호로 암호화한 파일에 백업합니다. 새 PC에서 같은 주소로 서명하려면 **암호화된 파일과 그 파일의 비밀번호**가 모두 필요합니다. 현재 생성된 지갑의 개인키는 독립적인 Ed25519 키이므로 복구 문구를 소급 발급하지 않습니다. [키 보관 형식](wallet-keystore-v1.ko.md)

## 현재 지갑 백업

Windows에서는 저장소의 **GPUChain Backup.cmd**를 더블 클릭합니다. 터미널에서 실행하려면 아래 첫 번째 명령을 사용하세요. 기본 경로는 `~/.gpuchain/backups/`이고, `--out`으로 **새 파일**의 위치를 지정할 수 있습니다.

~~~powershell
node scripts/wallet-backup.mjs backup
# 다른 지갑을 지정하는 예시
node scripts/wallet-backup.mjs backup --wallet .local/user.json --out "$HOME/Documents/user-backup.keystore.json"
~~~

터미널에 표시된 원본·백업 경로를 확인하고 긴 고유 비밀번호를 두 번 입력하세요. 입력은 화면에 표시되지 않습니다. 프로그램은 파일을 다시 열어 복호화, 공개 주소 일치, 시험용 서명 검증을 마친 다음 백업을 완료합니다. 출력되는 공개 주소는 따로 기록해 두세요. 새 백업 파일을 다른 장치나 독립적인 보관 장소에 복사한 후 아래 명령으로 그 복사본도 확인할 수 있습니다.

~~~powershell
node scripts/wallet-backup.mjs verify --in "E:/backup/user-backup.keystore.json" --address <기록한-공개주소>
~~~

## 새 PC에서 복구

~~~powershell
node scripts/wallet-backup.mjs restore --in "E:/backup/user-backup.keystore.json" --out "$HOME/restored.wallet.json" --address <기록한-공개주소>
~~~

복구 결과 파일에는 현재 GPUChain 프로그램에서 사용하는 개인키가 들어 있습니다. 소유자만 접근할 수 있는 디렉터리를 선택하세요. 기존 파일은 덮어쓰지 않습니다. Windows에서는 현재 사용자에게만 파일 접근 권한을 부여하며, 호환 파일시스템에서 하드 링크로 검증된 파일을 원자적으로 게시합니다. FAT/exFAT처럼 권한 또는 하드 링크 기능이 없는 USB에는 로컬 NTFS에서 만든 **암호화 백업**을 복사하세요.

백업은 원래 지갑을 읽어 별도 암호화 사본을 만들며, 기존 노드의 프로그램용 개인키 파일은 현재 JSON 형식입니다. 검증 위원회 투표 노드를 이전하려면 해당 노드의 **최신 투표 DB 및 인스턴스 상태**도 필요합니다. 같은 투표 지갑으로 복제 노드 두 대를 동시에 실행하거나 예전 DB로 되감으면 합의에 문제가 생길 수 있습니다. 지갑의 잔액은 해당 체인의 원장에서 확인할 수 있습니다.

이 기능은 브라우저에 비밀을 전달하지 않습니다. 사용자에게 비밀번호를 채팅이나 명령행 인자로 요청하지 말고, 본인이 직접 로컬 터미널에 입력하도록 안내하세요.
