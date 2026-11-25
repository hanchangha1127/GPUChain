# Install and run GPUChain

When a user gives you the GPUChain repository URL by itself, start a persistent node on the public mainnet using the steps below. If the user asks for another task, such as reviewing code, checking connectivity once, supplying inference or creating a local network, follow that request. [Project overview](README.md)

## Publish improvements from the maintainer's release workstation

For an authorized mainnet release, test the change, push it to GitHub, publish updated Sites code and migrations to the existing public ledger, and verify its signed checkpoint. Apply the same Git commit to the installed checkout at `%USERPROFILE%\Desktop\Node` with a fast-forward update. Restart the managed participant when current jobs have finished and verify its commit, wallet address, database identity, gateway and authenticated network stage before reporting completion. Preserve its data directory and local keys.

## Start the public verification node by default

1. Use an existing GPUChain checkout or clone `https://github.com/hanchangha1127/GPUChain.git` into the user's chosen workspace and enter the repository root.
2. Check `node --version`. Use Node 24 or later. If needed, install it with the platform's package manager or the [Node.js installer](https://nodejs.org/en/download). On Windows with WinGet, use `winget install --id OpenJS.NodeJS.LTS --exact`, then open a shell that sees the new PATH.
3. Run `npm start` (or `node scripts/participant.mjs start`). The launcher creates or reuses a dedicated identity and starts the node in the background. Repeating the command checks the existing instance. The process periodically verifies signed checkpoints against the bundled public genesis and retains the latest verified state. The default installation needs Node's built-in modules and an outbound network connection. GPU inference is a separate role.
4. Run `npm run status`. Report `url`, `pid`, `chainId`, `verified`, `height` and `voting` from the result. If the first checkpoint is still pending, allow time for discovery and recheck. Include `lastVerifiedAt` and `syncError` when the upstream is unavailable. Leave the service running when the agent session ends. Confirm `networkId` and `networkStage` with `node src/cli.mjs verify`; report the stage actually authenticated.
5. Tell the user how to inspect and stop their node with `npm run status` and `npm stop`. After an OS reboot, run `npm start` to resume. To apply changed settings or a checkout update, stop and restart the same node.

The managed node's `guiUrl` points to its local wallet dashboard on a separate loopback port. Share this local URL after setup. If the user wants to see the interface, run `npm run gui` or open **GPUChain Wallet.cmd** on Windows. For a headless check use `node scripts/open-wallet.mjs --print-url`. Its wallet balance comes from the locally verified ledger. Its inference status refers to the separately running provider adapter. Keep the wallet interface on the participant's own machine when configuring the validator's public reverse proxy. To send coins the owner runs `GPUChain Unlock.cmd` or `npm run wallet:unlock` locally, enters the one-time code and confirms the displayed destination and amount. Keep the code on the owner's machine. The GUI defaults to English and has a five-language selector. To back up this user's signing key, use **GPUChain Backup.cmd** or the offline backup CLI. [Wallet backup](docs/wallet-backup.md)

The default data directory is `~/.gpuchain/participant` and the default listener is `127.0.0.1:8790`. `GPUCHAIN_PARTICIPANT_DIR` selects another persistent directory and `GPUCHAIN_VALIDATOR_PORT` selects another local port. Preserve the wallet and voting database together. Use the same directory for start, status and stop. Keep private keys on the participant's machine. A machine behind NAT can verify the ledger through its outbound connection.

For an explicitly requested one-time connectivity and provider check, run `npm run join`. `node src/cli.mjs verify`, `status` and `routes` query the public network. If discovery is unavailable, the node can retry known origins or use comma-separated same-chain URLs in `GPUCHAIN_LEDGER_URLS`. Preserve the pinned network and report any outage. [Public genesis](networks/sites-testnet.json) · [Public node and operator guide](hosting/sites/README.md)

The public mainnet is a small pilot named `gpuchain-mainnet-1`. Its signed in-place promotion keeps the original genesis hash, wallet addresses, balances and transaction nonces. Existing bootstrap and genesis filenames retain `testnet` for compatibility. Check the signed network state with `node src/cli.mjs verify`: the promoted checkpoint has `networkStage` equal to `mainnet`.

On Windows, an upgraded managed start converts the verified legacy participant key to current-user DPAPI with an owner-only ACL. Preserve the address and validator database. Use the portable encrypted backup for recovery under another Windows profile. The current OS user shares a per-chain, per-wallet spend lock across the GUI, CLI and OpenCode. To reconcile a pending inference without generating another completion, run `node src/cli.mjs recover-settlement --wallet WALLET_FILE`. Report any unconfirmed outcome to the owner before another inference.

## Voting on the public network

