# GPUChain

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

GPUChain は、Qwen3.8-Flash-Next の推論を提供してコインを受け取る、**開発途中の実験的なネットワーク**です。自分のマシンで RYZENStrata を動かし、他の利用者のリクエストを処理します。受け取ったコインは別のウォレットに送金でき、自分の GPU を停止しているときは、他の提供者の推論に使えます。現在の実装は、署名を行う 1 台のシーケンサー、登録済みの提供者、読み取り専用のフォローノードで構成されます。[RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

**ローカルネットワークをすぐに試すには**、Node.js 24 以降を用意し、このリポジトリのルートで `node scripts/bootstrap.mjs` を実行します。初回はウォレットとジェネシスを作成し、シーケンサーと提供者アダプターを起動します。RYZENStrata の導入や既存ネットワークへの接続方法はセットアップ手順にあります。[エージェント向けセットアップ手順](../AGENTS.md)

## 料金とエポック

すべての提供者に **256K（262,144 トークン）のコンテキストウィンドウ**が必要です。GPUChain はロード済みモデルとその容量を RYZENStrata に問い合わせます。利用者はこの範囲内で入力と出力の上限に署名し、実際に処理されたトークン数に応じて支払います。

| 種類 | 100 万トークンあたりのコイン | エポックに加算 |
| --- | ---: | --- |
| キャッシュを使わずに処理した入力 | 0.15 | する |
| 生成した出力 | 0.47 | する |
| キャッシュから読み込んだ入力 | 0.016 | しない |

単価には QwenCloud の International API 料金表の数値を採用しています。台帳では 1 コインを 10 億ナノコインとして整数で扱います。たとえば入力 64 トークンのうち 32 トークンがキャッシュにヒットし、出力が 10 トークンなら、**支払額は 0.000010012 コイン、エポックへの加算は 42 トークン**です。利用者の残高から提供者に支払い、初期発行量と提供者のアドレスはジェネシスファイルで指定します。[QwenCloud 公式料金表](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

ネットワーク全体の未キャッシュ入力と生成出力の合計が **10 億トークン**に達するたびにエポックが切り替わります。シーケンサーは、次のエポックから適用するリクエストごとの出力上限を予約できます。境界をまたぐリクエストは受付時の上限で精算し、超過分を次のエポックに繰り越します。トランザクションの高さは操作を受理するたびに、エポック番号は 10 億トークンごとに進みます。

## Windows で起動する

Node.js 24 以降を用意し、各 PowerShell をこのリポジトリのルートで開きます。GPUChain 本体は Node.js の標準モジュールで動作します。提供者のマシンでは RYZENStrata を起動し、モデルをロードして `/v1/models` が利用できる状態にしてください。バックエンドの既定値は `http://127.0.0.1:8000/v1`、モデル ID は `qwen3.8-flash-next-q2_0` です。必要に応じて `--strata` と `--model-id` を指定し、バックエンドの認証には提供者プロセスの環境変数 `STRATA_API_KEY` を使います。

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
node src/cli.mjs add-provider --genesis .local/genesis.json --wallet .local/sequencer.json --address $newProviderAddress
~~~

複数マシンで運用する場合は、信頼するジェネシスファイルを配布し、各担当者が自分のウォレットを使います。台帳と提供者のエンドポイントは HTTPS で公開します。クライアントはループバックに限り HTTP も使用できます。シーケンサーは `--ledger URL`、提供者は `--provider-url URL --provider-address ADDRESS` で指定します。各プロセスは Ctrl+C で停止できます。シーケンサーを再起動するときは同じジェネシス、ウォレット、台帳ディレクトリを使います。

## 保存するデータと検証の範囲

利用者は提供者のアドレス、プロンプトのハッシュ、ノンス、トークン数の上限を指定して署名します。提供者は残高を確認し、RYZENStrata で推論します。提供者が署名する受領証には、リクエストと応答のハッシュ、トークン数が含まれます。クライアントはそれらを検証して署名し、シーケンサーに精算を申請します。署名方式は Ed25519 です。

シーケンサーは支払条件を検証し、SQLite の状態をアトミックに更新します。データベースに保持するのは最新の残高・ノンス・設定・カウンター・チェーン先端のハッシュと、完了した各エポックの 32 バイトのダイジェストです。個々の取引内容と受領証は処理中だけ使用します。プロンプトと応答は利用者と提供者の間で送受信され、提供者はプロンプトを読むことができます。提供者プロセスは再試行用に直近の応答をメモリに一時保存します。

フォローノードは信頼するジェネシスを基準に、シーケンサーのチェックポイント署名を検証します。保存済みのデータから過去の全取引を再実行することはできません。取引の順序とチェックポイントの正当性はシーケンサーを、計量値は当事者双方の署名を信頼します。GPU 実行の独立検証と、参加許可を必要としないコンセンサスは今後の課題です。精算には利用者の最終署名が必要であり、応答の後に通信が途切れたり利用者が署名を拒んだりすると、提供者が支払いを受けられない場合があります。

## テストとライセンス

~~~powershell
node --test
node src/cli.mjs --help
~~~

HTTP 統合テストは模擬 Strata バックエンドを使い、GPU がない環境でも推論料金の精算、キャッシュの計量、送金、フォローノードの同期、受領証の検証を確認できます。GPUChain のコードは [MIT ライセンス](../LICENSE) で公開しています。
