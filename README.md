# GPUChain

[English](README.md) · [简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md) · [한국어](docs/README.ko.md) · [Français](docs/README.fr.md)

GPUChain runs a public mainnet pilot for paid Qwen3.8-Flash-Next inference. A provider runs Strata on its own hardware and earns coins for completed text requests. Wallet holders can transfer coins or spend them on another provider while their own GPU is offline. Sites hosts the initial sequencer. Once three authorized validators are ready, their committee can settle transactions with two votes.

The public mainnet is a small pilot named `gpuchain-mainnet-1`. Its signed in-place promotion keeps the original genesis hash, wallet addresses, balances and transaction nonces. Existing bootstrap and genesis filenames retain `testnet` for compatibility. Check the signed network state with `node src/cli.mjs verify`: the promoted checkpoint has `networkStage` equal to `mainnet`.

**Run a public mainnet node.** Give this repository URL to an agent, or clone it and run `npm start` with Node.js 24 or later. A background process creates or reuses its local identity, fetches signed checkpoints and keeps the latest verified ledger state. It continues after the terminal or agent session closes. A GPU, model download and public IP are unnecessary for this role. [Agent setup guide](AGENTS.md) · [Public mainnet operations](hosting/sites/README.md)

Run `npm run status` to see the local node's verified height and voting status. `npm stop` stops it and `npm start` resumes it with the same data. `npm run join` performs a single connectivity and provider check. Use `node scripts/bootstrap.mjs` only to create an independent local development network.

**Open the wallet.** Run `npm run gui`, or double-click **GPUChain Wallet.cmd** on Windows. It starts or reuses the participant and opens the local wallet dashboard in your browser. The dashboard shows the public wallet address and balance from its verified checkpoint, node synchronization and voting status, and the status of the local inference provider adapter. The interface listens on a separate loopback port. To print its actual URL, run `node scripts/open-wallet.mjs --print-url`. Run `GPUChain Unlock.cmd` (or `npm run wallet:unlock`) to obtain a single-use code for sending coins. Review the full recipient and exact amount, then confirm the transfer in the local wallet.

The wallet opens in English and offers Korean, Japanese, Simplified Chinese and French. On Windows, open **GPUChain Backup.cmd** to save an encrypted copy of the local signing key. Restore requires that file and its password. A voting node also needs its original, current database to retain its certified voting identity. [Backup and recovery](docs/wallet-backup.md)

## Verification and voting

Every default node verifies checkpoints. To enter the voting committee, it also needs an authorized wallet and its own reachable HTTPS origin. The operator can authorize the node's public address with `add-validator`; existing registered provider wallets are also eligible. Configure `GPUCHAIN_VALIDATOR_ORIGIN` to point at its listener (loopback port 8790 by default), then restart the node. Keep its wallet and database together in the persistent participant directory (`~/.gpuchain/participant` by default).

Sites certifies three ready validators and seals its final checkpoint. Two of those three must retain their voting state and communicate to settle transactions. Other participants continue to verify. [Committee activation and recovery assumptions](hosting/sites/README.md)

## Metering and epochs

The public Sites store sells GPUChain mainnet coins at **10 coins per USDT** on Ethereum and BNB Smart Chain. Register the GPUChain destination and sign the order before transferring from the paying EVM wallet. [Store](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/) · [Payment guide](docs/usdt-sales.md)

The original public genesis allocates one coin. A single sequencer-signed `issue-reserve` transaction can add exactly 1,000,000,000,000 coins to the designated distribution wallet. The chain records a permanent issuance marker. After issuance, total supply is 1,000,000,000,001 coins. Wallets and transfers use exact integer nanocoins, including amounts above JavaScript's safe integer range. The reserve is an inventory of inference credits; a proposed or published sale price does not establish a dollar redemption right.

Use `--engine ryzenstrata` (the default) for RYZENStrata or `--engine strata` for upstream Strata. Both `node src/cli.mjs provider` and `node scripts/bootstrap.mjs` accept `--engine`, `--strata` and `--model-id`. RYZENStrata defaults to `qwen3.8-flash-next-q2_0`. Upstream Strata can discover a unique eligible loaded model; specify its qualified ID when multiple models match. Only **Qwen3.8-Flash-Next** and supported quantizations of those weights qualify. Both engines must report at least **262,144 context tokens** and active **K and V caches each at Q8 or higher**. Q2_0 model weights can be paired with Q8 K/V. The adapter checks the native engine's `/metrics` model, context and KV format before generation and again before signing. Missing, low-precision or mixed K8/V4 cache evidence prevents settlement. [Upstream Strata](https://github.com/Niko1221/Strata) · [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

