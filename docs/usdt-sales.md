# USDT payments are temporarily paused

New GPUChain USDT purchases on Ethereum and BNB Smart Chain are paused. Please do not send USDT. The site offers 1,000 starter coins once per eligible mainnet address. [Starter coins and order lookup](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/)

## Recover an existing order

If you already paid, open the site and enter the original order ID. You can supply the public transaction hash so the Worker can verify the finalized transfer against the original signed order. A matching payment is delivered to the GPUChain wallet registered on that order. Keep the order ID and transaction hash if an expired, late or mismatched payment needs review.

## Operation

The reserve owner signs a cumulative sale allowance. A separate hosted key can attest paid deliveries under the fixed network, token, merchant and price rules. The reserve owner's key stays on the owner machine. Each sale reduces the existing GPUChain reserve and credits the recipient equally. The single one-trillion-coin issuance cannot be repeated. `suspend-sales` lets the owner stop the allowance; plan suspension around outstanding payments.

D1 retains order reservations, a unique payment reference and durable delivery state so retries and worker restarts can recover without paying twice. This purchase bookkeeping is separate from the compact public ledger. The repository's scheduled job wakes the Sites Worker approximately every five minutes. The Worker performs payment verification and settlement; the scheduled runner holds only the credential for waking it. A separate obligation of the operator is to maintain the oracle, keep reserve assets available for accepted orders and check the rules applicable to real-money sales in the jurisdiction of operation.

[USDT contract documentation](https://tether.to/en/supported-protocols/) · [BNB Chain token definitions](https://github.com/bnb-chain/mpp-sdk) · [Wallet backups](wallet-backup.md)

### Reserved inventory and operator spending

`GET /v1/sales/status` reports the intake pause on both networks. During bootstrap, a quote can reserve stock only against the same ledger tip used to calculate availability. A concurrent reserve-wallet debit, allowance reduction, suspension or signer change can commit only if the resulting balance and authorization still cover outstanding purchases. The owner can transfer the unreserved portion. A confirmed payment awaiting final acknowledgement counts once even if a Worker restarts after the on-chain debit.

When three published validators qualify for activation, Sites temporarily pauses new quotes while honoring open ones. The final transition requires a drained order queue. Once a committee with certified sale-escrow support runs the chain, a new quote enters `holding` until its exact collateral is recorded on-chain. Only a `reserved` order within its payment window is payable. An unpaid expired order releases collateral after two RPC endpoints agree on a complete finalized scan and validators confirm the release. A `paid` order and its payment proof persist if settlement is interrupted. Correctly paid orders retry automatically when the reserve or allowance is restored; the original order ID shows a shortage requiring merchant action. [Public inventory status](https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site/v1/sales/status)
