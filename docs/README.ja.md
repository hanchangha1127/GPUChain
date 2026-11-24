# GPUChain

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

GPUChain の公開メインネット `gpuchain-mainnet-1` は、小規模な実運用パイロットです。署名済みの昇格トランザクションにより、元のジェネシスハッシュ、ウォレット、残高、ノンスを引き継ぎます。`node src/cli.mjs verify` で `networkStage` が `mainnet` であることを確認できます。既存クライアントとの互換性のためジェネシスファイルの名前は `sites-testnet.json` のままです。

**このリポジトリの URL をエージェントに渡すと、公開メインネットの検証ノードをバックグラウンドで起動します。** 手動で実行する場合は Node.js 24 以降の環境でリポジトリをクローンし、`npm start` を実行します。ノードは自身のウォレットとデータベースを作成または再利用し、署名付きチェックポイントを継続して検証・保存します。ターミナルやエージェントのセッションを閉じても動作します。GPU、モデルのダウンロード、公開 IP アドレスは不要です。[エージェント向け手順](../AGENTS.md) · [公開メインネットの運用](../hosting/sites/README.md)

`npm run status` で検証済みの高さと投票の有無を確認できます。`npm stop` で停止し、`npm start` で同じ状態から再開します。接続と推論提供者を一度だけ確認するには `npm run join` を使います。

**ウォレットを開く** — `npm run gui` を実行するか、Windows では **GPUChain Wallet.cmd** をダブルクリックしてください。ノードを起動するか、起動中のノードを再利用してブラウザーを開きます。ローカルの画面で、ウォレットの公開アドレスと検証済み残高、ノードの同期・投票状態、ローカル推論アダプターの状態を確認できます。画面は専用のループバックポートで提供されます。実際の URL は `node scripts/open-wallet.mjs --print-url` で表示できます。 送金する場合は `GPUChain Unlock.cmd` または `npm run wallet:unlock` でワンタイムコードを取得してこのPCで入力し、受取先と金額を確認して確定してください。

画面の初期言語は英語で、日本語を含む 5 言語を選択できます。`GPUChain Backup.cmd` で暗号化バックアップを作成し、復元用のパスワードを別に保管してください。公開ストアでは 1 USDT で 10 コインを購入できます。決済前に GPUChain の受取先を登録してください。[購入手順](usdt-sales.md) · [バックアップ](wallet-backup.md)

## 台帳の検証と合意への投票

すべての既定ノードが台帳を検証します。取引の確定に投票するには、承認されたウォレットと、そのノードに到達できる公開 HTTPS オリジンも必要です。運営者は `add-validator` で公開アドレスを承認できます。登録済みの推論提供者のウォレットにも参加資格があります。HTTPS をローカルのリスナー（既定ポート 8790）に転送し、`GPUCHAIN_VALIDATOR_ORIGIN` を設定して再起動します。ウォレットとデータベースは元のデータディレクトリ（既定は `~/.gpuchain/participant`）に保管してください。

Sites が準備の整った 3 台の署名・接続先・データベース ID を確認し、委員会を認証します。その後の取引確定には委員 3 台のうち 2 台の署名が必要です。委員会に属さないノードも検証を続けます。[合意への移行と運用条件](../hosting/sites/README.md)

## 料金とエポック

供給できるのは **Qwen3.8-Flash-Next** とその対応量子化版だけです。コンテキストは **262,144 トークン（256K）以上**、稼働中の K キャッシュと V キャッシュは**両方とも Q8 以上**が必要です。Q2_0 のモデル重みと Q8 の KV キャッシュを組み合わせられます。アダプターは生成前と受領証への署名前に `/metrics` のモデル・容量・KV 形式を検査します。

| 種類 | 100 万トークンあたりのコイン | エポックに加算 |
| --- | ---: | --- |
| キャッシュを使わずに処理した入力 | 0.15 | する |
| 生成した出力 | 0.47 | する |
| キャッシュから読み込んだ入力 | 0.016 | しない |