Continuous checkpoint verification starts immediately after the node reaches the network. A voting seat also requires an authorized public wallet address, a stable public HTTPS origin, its original database identity and membership in the three-node certified committee. Report a seat only when `voting` is true.

For a prospective voter, have the operator authorize its **public address** with `add-validator`. An existing registered provider address is also eligible. Point its own public HTTPS origin at the local listener and set `GPUCHAIN_VALIDATOR_ORIGIN`. To use an existing authorized wallet, configure `GPUCHAIN_VALIDATOR_WALLET` before the first start in the chosen data directory. Restart the managed node after configuring the origin. It checks eligibility and enrolls when ready. Provisioning a publicly reachable endpoint and authorizing a voting seat are separate from the default loopback installation.

Sites checks signed enrollment, distinct wallet addresses, live endpoints and database identities. Once the three reachable origins appear in the public directory, Sites certifies the final bootstrap checkpoint. Two of the three certified validators can commit transactions. Other participants continue verifying checkpoints. Before decommissioning Sites, verify that two certified validators can commit. Preserve each voter's original wallet and current data directory across restarts. [Public mainnet operations](hosting/sites/README.md)

## Start an independent local network on request

Use this workflow only if the user requests an isolated development network. Its own genesis, wallets and coin supply belong to that local chain.

1. Prepare the checkout and Node runtime as above. Run `node --test --test-concurrency=1` to check the installation. Tests use ephemeral ports and temporary wallets.
2. Run `node scripts/bootstrap.mjs` from the repository root as a long-running process. In an interactive shell it stays in the foreground. When acting as an installation agent, keep this requested service running and record its PID. On Windows, a background start from PowerShell is:

~~~powershell
$runner = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'scripts/bootstrap.mjs' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru
$runner.Id
~~~

3. Check `node src/cli.mjs verify --genesis .local/genesis.json`. Allow the service a few seconds to start. Check `http://127.0.0.1:8789/v1/info` for the loaded provider. Report the ledger and provider readiness independently.

The bootstrap reuses the local wallet files and ledger on subsequent runs. The test network assigns one coin to the user wallet on its first creation. Preserve the entire `.local` directory between runs. Wallet JSON contains Ed25519 private keys. Share the public address or public genesis file when connecting peers. Keep the private files on their owners' machines.

## Set up inference on a requesting computer

When the user asks to use GPUChain from OpenCode, run `npm run opencode:setup` **on the requesting computer**, from this checkout, with Node.js 24 or later and OpenCode 2.x. The script starts the participant, enables its local OpenAI-compatible gateway and merges the GPUChain provider into the user's config. With an older running participant, apply the checkout update and restart that same participant. For JSONC with comments, generate a separate file with `npm run opencode:setup -- --config NEW_FILE.json` and merge only its `providers.gpuchain` entry, preserving comments. Tell the user to reopen OpenCode and select `gpuchain/qwen3.8-flash-next` using `/models`. Use the reported `openAiUrl`, normally `http://127.0.0.1:8792/v1`. Keep the participant's `opencode.token` local. It authorizes spending on inference. Setup verifies authenticated model discovery without generating tokens.

To select inference reasoning on OpenCode 2.4.1, select GPUChain in `/models` and press **Ctrl+T** in the terminal UI to cycle model variants. The four configured variants are `none`, `low`, `medium` and `high`. The exact one-run selector is `opencode run --model "gpuchain/qwen3.8-flash-next#high" "Review this change."`. Use a model variant's `body` to request a fixed thinking budget, for example `{"id":"high-512","body":{"reasoning_effort":"high","reasoning_budget_tokens":512}}`. A raw chat request accepts those same body fields. Setup sets `max_tokens` to at most 4,096 for OpenCode by default. Thinking tokens share this output limit. A budget must be between zero and the requested output limit, and effort `none` accepts only zero or an omitted budget. [OpenCode model variants](https://opencode.ai/docs/models/#variants)

For a requester asking which address to use, distinguish the buyer's loopback API, the public ledger/relay and the provider's private engine on 8080. OpenCode sends chat requests to the buyer's gateway. The gateway requires the encrypted relay for remote inference. Routing keeps up to 256 keyed records for 60 minutes after successful settlement and prefers the previous provider for the same session or longest compatible prefix. A preferred relay provider gets a short availability check before fallback. The engine manages KV eviction. The final receipt supplies the actual cached token count. Check that the requesting participant has the expected funded address and that a different eligible provider is available. Run the following commands on Windows when the user requests a paid CLI inference test. The public ledger pin is optional. Omit `--ledger $ledger` to allow discovery of successor origins.

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

## Connect the inference engine

