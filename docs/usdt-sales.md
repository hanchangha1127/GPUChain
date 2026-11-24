# Buying GPUChain mainnet coins

Open the [official store](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/). One USDT buys **10 GPUChain mainnet coins**. One coin costs 0.1 USDT. For example, a finalized payment of 2.5 USDT delivers exactly 25 coins. The merchant receives USDT at `0xe0c5E4e14D70f6DB63E67301d34199d696678a2C` on either supported network.

Orders deliver to the `gpuchain-mainnet-1` pilot on the existing GPUChain genesis. Use the local wallet's public address, and confirm the verified mainnet stage with `node src/cli.mjs verify`. Live availability depends on remaining inventory, the active sale mandate, chain finality and agreement between independent RPC readers. [Mainnet operations](../hosting/sites/README.md)

| Network | Token contract | Token decimals | Gas currency |
|---|---|---:|---|
| Ethereum mainnet (1) | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 | ETH |
| BNB Smart Chain (56) | `0x55d398326f99059fF775485246999027B3197955` (Binance-Peg USDT) | 18 | BNB |

## Register the destination before paying

1. Paste the **GPUChain public address** from your local wallet. Select a network and amount, then connect the self-custody EVM wallet you will pay from. These are two different addresses. An exchange withdrawal or smart-contract wallet is unsupported by this direct-transfer checkout.
2. Review and sign the order message in the paying wallet. The signature binds the payer, destination, amount, network, token, merchant and time window. This step reserves an order. Keep its ID. Wait for the store to show that payment is available for that order.
3. Approve one ordinary USDT transfer for the precise quantity to the displayed address in the same wallet and network. Confirm before the quote deadline. GPUChain charges **zero** for the delivery. The EVM wallet displays its network gas fee separately.
4. The hosted Worker checks finalized blocks and transfer events with two independent Ethereum or BSC RPC providers. It checks the actual contract, sender, destination, amount, block, successful receipt and signed order before requesting settlement. A matching transfer triggers delivery to the registered GPUChain address, including when the buyer closes the tab and the operator's PC is offline. Order status also supports a transaction-hash hint for faster reconciliation.

Payments may take longer during finality delays, RPC outages, GitHub scheduler delays or interrupted ledger consensus. Use the original order ID to check status. A late, duplicate, wrong-network or mismatched payment can require merchant review. Preserve the order ID and public transaction hash. Do not send another payment to fix a pending order. The price is a sale price for experimental inference credits. There is no guaranteed resale price or redemption for USDT.

## Operation

The reserve owner signs a cumulative sale allowance. A separate hosted key can attest paid deliveries under the fixed network, token, merchant and price rules. The reserve owner's key stays on the owner machine. Each sale reduces the existing GPUChain reserve and credits the recipient equally. The single one-trillion-coin issuance cannot be repeated. `suspend-sales` lets the owner stop the allowance; plan suspension around outstanding payments.

D1 retains order reservations, a unique payment reference and durable delivery state so retries and worker restarts can recover without paying twice. This purchase bookkeeping is separate from the compact public ledger. New orders require live stock, healthy RPCs and a recent authenticated reconciliation run. The repository's scheduled job wakes the Sites Worker approximately every five minutes. The Worker performs payment verification and settlement; the scheduled runner holds only the credential for waking it. A separate obligation of the operator is to maintain the oracle, keep reserve assets available for accepted orders and check the rules applicable to real-money sales in the jurisdiction of operation.

[USDT contract documentation](https://tether.to/en/supported-protocols/) · [BNB Chain token definitions](https://github.com/bnb-chain/mpp-sdk) · [Wallet backups](wallet-backup.md)

### Reserved inventory and operator spending

`GET /v1/sales/status` reports available inventory, reserved nanocoins, open orders, paid orders awaiting delivery, and the current intake mode. During bootstrap, a quote can reserve stock only against the same ledger tip used to calculate availability. A concurrent reserve-wallet debit, allowance reduction, suspension or signer change can commit only if the resulting balance and authorization still cover outstanding purchases. The owner can transfer the unreserved portion. A confirmed payment awaiting final acknowledgement counts once even if a Worker restarts after the on-chain debit.

When three published validators qualify for activation, Sites temporarily pauses new quotes while honoring open ones. The final transition requires a drained order queue. Once a committee with certified sale-escrow support runs the chain, a new quote enters `holding` until its exact collateral is recorded on-chain. Only a `reserved` order within its payment window is payable. An unpaid expired order releases collateral after two RPC endpoints agree on a complete finalized scan and validators confirm the release. A `paid` order and its payment proof persist if settlement is interrupted. Correctly paid orders retry automatically when the reserve or allowance is restored; the original order ID shows a shortage requiring merchant action. [Public inventory status](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/v1/sales/status)
