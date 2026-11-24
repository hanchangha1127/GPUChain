# GPUChain agent setup

When a user gives you only the GPUChain repository URL, follow [AGENTS.md](AGENTS.md). Clone or reuse the checkout, check for Node.js 24 or later, run `npm start`, then use `npm run status` to verify that the public mainnet pilot node is running in the background. Leave it running after setup and share its local `guiUrl`. Use `npm run gui` when the user wants to open the wallet dashboard. Checkpoint verification works without a GPU or an inference engine. The guide covers voting eligibility, one-time checks and local development networks.