Use `--engine ryzenstrata` (the default) for RYZENStrata or `--engine strata` for upstream Strata. Both `node src/cli.mjs provider` and `node scripts/bootstrap.mjs` accept `--engine`, `--strata` and `--model-id`. RYZENStrata defaults to `qwen3.8-flash-next-q2_0`. Upstream Strata can discover a unique eligible loaded model; specify its qualified ID when multiple models match. Only **Qwen3.8-Flash-Next** and supported quantizations of those weights qualify. Both engines must report at least **262,144 context tokens** and active **K and V caches each at Q8 or higher**. Q2_0 model weights can be paired with Q8 K/V. The adapter checks the native engine's `/metrics` model, context and KV format before generation and again before signing. Missing, low-precision or mixed K8/V4 cache evidence prevents settlement. [Upstream Strata](https://github.com/Niko1221/Strata) · [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

The running participant checks for an already loaded local Strata engine on loopback port **8080** and then **8000**. It attaches the first eligible engine to the GPUChain adapter on `127.0.0.1:8789`, including when the engine starts later. Detection reads the service health, model and KV profile without loading weights or generating tokens. Set `GPUCHAIN_STRATA_URL` to select a different local backend. Set `GPUCHAIN_AUTO_PROVIDER=0` to disable attachment. Restart the participant after changing these settings. A separately managed adapter can be selected with `GPUCHAIN_LOCAL_PROVIDER_URL`.

After the provider wallet is registered on the ledger, its eligible adapter can receive paid jobs through the encrypted outbound relay. The provider and requester use outbound HTTPS (normally port 443). The backend stays on loopback and the relay needs no inbound tunnel to the provider. Validator voting uses a separate public-origin setting and certified committee membership. An online, registered provider can earn coins for settled inference while the bootstrap sequencer still runs the ledger. GPU time is paid when a funded requester signs and settles an inference receipt. An idle engine earns no coins. Keep `api_monitor` and `STRATA_DEBUG` off and leave `slot_save_path` unset for a public provider. If this RYZENStrata build supports automatic SSD conversation spill, `--conversation-spill-mib 0` keeps parked KV in RAM. The adapter rejects a reachable request monitor before generation. The provider host remains trusted with plaintext during inference.

Use `node src/cli.mjs routes --transport relay` to check advertised relay providers. Public `chat` uses the encrypted relay by default. Explicit `--transport auto` prefers an eligible direct HTTPS route and uses the relay otherwise. `--transport direct` and `--transport relay` select one transport. A direct route requires its own registered provider HTTPS origin forwarding to port 8789. `GPUCHAIN_INFERENCE_RELAY=0` disables this participant's relay. Each direction of a relayed job supports up to 8 MiB of plaintext JSON before encryption. The model's 256K token window and the relay's byte limit are checked separately.

A requester selects `--reasoning-effort none|low|medium|high`. The CLI maps `max` and `xhigh` to `high`. `--reasoning-budget-tokens N` accepts an integer from 0 through `--max-output`. At a positive budget, RYZENStrata begins wrapping up its reasoning and can count the wrap-up in usage. Zero removes the explicit budget. Effort `none` disables thinking and requires an omitted or zero budget. Omit both options to use the engine default. Reasoning tokens share the output limit and are included once in measured output billing.

~~~powershell
node src/cli.mjs chat --wallet user.wallet.json --text "Compare these approaches." --max-input 1024 --max-output 512 --reasoning-effort high --reasoning-budget-tokens 256
~~~

For a provider using RYZENStrata that needs its first model installation, follow [RYZENStrata's setup instructions](https://github.com/hanchangha1127/RYZENStrata/blob/main/AGENTS.md). In its checkout, `py -3 tools/agent_setup.py --plan` on Windows or `python3 tools/agent_setup.py --plan` on Linux checks compatibility and installation size. Where the user requested a full provider setup and resources suffice, run that command without `--plan`. The separate model and engine account for most of the required storage. Reuse an existing installation where available.

## Verify inference and report

In a second PowerShell terminal, send a small request on the **local bootstrap network** after the provider is ready:

~~~powershell
$provider = (Get-Content -Raw .local/provider.json | ConvertFrom-Json).address
node src/cli.mjs routes --genesis .local/genesis.json
node src/cli.mjs chat --genesis .local/genesis.json --wallet .local/user.json --text "Reply with OK." --max-input 1024 --max-output 32
node src/cli.mjs balance --genesis .local/genesis.json --address $provider
node src/cli.mjs status --genesis .local/genesis.json
~~~

Record the endpoint, genesis hash, test results, charged coins, and the provider's resulting balance. If the backend is unavailable, report the HTTP error and the ledger's actual state. A passing test with the fixture establishes the integration contract. A successful chat with loaded weights establishes live inference.

Use Ctrl+C for a foreground process. To stop a background instance, target the PID you started. On restart, use the same data directory. The role-specific CLI also supports a verifying follower, wallet transfers and next-epoch settings. See `node src/cli.mjs --help`.
