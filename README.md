# GPUChain

[English](README.md) · [简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md) · [한국어](docs/README.ko.md) · [Français](docs/README.fr.md)

GPUChain is an **experimental, unfinished inference-credit network** for Qwen3.8-Flash-Next. A provider runs RYZENStrata on its own hardware and earns coins for serving text requests. Wallet holders can transfer earned coins or spend them on another provider, including while their own GPU is offline. The current implementation has one signing sequencer, registered providers and read-only follower nodes. [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

**Start a local network** with `node scripts/bootstrap.mjs` from this checkout using Node.js 24 or newer. The bootstrap creates the local wallets and genesis on first use, then starts the sequencer and provider adapter. The installation guide covers RYZENStrata setup and joining an existing network. [Agent setup guide](AGENTS.md)

## Metering and epochs

Each provider must make a **256K context window (262,144 tokens)** available. GPUChain checks RYZENStrata's loaded model and advertised capacity, then limits the signed input and output budgets to that window. Each request is billed for measured use.

| Usage | Coins per 1 million tokens | Counts toward an epoch |
| --- | ---: | --- |
| Uncached input | 0.15 | Yes |
| Generated output | 0.47 | Yes |
| Cached input | 0.016 | No |

The rates follow the numerical values of the International API tariff. Balances use integer nanocoins (one billion per coin). A receipt with 64 input tokens, including 32 cache hits, and 10 output tokens costs **0.000010012 coins** and advances the network counter by **42 tokens**. Settlement transfers coins from requester to provider. The genesis file defines the initial coin supply and approved provider addresses. [QwenCloud pricing](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

An epoch closes every **1,000,000,000 uncached input plus output tokens** across all providers. The sequencer can schedule a new per-request output limit for the next epoch. The crossing request settles under the existing limit and excess tokens carry forward. The transaction height advances for each accepted operation. The epoch number advances only at the billion-token boundary.

## Run on Windows

Use Node.js 24 or newer. Run each PowerShell block from this repository's root. The ledger, wallet, client and provider adapter use Node's built-in modules. Only the provider needs a running RYZENStrata installation, with the Qwen model loaded and `/v1/models` available. The default backend is `http://127.0.0.1:8000/v1` and the default model ID is `qwen3.8-flash-next-q2_0`. Use `--strata` and `--model-id` if your deployment differs. Set `STRATA_API_KEY` in the provider process environment if the backend requires authentication.

**Terminal 1 — create a local network and run the sequencer.** Run wallet and genesis creation once in a fresh `.local` directory. This example assigns one initial coin to the requester. Wallet files contain private keys. Keep them on their owners' machines when running separate hosts.

~~~powershell
New-Item -ItemType Directory -Force .local | Out-Null
node src/cli.mjs wallet --out .local/sequencer.json
$user = node src/cli.mjs wallet --out .local/user.json | ConvertFrom-Json
$provider = node src/cli.mjs wallet --out .local/provider.json | ConvertFrom-Json
node src/cli.mjs genesis --wallet .local/sequencer.json --out .local/genesis.json --allocation "$($user.address)=1" --provider $provider.address
node src/cli.mjs node --genesis .local/genesis.json --wallet .local/sequencer.json --dir .local/ledger
~~~

**Terminal 2 — serve the loaded model.** The adapter listens on loopback port 8789 and the sequencer on 8787.

~~~powershell
node src/cli.mjs provider --genesis .local/genesis.json --wallet .local/provider.json
~~~

**Terminal 3 — submit a prompt, inspect the balance and transfer coins.** The response includes the assistant message, measured usage, coin charge and sequencer acknowledgment. Use `--text-file FILE` for a prompt stored in a UTF-8 file.

~~~powershell
$provider = (Get-Content -Raw .local/provider.json | ConvertFrom-Json).address
node src/cli.mjs chat --genesis .local/genesis.json --wallet .local/user.json --provider-url http://127.0.0.1:8789 --provider-address $provider --text "What is a context window?" --max-input 1024 --max-output 128
node src/cli.mjs balance --genesis .local/genesis.json --address $provider
node src/cli.mjs transfer --genesis .local/genesis.json --wallet .local/user.json --to $provider --coins 0.01
node src/cli.mjs status --genesis .local/genesis.json
~~~

**Optional follower and settings.** Run the follower in another terminal. The second command verifies its signed checkpoint. The last command schedules an 8,192-token output limit at the next epoch.

~~~powershell
node src/cli.mjs follower --genesis .local/genesis.json --upstream http://127.0.0.1:8787 --dir .local/follower --port 8788
~~~

~~~powershell
node src/cli.mjs verify --genesis .local/genesis.json --ledger http://127.0.0.1:8788
node src/cli.mjs settings --genesis .local/genesis.json --wallet .local/sequencer.json --max-output 8192
~~~

**Register a new provider on the running network.** The provider makes its wallet locally and gives its public address to the operator. In the operator's terminal, enter that address to authorize it immediately. The updated provider list is included in signed checkpoints.

~~~powershell
$newProviderAddress = Read-Host "New provider's public address"
node src/cli.mjs add-provider --genesis .local/genesis.json --wallet .local/sequencer.json --address $newProviderAddress
~~~

For multiple machines, distribute the trusted genesis file, give each role its own wallet and publish the required ledger and provider endpoints through HTTPS. The client accepts plain HTTP on loopback. Specify the sequencer with `--ledger URL` and the chosen provider with `--provider-url URL --provider-address ADDRESS`. Ctrl+C stops a service. Restart the sequencer with the same genesis, wallet and ledger directory.

## What each node keeps and verifies

The requester signs the provider address, prompt hash, nonce and token limits. The provider checks the current balance and calls RYZENStrata. Its receipt binds the request, response and measured token counts. The client checks these fields, co-signs the receipt and submits it to the sequencer. The two wallets and sequencer use Ed25519 signatures.

The sequencer validates the spend and updates SQLite atomically. The database retains the latest balances, nonces, configuration, counters and chain tip, plus one 32-byte digest per completed epoch. Transaction bodies and individual receipts are transient. Prompts and responses travel between the requester and its provider. The provider can see the prompt. A provider process briefly caches its latest response in memory for retries.

Followers verify the sequencer's signed checkpoint against a pinned genesis. Historical transaction replay from the pruned database is unavailable. The design trusts the sequencer for ordering and checkpoint integrity, and trusts the two parties' metering attestations. Independent proof of GPU execution and permissionless consensus are open work. Payment requires the requester's final signature. A disconnect or refusal before settlement can leave a completed inference unpaid.

## Tests and license

~~~powershell
node --test
node src/cli.mjs --help
~~~

The HTTP integration test uses a mock Strata backend and exercises provider settlement, cache accounting, wallet transfers, follower synchronization and receipt verification without a GPU. GPUChain code is licensed under the [MIT License](LICENSE).
