# GPUChain

[English](README.md) · [简体中文](docs/README.zh-CN.md) · [日本語](docs/README.ja.md) · [한국어](docs/README.ko.md) · [Français](docs/README.fr.md)

GPUChain runs a public mainnet pilot for paid Qwen3.8-Flash-Next inference. A provider runs Strata on its own hardware and earns coins for completed text requests. Wallet holders can transfer coins or spend them on another provider while their own GPU is offline. Sites hosts the initial sequencer. Once three authorized validators are ready, their committee can settle transactions with two votes.

The public mainnet is a small pilot named `gpuchain-mainnet-1`. Its signed in-place promotion keeps the original genesis hash, wallet addresses, balances and transaction nonces. Existing bootstrap and genesis filenames retain `testnet` for compatibility. Check the signed network state with `node src/cli.mjs verify`: the promoted checkpoint has `networkStage` equal to `mainnet`.

**Run a public mainnet node.** Give this repository URL to an agent, or clone it and run `npm start` with Node.js 24 or later. A background process creates or reuses its local identity, fetches signed checkpoints and keeps the latest verified ledger state. It continues after the terminal or agent session closes. A GPU, model download and public IP are unnecessary for this role. [Agent setup guide](AGENTS.md) · [Public mainnet operations](hosting/sites/README.md)

Run `npm run status` to see the local node's verified height and voting status. `npm stop` stops it and `npm start` resumes it with the same data. `npm run join` performs a single connectivity and provider check. Use `node scripts/bootstrap.mjs` only to create an independent local development network.

**Open the wallet.** Run `npm run gui`, or double-click **GPUChain Wallet.cmd** on Windows. It starts or reuses the participant and opens the local wallet dashboard in your browser. The dashboard shows the public wallet address and balance from its verified checkpoint, node synchronization and voting status, and the status of the local inference provider adapter. The interface listens on a separate loopback port. To print its actual URL, run `node scripts/open-wallet.mjs --print-url`. Run `GPUChain Unlock.cmd` (or `npm run wallet:unlock`) to obtain a single-use code for sending coins. Review the full recipient and exact amount, then confirm the transfer in the local wallet.

The wallet opens in English and offers Korean, Japanese, Simplified Chinese and French. On Windows, open **GPUChain Backup.cmd** to save an encrypted copy of the local signing key. Restore requires that file and its password. A voting node also needs its original, current database to retain its certified voting identity. [Backup and recovery](docs/wallet-backup.md)

## Use paid inference from another computer

On the **requesting computer**, install Node.js 24 or later and OpenCode 2.x, enter the GPUChain checkout, then run:

~~~powershell
npm run opencode:setup
~~~

