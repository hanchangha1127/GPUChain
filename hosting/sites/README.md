# GPUChain public mainnet operations

The public network is identified by its pinned genesis. Sites hosts its initial sequencer. Three eligible, independently operated validators can automatically take over the same chain. GPU providers connect separately. [Initial Sites sequencer](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/ledger) · [Ledger endpoint directory](../../networks/testnet-endpoints.json)

Use Node.js 24 or later. Run these commands from the GPUChain repository root:

~~~powershell
npm start
npm run status
node src/cli.mjs verify
node src/cli.mjs status
node src/cli.mjs routes
~~~

The pinned genesis hash is `a05901c9ffd6ba582e9d3951c0ac84927543b48b8be8a9fb43c3c5c7d49e8460`. The genesis allocates one coin to the operator's wallet and starts with zero providers. A new client can check the network immediately. To serve inference, the operator registers a provider address and its HTTPS origin. A funded requester can then use `chat` with the same ledger and genesis options. The client selects the lowest measured latency among available candidates. An empty route list means the probe found no ready inference provider. [Genesis file](../../networks/sites-testnet.json) · [Provider and wallet commands](../../README.md)

The public mainnet is a small pilot named `gpuchain-mainnet-1`. Its signed in-place promotion keeps the original genesis hash, wallet addresses, balances and transaction nonces. Existing bootstrap and genesis filenames retain `testnet` for compatibility. Check the signed network state with `node src/cli.mjs verify`: the promoted checkpoint has `networkStage` equal to `mainnet`.

The bootstrap operator authorizes public providers and validator candidates. The public site offers one 1,000-coin starter grant per recorded mainnet wallet from a reserve-authorized lifetime budget. A local wallet address becomes eligible after it appears in the verified ledger. USDT intake is paused on both networks. Historical payment reconciliation continues for previously accepted orders. [Site](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/) · [Historical payment recovery](../../docs/usdt-sales.md)

## Hosted state

The reserve owner records the sale price with `node src/cli.mjs configure-sale-price --wallet RESERVE_WALLET`. The signed configuration sets 2 coins per USDT (0.5 USDT per coin). After deployment, verify the signed checkpoint and both networks’ paused status at `/v1/sales/status`. The storefront shows starter grants, the payment pause notice and existing order lookup. Existing paid orders use their original terms.

The starter grant is independent of the sale mandate. The reserve owner signs `node src/cli.mjs authorize-starter-grants --wallet RESERVE_WALLET --coins 1000000000`. Sites can then move exactly 1,000 existing reserve coins to each eligible recorded address once. `GET /v1/starter/status?address=PUBLIC_ADDRESS` checks eligibility, and `POST /v1/starter/claim` accepts a JSON object with a single `address`. Refreshing the page or submitting the same claim concurrently can credit the address only once. Use `suspend-starter-grants` to close new grants. Previous claims continue counting toward the lifetime budget.

The one-million-wallet allocation is a financial ceiling. The bootstrap’s single checkpoint has a 1,900,000-byte limit shared by balances and grant records. Hosted claims pause before that limit to leave room for existing obligations and committee handover. Serving a million distinct accounts requires ledger storage and synchronization that can accommodate their state.

The Worker serves the genesis, status and checkpoint, accepts signed transactions, and accepts signed validator opt-ins at `POST /v1/consensus/enroll`. The candidate feed is `GET /v1/consensus/candidates`. It uses the same validation and accounting code as the desktop sequencer. D1 stores a compact signed snapshot. A conditional update against the previous tip allows only one competing spend to commit. This first hosted version limits its serialized checkpoint to 1,900,000 bytes. Increasing the number of accounts beyond that limit requires a storage schema upgrade.

## Automatic community consensus

Joining with a repository URL starts a persistent local verification node. It authenticates and stores the latest checkpoint using an outbound connection. The command `npm run status` reports whether it is verifying or voting. Use `npm stop` to stop it and `npm run join` for a one-time connectivity check. These commands work independently of RYZENStrata.

The voting committee has three seats. The sequencer operator can authorize a verification-only wallet using the following command with the participant's public address. An existing registered inference provider wallet is also eligible.

~~~powershell
node src/cli.mjs add-validator --wallet sequencer.wallet.json --address $participantAddress
~~~

The participant points a stable public HTTPS origin at their node, sets `GPUCHAIN_VALIDATOR_ORIGIN` and restarts it. The default listener is `127.0.0.1:8790`. Use the same wallet, data directory and public origin after voting starts. Enrollment proves control of each wallet, endpoint and database identity. Independent hardware and operators are an operational assumption.

1. Before activation, validators periodically send signed opt-ins and answer fresh readiness challenges. The signed identities include each validator's durable database ID.
2. The GitHub Actions directory publisher runs at minutes 07, 22, 37 and 52 of each hour. It verifies the public genesis, candidate eligibility and signed announcements before publishing origins. Scheduled jobs can start later. All three selected origins must already be published in the repository's main branch, so a fresh clone has contact points. While the directory is unavailable, Sites continues serving ordinary transactions.
3. Once the requirements are met, Sites uses a conditional D1 update to seal its final checkpoint and certify the three validators. Concurrent enrollment or payment changes trigger a retry. Balances, nonces, registered providers, token counters and epoch history carry over. The validators fetch the certificate and propagate it among the named peers. The bootstrap signing key stays with its owner.
4. Clients verify the certified roster, then check **two distinct signatures out of three** for each confirmed payment or inference receipt. Sites can go offline once at least two validators have durably adopted the same authority. A fresh clone uses the published origins. A returning client can use cached origins through a GitHub outage. An explicit `--ledger` or `--upstream` pins the caller to the specified address.
5. One stopped validator leaves a majority. With one survivor, a previously confirmed checkpoint can be read, and new transactions require a majority to return. Losing the only bootstrap before activation and distribution of the certificate can interrupt the network.

The implementation uses per-height Paxos ballots and a fixed committee. Safety assumes honest protocol execution and durable promises. Keep each voter's current SQLite files together with its wallet. Cloning running identities or rolling back voter storage violates this assumption. A fresh database has a new identity and cannot replace the old voter. Byzantine tolerance and automatic replacement of lost committee seats remain open work. The original signed authorization for registering GPU providers and scheduling settings still applies. [Paxos Made Simple](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf)

Inspect the local node with `npm run status` and the network with `node src/cli.mjs status` and `node src/cli.mjs verify`. The initial writer reports `sequencer`. The local node reports its verified height and voting status. At activation Sites reports `retired` and committee members report `validator`. Nodes retain the latest state, proofs and epoch digests. Voting nodes also preserve the unresolved vote needed for crash recovery. Committing a slot releases its pending transaction.

## Building or operating the Worker

Install dependencies **only in this subdirectory** with `npm ci`, then run `npm run build`. The output is `dist/server/index.js`. For a Sites deployment, bind D1 as `DB` and apply the ledger table migration. Set `GPUCHAIN_GENESIS_JSON` to the signed genesis JSON and set `GPUCHAIN_SIGNER_PKCS8` as a secret containing the matching Ed25519 private key. The active deployment keeps its signer in Sites' secret configuration. Preserve the pinned genesis, signing authority and D1 state when publishing updates.

On the provisioning Windows machine the operator recovery bundle is encrypted under the provisioning user's Windows DPAPI profile. It contains the sequencer and the separately funded operator wallet. Preserve the Windows profile and its recovery material together with the bundle. For local operator commands, the GPUChain CLI accepts wallet JSON via a private pipe using `--wallet -`. Keep decrypted keys out of terminal output, repository files, command arguments and chat messages.
