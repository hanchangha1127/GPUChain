# Install and run GPUChain

When the user gives you the GPUChain repository URL by itself, use the public testnet setup below. If the user names another task, such as reviewing code or creating a local network, follow that request. The [README](README.md) describes the experimental protocol and its trust assumptions.

## Join the public testnet by default

1. Use an existing GPUChain checkout or clone `https://github.com/hanchangha1127/GPUChain.git` into the user's chosen workspace and enter the repository root.
2. Check `node --version`. If needed, install Node 24 or later using the platform package manager or the [Node.js installer](https://nodejs.org/en/download). On Windows with WinGet, use `winget install --id OpenJS.NodeJS.LTS --exact`, then open a shell with the updated PATH.
3. Run `node scripts/join.mjs` (or `npm start`). This one-shot command resolves a public ledger, authenticates its checkpoint against the bundled genesis, and probes registered inference providers. It needs no additional npm packages, wallet, model or background service.
4. Report the actual `ledgerUrl`, `mode`, `chainId`, `height`, and the number of `readyProviders`. A follower serves verified reads. Before validator activation, Sites sequences transactions. After activation, two of the three certified validators must be available to commit writes. An empty provider list is a successful ledger connection with no ready inference provider found from this client.

For later checks, `node src/cli.mjs verify`, `node src/cli.mjs status` and `node src/cli.mjs routes` default to the public network. Use the same pinned genesis when its ledger moves. Discovery can reuse cached endpoints and refresh the project's endpoint directory. If discovery fails, report the error; additional same-chain HTTPS origins supplied by the operator can be set in `GPUCHAIN_LEDGER_URLS` (comma-separated). Never substitute a fresh genesis or demo coins for a failed public join. [Public genesis](networks/sites-testnet.json) · [Public node and operator guide](hosting/sites/README.md)

Generate a wallet only when the user needs one for spending or supplying inference. For example, run `node src/cli.mjs wallet --out user.wallet.json` once and preserve this private file. To spend, the wallet needs funds on this network. To supply, give its public address and HTTPS provider origin to the operator and follow the [role commands](README.md). Use a custom network's own trusted genesis and ledger URL when explicitly requested.

## Run a public validator when requested

A wallet already registered as a provider can opt in to validating the public ledger. The validator service needs a persistent local directory, that wallet, and its own reachable public HTTPS origin. Validation runs independently of GPU inference. Point the public origin at the validator's loopback listener on port 8790 through a TLS reverse proxy. Start the following command with the actual wallet path and origin:

~~~powershell
node src/cli.mjs validator --wallet provider.wallet.json --dir .local/public-validator --origin https://validator.example.org
~~~

Sites checks signed enrollment and live challenges for three distinct wallets, origins, and database identities. Once the public endpoint directory contains the three reachable origins, Sites certifies its final state and retires its writer automatically. The validator processes discover the certificate, persist it, and commit transactions with two signatures. Before decommissioning Sites, verify that at least two validators serve the certified network and can commit. Preserve each validator's wallet and original data directory together. Reusing a key with an empty or rolled-back database can compromise voting safety. [Public testnet operations](hosting/sites/README.md)

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
