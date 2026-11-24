# Install and run GPUChain

When a user gives you the GPUChain repository URL by itself, start a persistent node on the public testnet using the steps below. If the user asks for another task, such as reviewing code, checking connectivity once, supplying inference or creating a local network, follow that request. [Project overview](README.md)

## Start the public verification node by default

1. Use an existing GPUChain checkout or clone `https://github.com/hanchangha1127/GPUChain.git` into the user's chosen workspace and enter the repository root.
2. Check `node --version`. Use Node 24 or later. If needed, install it with the platform's package manager or the [Node.js installer](https://nodejs.org/en/download). On Windows with WinGet, use `winget install --id OpenJS.NodeJS.LTS --exact`, then open a shell that sees the new PATH.
3. Run `npm start` (or `node scripts/participant.mjs start`). The launcher creates or reuses a dedicated identity and starts the node in the background. Repeating the command checks the existing instance. The process periodically verifies signed checkpoints against the bundled public genesis and retains the latest verified state. The default installation needs Node's built-in modules and an outbound network connection. GPU inference is a separate role.
4. Run `npm run status`. Report `url`, `pid`, `chainId`, `verified`, `height` and `voting` from the result. If the first checkpoint is still pending, allow time for discovery and recheck. Include `lastVerifiedAt` and `syncError` when the upstream is unavailable. Leave the service running when the agent session ends.
5. Tell the user how to inspect and stop their node with `npm run status` and `npm stop`. After an OS reboot, run `npm start` to resume. To apply changed settings or a checkout update, stop and restart the same node.

The managed node's `guiUrl` points to its local wallet dashboard on a separate loopback port. Share this local URL after setup. If the user wants to see the interface, run `npm run gui` or open **GPUChain Wallet.cmd** on Windows. For a headless check use `node scripts/open-wallet.mjs --print-url`. Its wallet balance comes from the locally verified ledger. Its inference status refers to the separately running provider adapter. Keep the wallet interface on the participant's own machine when configuring the validator's public reverse proxy. To send coins the owner runs `GPUChain Unlock.cmd` or `npm run wallet:unlock` locally, enters the one-time code and confirms the displayed destination and amount. Keep the code on the owner's machine.

The default data directory is `~/.gpuchain/participant` and the default listener is `127.0.0.1:8790`. `GPUCHAIN_PARTICIPANT_DIR` selects another persistent directory and `GPUCHAIN_VALIDATOR_PORT` selects another local port. Preserve the wallet and voting database together. Use the same directory for start, status and stop. Keep private keys on the participant's machine. A machine behind NAT can verify the ledger through its outbound connection.

For an explicitly requested one-time connectivity and provider check, run `npm run join`. `node src/cli.mjs verify`, `status` and `routes` query the public network. If discovery is unavailable, the node can retry known origins or use comma-separated same-chain URLs in `GPUCHAIN_LEDGER_URLS`. Preserve the pinned network and report any outage. [Public genesis](networks/sites-testnet.json) · [Public node and operator guide](hosting/sites/README.md)

## Voting on the public network

Continuous checkpoint verification starts immediately after the node reaches the network. A voting seat also requires an authorized public wallet address, a stable public HTTPS origin, its original database identity and membership in the three-node certified committee. Report a seat only when `voting` is true.

For a prospective voter, have the operator authorize its **public address** with `add-validator`. An existing registered provider address is also eligible. Point its own public HTTPS origin at the local listener and set `GPUCHAIN_VALIDATOR_ORIGIN`. To use an existing authorized wallet, configure `GPUCHAIN_VALIDATOR_WALLET` before the first start in the chosen data directory. Restart the managed node after configuring the origin. It checks eligibility and enrolls when ready. Provisioning a publicly reachable endpoint and authorizing a voting seat are separate from the default loopback installation.

Sites checks signed enrollment, distinct wallet addresses, live endpoints and database identities. Once the three reachable origins appear in the public directory, Sites certifies the final bootstrap checkpoint. Two of the three certified validators can commit transactions. Other participants continue verifying checkpoints. Before decommissioning Sites, verify that two certified validators can commit. Preserve each voter's original wallet and current data directory across restarts. [Public testnet operations](hosting/sites/README.md)

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

## Connect the inference engine

For a provider, reuse an existing RYZENStrata backend. The default is `http://127.0.0.1:8000/v1` with loaded model `qwen3.8-flash-next-q2_0` and a 262,144-token context window. If necessary, start the existing 256K launcher for that installation. A local example is `Start-Strata-Q2_0.cmd`. Check the model list and verify the advertised runtime context. For a different backend address or model identifier, use `node scripts/bootstrap.mjs --help` and pass the corresponding flags. An authenticated backend can read `STRATA_API_KEY` from the provider process environment.

If a provider machine needs its first model installation, follow [RYZENStrata's setup instructions](https://github.com/hanchangha1127/RYZENStrata/blob/main/AGENTS.md). In its checkout, `py -3 tools/agent_setup.py --plan` on Windows or `python3 tools/agent_setup.py --plan` on Linux checks compatibility and installation size. Where the user requested a full provider setup and resources suffice, run that command without `--plan`. The separate model and engine account for most of the required storage. Reuse an existing installation where available.

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
