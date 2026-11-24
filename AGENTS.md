# Install and run GPUChain

Use these instructions when the user gives you this repository and asks you to install or run it. The root [README](README.md) describes the experimental protocol and its trust assumptions.

## Choose the requested network

For the project's public testnet, use `networks/sites-testnet.json` and the HTTPS ledger in the [hosted node guide](hosting/sites/README.md). Use `verify` to check the pinned network, then `routes` to find ready inference providers from this client.

For a new local installation, use the bootstrap below. It starts a loopback sequencer and provider adapter with a local test coin supply. For an **existing network**, obtain its trusted genesis file and ledger URL from the operator and follow the separate-role commands in the README. A new local genesis creates its own currency. A consumer needs Node, a funded wallet, the trusted genesis and the ledger URL. Automatic routing discovers advertised providers from a signed checkpoint. Operators publish their HTTPS origins with `add-provider --url` or `set-provider-endpoint`.

## Set up a local installation

1. Work in the user's chosen directory. For a new checkout, run `git clone https://github.com/hanchangha1127/GPUChain.git` and enter `GPUChain`. For an existing checkout, use it directly.
2. Check `node --version`. Use Node 24 or newer with its built-in SQLite module. If missing, install the current supported Node LTS through the platform's package manager or the [official Node installer](https://nodejs.org/en/download). On Windows with WinGet, run `winget install --id OpenJS.NodeJS.LTS --exact`, then start a shell that sees the new PATH. No npm packages or build step are required.
3. Run `node --test`. The tests use ephemeral ports and temporary wallets.
4. Run `node scripts/bootstrap.mjs` from the repository root as a long-running process. In an interactive shell it stays in the foreground. When acting as an installation agent, keep the process running after setup and record its PID. On Windows, a background start from PowerShell is:

~~~powershell
$runner = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'scripts/bootstrap.mjs' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru
$runner.Id
~~~

5. Check `node src/cli.mjs verify --genesis .local/genesis.json`. Allow the service a few seconds to start. Check `http://127.0.0.1:8789/v1/info` for the loaded provider. Report the ledger and provider readiness independently.

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