Reopen OpenCode and select `gpuchain/qwen3.8-flash-next` in `/models`. The installer starts or reuses the participant and registers its loopback OpenAI-compatible base URL, normally `http://127.0.0.1:8792/v1`. OpenCode reads its inference token from a private local file. The token authorizes paid inference from the participant wallet. Keep it on that computer. The current default model stays selected until you choose GPUChain. The setup targets the OpenCode 2.x provider schema. If your config uses JSONC comments, generate the provider entry with `npm run opencode:setup -- --config NEW_FILE.json` and copy `providers.gpuchain` into your settings. [OpenCode configuration](https://opencode.ai/docs/config/)

Fund this participant's public address and use another registered provider. The gateway streams text, reasoning and tool calls while the engine generates them and delivers the final usage after settlement. Later turns prefer the same eligible provider, including after a gateway restart, so the engine can reuse a matching prefix. A cold or evicted cache or a provider change can give zero hits. The discount applies to the provider's measured `usage.prompt_tokens_details.cached_tokens`. Only keyed hashes and provider addresses with timestamps are kept for routing (up to 256 entries, 24 hours).

**Choose reasoning effort.** In the OpenCode 2.4.1 terminal UI, select GPUChain in `/models`, then press **Ctrl+T** (Cycle model variants) to choose `none`, `low`, `medium` or `high`. For one CLI run:

~~~powershell
opencode run --model "gpuchain/qwen3.8-flash-next#high" "Review this change."
~~~

The selected variant sends its `reasoning_effort` with the request. For a custom thinking budget, add a model variant such as `{"id":"high-512","body":{"reasoning_effort":"high","reasoning_budget_tokens":512}}` to the GPUChain model's `variants` and select `#high-512`. An API client can send the same two fields in its chat request. Budgets range from zero through `max_tokens`. At a positive budget, RYZENStrata begins wrapping up its reasoning, and the wrap-up can count toward reported reasoning tokens. Zero removes the explicit budget. Use an omitted or zero budget with `none` to disable thinking. Reasoning and answer tokens share the output limit, which defaults to 4,096 in the OpenCode setup. [OpenCode model variants](https://opencode.ai/docs/models/#variants)

The gateway discovers compatible providers using the public ledger. An eligible direct HTTPS endpoint or the encrypted outbound relay carries the inference. OpenCode connects to the **buyer's** loopback. The Sites origin serves the ledger and relay, and port 8080 belongs to the supplier's local engine.

For an explicit relay check from the buyer's PowerShell, confirm the displayed address is the funded wallet you intend to spend from. The final command makes a paid request. Omit `--ledger $ledger` from the commands to use automatic discovery, including after the bootstrap site retires.

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

## Verification and voting

Every default node verifies checkpoints. To enter the voting committee, it also needs an authorized wallet and its own reachable HTTPS origin. The operator can authorize the node's public address with `add-validator`; existing registered provider wallets are also eligible. Configure `GPUCHAIN_VALIDATOR_ORIGIN` to point at its listener (loopback port 8790 by default), then restart the node. Keep its wallet and database together in the persistent participant directory (`~/.gpuchain/participant` by default).

Sites certifies three ready validators and seals its final checkpoint. Two of those three must retain their voting state and communicate to settle transactions. Other participants continue to verify. [Committee activation and recovery assumptions](hosting/sites/README.md)

## Metering and epochs

The public Sites store sells GPUChain mainnet coins at **10 coins per USDT** on Ethereum and BNB Smart Chain. Register the GPUChain destination and sign the order before transferring from the paying EVM wallet. [Store](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/) · [Payment guide](docs/usdt-sales.md)

The original public genesis allocates one coin. A single sequencer-signed `issue-reserve` transaction can add exactly 1,000,000,000,000 coins to the designated distribution wallet. The chain records a permanent issuance marker. After issuance, total supply is 1,000,000,000,001 coins. Wallets and transfers use exact integer nanocoins, including amounts above JavaScript's safe integer range. The reserve is an inventory of inference credits; a proposed or published sale price does not establish a dollar redemption right.

Use `--engine ryzenstrata` (the default) for RYZENStrata or `--engine strata` for upstream Strata. Both `node src/cli.mjs provider` and `node scripts/bootstrap.mjs` accept `--engine`, `--strata` and `--model-id`. RYZENStrata defaults to `qwen3.8-flash-next-q2_0`. Upstream Strata can discover a unique eligible loaded model; specify its qualified ID when multiple models match. Only **Qwen3.8-Flash-Next** and supported quantizations of those weights qualify. Both engines must report at least **262,144 context tokens** and active **K and V caches each at Q8 or higher**. Q2_0 model weights can be paired with Q8 K/V. The adapter checks the native engine's `/metrics` model, context and KV format before generation and again before signing. Missing, low-precision or mixed K8/V4 cache evidence prevents settlement. [Upstream Strata](https://github.com/Niko1221/Strata) · [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

The running participant checks for an already loaded local Strata engine on loopback port **8080** and then **8000**. It attaches the first eligible engine to the GPUChain adapter on `127.0.0.1:8789`, including when the engine starts later. Detection reads the service health, model and KV profile without loading weights or generating tokens. Set `GPUCHAIN_STRATA_URL` to select a different local backend. Set `GPUCHAIN_AUTO_PROVIDER=0` to disable attachment. Restart the participant after changing these settings. A separately managed adapter can be selected with `GPUCHAIN_LOCAL_PROVIDER_URL`.

After the provider wallet is registered on the ledger, its eligible adapter can receive paid jobs through the encrypted outbound relay. The provider and requester use outbound HTTPS (normally port 443). The backend stays on loopback and the relay needs no inbound tunnel to the provider. Validator voting uses a separate public-origin setting and certified committee membership. An online, registered provider can earn coins for settled inference while the bootstrap sequencer still runs the ledger. GPU time is paid when a funded requester signs and settles an inference receipt. An idle engine earns no coins.

Use `node src/cli.mjs routes --transport relay` to check advertised relay providers. The default `chat --transport auto` prefers an eligible direct HTTPS route and otherwise uses the relay. `--transport direct` and `--transport relay` select one transport. A direct route requires its own registered provider HTTPS origin forwarding to port 8789. `GPUCHAIN_INFERENCE_RELAY=0` disables this participant's relay. Each direction of a relayed job supports up to 8 MiB of plaintext JSON before encryption. The model's 256K token window and the relay's byte limit are checked separately.

A requester selects `--reasoning-effort none|low|medium|high`. The CLI maps `max` and `xhigh` to `high`. `--reasoning-budget-tokens N` accepts an integer from 0 through `--max-output`. At a positive budget, RYZENStrata begins wrapping up its reasoning and can count the wrap-up in usage. Zero removes the explicit budget. Effort `none` disables thinking and requires an omitted or zero budget. Omit both options to use the engine default. Reasoning tokens share the output limit and are included once in measured output billing.

~~~powershell
node src/cli.mjs chat --wallet user.wallet.json --text "Compare these approaches." --max-input 1024 --max-output 512 --reasoning-effort high --reasoning-budget-tokens 256
~~~

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