For public inference, the requester uses outbound HTTPS (normally port 443) to the ledger and the selected provider. Submit signed requests with `node src/cli.mjs chat`. GPUChain does not expose a LAN OpenAI-compatible consumer gateway. On a provider machine, terminate public HTTPS at the GPUChain adapter on loopback port 8789. The adapter calls the private Strata backend, by default `http://127.0.0.1:8000/v1`.

| Usage | Coins per 1 million tokens | Counts toward an epoch |
| --- | ---: | --- |
| Uncached input | 0.15 | Yes |
| Generated output | 0.47 | Yes |
| Cached input | 0.016 | No |

The rates follow the numerical values of the International API tariff. Balances use integer nanocoins (one billion per coin). A receipt with 64 input tokens, including 32 cache hits, and 10 output tokens costs **0.000010012 coins** and advances the network counter by **42 tokens**. Settlement transfers coins from requester to provider. The genesis file defines the initial coin supply and approved provider addresses. [QwenCloud pricing](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

An epoch closes every **1,000,000,000 uncached input plus output tokens** across all providers. The sequencer can schedule a new per-request output limit for the next epoch. The crossing request settles under the existing limit and excess tokens carry forward. The transaction height advances for each accepted operation. The epoch number advances only at the billion-token boundary.

## Run an independent local network on Windows

Use Node.js 24 or newer. Run each PowerShell block from the repository root. The requester, ledger and provider adapter use built-in Node modules. Start the chosen inference engine on the provider machine and set `STRATA_API_KEY` in the provider environment if its backend requires authentication.

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
$providerOrigin = Read-Host "Provider HTTPS origin (for example https://gpu.example.com)"
node src/cli.mjs add-provider --genesis .local/genesis.json --wallet .local/sequencer.json --address $newProviderAddress --url $providerOrigin
~~~

For multiple machines, distribute the trusted genesis file, expose the ledger and provider endpoints over HTTPS and pass the ledger origin with `--ledger URL`. The operator can update an existing listing with `set-provider-endpoint --address ADDRESS --url URL`, or remove its URL with `--withdraw`; both operations require the sequencer wallet and genesis. The local bootstrap advertises its loopback provider automatically. The separate-role quickstart above pins a provider explicitly.

**Select a nearby provider automatically.** Omit both provider flags on `chat`. The client samples up to 64 advertised providers within a three-second budget and ranks eligible replies by the median of up to three HTTP round trips (HTTPS for remote nodes). Each signed probe checks the chain, provider identity, model, available capacity and output limit. This measures responsiveness from the requesting machine; geography and generation speed can differ. Only the selected provider receives the prompt. For a fixed provider, pass both `--provider-url URL` and `--provider-address ADDRESS`.

~~~powershell
node src/cli.mjs routes --genesis .local/genesis.json
node src/cli.mjs chat --genesis .local/genesis.json --wallet .local/user.json --text "Hello" --max-input 1024 --max-output 128
~~~

Ctrl+C stops a service. Restart the sequencer with the same genesis, wallet and ledger directory.

## What each node keeps and verifies

The requester signs the provider address, prompt hash, nonce and token limits. The provider checks the current balance and calls the selected Strata backend. Its receipt binds the request, response and measured token counts. The client checks these fields, co-signs the receipt and submits it to the sequencer. The two wallets and sequencer use Ed25519 signatures.

The sequencer validates the spend and updates SQLite atomically. The database retains the latest balances, nonces, configuration, counters and chain tip, plus one 32-byte digest per completed epoch. Transaction bodies and individual receipts are transient. Prompts and responses travel between the requester and its provider. The provider can see the prompt. A provider process briefly caches its latest response in memory for retries.

Followers verify checkpoints against the pinned genesis, using the sequencer signature during bootstrap and a validator majority after activation. The pruned database retains current state and epoch hashes. Replaying historical transactions would require their original records. Metering trusts the two parties' attestations. Independent proof of GPU execution and permissionless validator membership remain open work. Payment requires the requester's final signature. A disconnect or refusal before settlement can leave a completed inference unpaid.

## Tests and license

~~~powershell
node --test
node src/cli.mjs --help
~~~

The HTTP integration test uses a mock Strata backend and exercises provider settlement, cache accounting, wallet transfers, follower synchronization and receipt verification without a GPU. GPUChain code is licensed under the [MIT License](LICENSE).
