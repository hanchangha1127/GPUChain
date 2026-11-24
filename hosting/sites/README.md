# GPUChain public testnet

The Sites Worker accepts signed GPUChain transactions over HTTPS and stores the latest checkpoint in D1. It runs on demand even when the operator's PC is offline. GPU providers connect separately. [Live sequencer](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site) · [Current status](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/v1/status)

Use Node.js 24 or later. Run these commands from the GPUChain repository root:

~~~powershell
$ledger = 'https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site'
node src/cli.mjs verify --genesis networks/sites-testnet.json --ledger $ledger
node src/cli.mjs status --genesis networks/sites-testnet.json --ledger $ledger
node src/cli.mjs routes --genesis networks/sites-testnet.json --ledger $ledger
~~~

The pinned genesis hash is `a05901c9ffd6ba582e9d3951c0ac84927543b48b8be8a9fb43c3c5c7d49e8460`. The genesis allocates one test coin to the operator's test wallet and starts with zero providers. A new client can check the network immediately. To serve inference, the operator registers a provider address and its HTTPS origin. A funded requester can then use `chat` with the same ledger and genesis options. The client selects the lowest measured latency among available candidates. An empty route list means the probe found no ready inference provider. [Genesis file](../../networks/sites-testnet.json) · [Provider and wallet commands](../../README.md)

## Hosted state

The Worker handles `GET /v1/genesis`, `GET /v1/status`, `GET /v1/checkpoint` and `POST /v1/transactions`. It uses the same validation and accounting code as the desktop sequencer. D1 stores a compact signed snapshot. A conditional update against the previous tip allows only one competing spend to commit. This first hosted version limits its serialized checkpoint to 1,900,000 bytes. Increasing the number of accounts beyond that limit requires a storage schema upgrade.

## Building or operating the Worker

Install dependencies **only in this subdirectory** with `npm ci`, then run `npm run build`. The output is `dist/server/index.js`. For a Sites deployment, bind D1 as `DB` and apply the ledger table migration. Set `GPUCHAIN_GENESIS_JSON` to the signed genesis JSON and set `GPUCHAIN_SIGNER_PKCS8` as a secret containing the matching Ed25519 private key. The active deployment keeps its signer in Sites' secret configuration. Preserve the pinned genesis, signing authority and D1 state when publishing updates.

On the provisioning Windows machine the operator recovery bundle is encrypted under the provisioning user's Windows DPAPI profile. It contains the sequencer and the separately funded operator wallet. Preserve the Windows profile and its recovery material together with the bundle. For local operator commands, the GPUChain CLI accepts wallet JSON via a private pipe using `--wallet -`. Keep decrypted keys out of terminal output, repository files, command arguments and chat messages.