単価には QwenCloud の International API 料金表の数値を採用しています。台帳では 1 コインを 10 億ナノコインとして整数で扱います。たとえば入力 64 トークンのうち 32 トークンがキャッシュにヒットし、出力が 10 トークンなら、**支払額は 0.000010012 コイン、エポックへの加算は 42 トークン**です。利用者の残高から提供者に支払い、初期発行量と提供者のアドレスはジェネシスファイルで指定します。[QwenCloud 公式料金表](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

ネットワーク全体の未キャッシュ入力と生成出力の合計が **10 億トークン**に達するたびにエポックが切り替わります。シーケンサーは、次のエポックから適用するリクエストごとの出力上限を予約できます。境界をまたぐリクエストは受付時の上限で精算し、超過分を次のエポックに繰り越します。トランザクションの高さは操作を受理するたびに、エポック番号は 10 億トークンごとに進みます。

## Windows で独立したローカルネットワークを起動する

開発用ネットワークを作るには `node scripts/bootstrap.mjs` を実行します。役割ごとに手動で起動する手順は次のとおりです。

Node.js 24 以降を使用します。提供者は `provider` または `scripts/bootstrap.mjs` に `--engine ryzenstrata`（既定）か `--engine strata` を指定します。前者の既定のモデル ID は `qwen3.8-flash-next-q2_0` です。後者は条件を満たすモデルが一つなら自動選択し、複数ある場合は `--model-id` で指定します。エンジンの URL は `--strata`、認証キーは `STRATA_API_KEY` で設定します。公開 HTTPS を GPUChain アダプターのローカルポート 8789 に転送します。アダプターは既定で `http://127.0.0.1:8000/v1` のエンジンを呼びます。利用者は `chat` コマンドから外向き HTTPS（通常 443）を使用します。LAN 用の OpenAI 互換 API を利用者側で公開する機能はありません。 [Strata](https://github.com/Niko1221/Strata) · [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

**ターミナル 1 でウォレットとネットワークを作成し、シーケンサーを起動します。** この例では利用者に初期残高 1 コインを割り当てます。新しい `.local` ディレクトリでウォレットとジェネシスを一度だけ作成します。ウォレットファイルには秘密鍵が入っています。別々のマシンで運用する際は各所有者が手元で保管してください。

~~~powershell
New-Item -ItemType Directory -Force .local | Out-Null
node src/cli.mjs wallet --out .local/sequencer.json
$user = node src/cli.mjs wallet --out .local/user.json | ConvertFrom-Json
$provider = node src/cli.mjs wallet --out .local/provider.json | ConvertFrom-Json
node src/cli.mjs genesis --wallet .local/sequencer.json --out .local/genesis.json --allocation "$($user.address)=1" --provider $provider.address
node src/cli.mjs node --genesis .local/genesis.json --wallet .local/sequencer.json --dir .local/ledger
~~~

**ターミナル 2 で推論の受付を開始します。** 提供者はループバックのポート 8789、シーケンサーはポート 8787 を使います。

~~~powershell
node src/cli.mjs provider --genesis .local/genesis.json --wallet .local/provider.json
~~~

**ターミナル 3 で推論、残高照会、送金を試します。** 推論結果には応答本文、実測トークン数、支払額、シーケンサーの受理結果が含まれます。UTF-8 のファイルからプロンプトを読むには `--text-file FILE` を使います。

~~~powershell
$provider = (Get-Content -Raw .local/provider.json | ConvertFrom-Json).address
node src/cli.mjs chat --genesis .local/genesis.json --wallet .local/user.json --provider-url http://127.0.0.1:8789 --provider-address $provider --text "コンテキストウィンドウとは何ですか？" --max-input 1024 --max-output 128
node src/cli.mjs balance --genesis .local/genesis.json --address $provider
node src/cli.mjs transfer --genesis .local/genesis.json --wallet .local/user.json --to $provider --coins 0.01
node src/cli.mjs status --genesis .local/genesis.json
~~~

**フォローノードと設定変更を試す場合**は、別のターミナルで次を実行します。

~~~powershell
node src/cli.mjs follower --genesis .local/genesis.json --upstream http://127.0.0.1:8787 --dir .local/follower --port 8788
~~~

ターミナル 3 からフォローノードの署名済みチェックポイントを検証できます。次の例の設定変更は、次回のエポックから出力上限を 8,192 トークンにします。

~~~powershell
node src/cli.mjs verify --genesis .local/genesis.json --ledger http://127.0.0.1:8788
node src/cli.mjs settings --genesis .local/genesis.json --wallet .local/sequencer.json --max-output 8192
~~~

**稼働中のネットワークに新しい提供者を登録する場合**は、提供者自身が手元でウォレットを作成し、公開アドレスを運営者に伝えます。運営者の端末で次のコマンドを実行すると登録が即時に有効になり、署名済みチェックポイントに反映されます。

~~~powershell
$newProviderAddress = Read-Host "新しい提供者の公開アドレス"
$providerOrigin = Read-Host "提供者の HTTPS オリジン"
node src/cli.mjs add-provider --genesis .local/genesis.json --wallet .local/sequencer.json --address $newProviderAddress --url $providerOrigin
~~~

複数マシンで運用する場合は信頼するジェネシスを配布し、台帳と提供者のエンドポイントを HTTPS で公開します。接続先の台帳は `--ledger URL` で指定します。登録済みの接続先はシーケンサーが `set-provider-endpoint --address ADDRESS --url URL` で更新でき、`--url URL` の代わりに `--withdraw` を指定すると掲載を取り下げます。ローカルのブートストラップは自身の接続先を自動登録します。

`node src/cli.mjs routes --genesis .local/genesis.json` で利用可能な提供者の順位を確認できます。`chat` で提供者の指定を省略すると、クライアントが最大64候補を3秒以内に調べ、同じチェーンの稼働中の提供者の署名を確認します。候補ごとに最大3回計測した HTTP 往復時間（リモートは HTTPS）の中央値が最小の提供者にだけプロンプトを送ります。順位は利用者から見た応答時間で決まり、地理的な距離や生成速度とは異なる場合があります。固定したい場合は `--provider-url URL --provider-address ADDRESS` を指定します。Ctrl+C で停止でき、再起動には同じジェネシス、ウォレット、台帳ディレクトリを使います。

## 保存するデータと検証の範囲

利用者は提供者のアドレス、プロンプトのハッシュ、ノンス、トークン数の上限を指定して署名します。提供者は残高を確認し、選択した Strata バックエンドで推論します。提供者が署名する受領証には、リクエストと応答のハッシュ、トークン数が含まれます。クライアントはそれらを検証して署名し、シーケンサーに精算を申請します。署名方式は Ed25519 です。

シーケンサーは支払条件を検証し、SQLite の状態をアトミックに更新します。データベースに保持するのは最新の残高・ノンス・設定・カウンター・チェーン先端のハッシュと、完了した各エポックの 32 バイトのダイジェストです。個々の取引内容と受領証は処理中だけ使用します。プロンプトと応答は利用者と提供者の間で送受信され、提供者はプロンプトを読むことができます。提供者プロセスは再試行用に直近の応答をメモリに一時保存します。

フォローノードは信頼するジェネシスを基準に、シーケンサーのチェックポイント署名を検証します。保存済みのデータから過去の全取引を再実行することはできません。移行後は検証者名簿の証明書と過半数の署名を確認します。検証者が規則を守ることを前提とし、計量値は当事者双方の署名に基づきます。GPU 実行の独立検証と、参加許可を必要としないコンセンサスは今後の課題です。精算には利用者の最終署名が必要であり、応答の後に通信が途切れたり利用者が署名を拒んだりすると、提供者が支払いを受けられない場合があります。

## テストとライセンス

~~~powershell
node --test
node src/cli.mjs --help
~~~

HTTP 統合テストは模擬 Strata バックエンドを使い、GPU がない環境でも推論料金の精算、キャッシュの計量、送金、フォローノードの同期、受領証の検証を確認できます。GPUChain のコードは [MIT ライセンス](../LICENSE) で公開しています。
