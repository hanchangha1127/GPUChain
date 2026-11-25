# GPUChain

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

GPUChain 公开主网 `gpuchain-mainnet-1` 目前以小规模试点方式运行。由签名交易完成的原链升级保留原创世哈希、钱包地址、余额和交易序号。运行 `node src/cli.mjs verify` 可核对 `networkStage` 是否为 `mainnet`。为兼容现有客户端，创世文件仍使用原文件名 `sites-testnet.json`。

**把这个仓库的 URL 发给代理，就能在后台启动公开主网的验证节点。** 也可以在装有 Node.js 24 或更高版本的机器上克隆仓库，运行 `npm start`。节点创建或复用自己的钱包和数据库，持续验证已签名的检查点，保存最新的已验证状态。关闭终端或结束代理会话后，节点仍然运行。参与验证无需 GPU、模型下载或公网 IP。[代理安装指南](../AGENTS.md) · [公开主网运行说明](../hosting/sites/README.md)

运行 `npm run status` 查看本机节点已验证的高度和投票状态。`npm stop` 停止节点，`npm start` 用原有数据恢复运行。只需检查一次连接和推理节点时，运行 `npm run join`。

**打开钱包界面**：运行 `npm run gui`，或在 Windows 上双击 **GPUChain Wallet.cmd**。程序会启动节点或使用已运行的节点，再打开浏览器。本机界面显示钱包的公开地址和已验证余额、节点的同步和投票状态，以及本机推理服务适配器的状态。界面使用单独的本机回环端口。运行 `node scripts/open-wallet.mjs --print-url` 可查看实际地址。 如需转账，请打开 `GPUChain Unlock.cmd` 或运行 `npm run wallet:unlock` 获取一次性代码，在本机输入并核对收款地址和金额后确认。

界面默认为英语，支持简体中文等五种语言。用 `GPUChain Backup.cmd` 创建加密备份，另行保管恢复密码。公开商店的售价为 1 USDT 购买 10 枚代币。付款前先登记 GPUChain 收款地址。[购买说明](usdt-sales.md) · [备份与恢复](wallet-backup.md)

## 从另一台电脑的 OpenCode 请求推理

在**使用推理的电脑**上安装 Node.js 24 或更高版本和 OpenCode 2.x，然后在 GPUChain 仓库中运行 `npm run opencode:setup`。重新打开 OpenCode，在 `/models` 中选择 `gpuchain/qwen3.8-flash-next`。默认连接地址为请求方本机的 `http://127.0.0.1:8792/v1`。请在本机保管 `opencode.token`，持有者可以用参与节点的钱包支付推理请求。

给请求方钱包充值后，即可使用其他已注册供应者的算力。文本、推理过程和工具调用会在生成时流式返回。网关要求通过加密中继请求远程推理，供应者的推理引擎会处理明文。后续请求优先选择处理过同一会话或最长匹配会话前缀的供应者。路由记录在最后一次成功结算后 60 分钟到期，实际 KV 缓存由推理引擎管理。缓存折扣按结算收据中实测的缓存读取量计算。公共账本地址用于发现供应者和连接加密中继。8080 是供应者电脑上的引擎端口。[中继连接验证示例](../README.md#use-paid-inference-from-another-computer)

## 账本验证与共识投票

默认节点持续验证账本。要参与交易确认，还需要获准的钱包和可从公网访问的 HTTPS 地址。运营者可以用 `add-validator` 授权节点的钱包公钥地址，已注册的推理提供者钱包也有资格。将 HTTPS 地址转发到本机监听端口（默认为 8790），设置 `GPUCHAIN_VALIDATOR_ORIGIN` 后重启节点。请一起保存钱包和原始数据库，默认数据目录为 `~/.gpuchain/participant`。

Sites 核验三个就绪节点的签名、地址和数据库标识后，签发委员会证书。此后确认交易需要三个成员中至少两人签名。其他节点继续验证检查点。[共识切换与运行条件](../hosting/sites/README.md)

## 计费和设置更新周期

目前仅支持 **Qwen3.8-Flash-Next** 及其兼容量化版本。模型上下文至少为 **262,144 个 token（256K）**，运行中的 K 缓存和 V 缓存必须**分别达到 Q8 或更高精度**。Q2_0 权重可以配合 Q8 KV 缓存。适配器在推理前和签发收据前检查 `/metrics` 报告的模型、上下文和 KV 格式。

| 用量 | 每百万 token 的代币数 | 计入周期进度 |
| --- | ---: | --- |
| 未命中缓存的输入 | 0.15 | 是 |
| 生成的输出 | 0.47 | 是 |
| 命中缓存的输入 | 0.016 | 否 |

单价取自 QwenCloud 国际 API 价格表中的数值。账本使用整数记账，1 枚代币等于 10 亿个最小单位。例如，某次推理共输入 64 个 token，其中 32 个命中缓存，另有 10 个输出 token，请求者需向提供者支付 **0.000010012 枚代币**。此次推理为全网累计 **42 个 token**。创世文件指定代币的初始分配和获准提供服务的钱包地址。[QwenCloud 价格表](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

全网累计每达到 **10 亿（1,000,000,000）个未命中缓存的输入与生成的输出 token**，就进入下一个周期。排序节点可以预先设置下一周期的单次请求输出上限。跨越阈值的请求按原有上限结算，超出的 token 计入下一周期。每笔获准操作都会增加交易高度，周期编号则按全网累计 token 数递增。

## 在 Windows 上运行独立的本地网络

需要独立开发网络时，运行 `node scripts/bootstrap.mjs` 即可启动。也可以按以下步骤分别启动各个角色。

使用 Node.js 24 或更高版本。提供者可以向 `provider` 命令或 `scripts/bootstrap.mjs` 传入 `--engine ryzenstrata`（默认）或 `--engine strata`。前者的默认模型 ID 是 `qwen3.8-flash-next-q2_0`。后者会选择唯一符合要求的已加载模型；有多个候选时请用 `--model-id` 指定。`--strata` 设置引擎地址，`STRATA_API_KEY` 用于后端认证。 [Strata](https://github.com/Niko1221/Strata) · [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

运行中的参与节点按 **8080、8000** 的顺序探测本地 Strata，将符合模型、256K 上下文和 KV 精度要求的引擎连接到 `127.0.0.1:8789`。先启动节点、后启动引擎也可以。探测不会加载模型或生成词元。用 `GPUCHAIN_STRATA_URL` 指定本地后端，或用 `GPUCHAIN_AUTO_PROVIDER=0` 关闭自动连接。更改后重启节点。

在账本中注册的提供方可通过仅使用出站 HTTPS（通常为 443）的加密中继提供推理，无需入站隧道、验证节点的公网地址或委员会投票权。排序节点仍在运行时，已完成并经请求方结算的推理也能获得代币。用 `routes --transport relay` 检查中继提供方。公共网络的 `chat` 默认使用加密中继。显式指定 `--transport auto` 时，优先使用符合条件的直连端点。直连需要注册转发到 8789 的公网 HTTPS 地址。中继的明文 JSON 请求和响应各限 8 MiB。`GPUCHAIN_INFERENCE_RELAY=0` 可关闭中继。

用 `--reasoning-effort none|low|medium|high` 选择推理强度，`max` 和 `xhigh` 映射为 `high`。`--reasoning-budget-tokens N` 为 0 到 `--max-output` 之间的整数。0 表示移除引擎单独设置的思考词元上限。如需关闭思考，使用 `none` 并省略预算或设为 0。两项均省略时使用引擎默认值。思考词元计入输出上限，仅作为输出用量计费一次。

**手动初始化时，在终端 1 创建钱包、分配初始余额并启动排序节点。** 在新的 `.local` 目录下运行一次钱包和创世文件创建命令。下面的配置向请求者分配 1 枚代币。钱包文件含有私钥。多机部署时，每个参与者应在自己的机器上保管钱包。已使用一键启动脚本的用户可直接运行终端 3 的客户端命令。

~~~powershell
New-Item -ItemType Directory -Force .local | Out-Null
node src/cli.mjs wallet --out .local/sequencer.json
$user = node src/cli.mjs wallet --out .local/user.json | ConvertFrom-Json
$provider = node src/cli.mjs wallet --out .local/provider.json | ConvertFrom-Json
node src/cli.mjs genesis --wallet .local/sequencer.json --out .local/genesis.json --allocation "$($user.address)=1" --provider $provider.address
node src/cli.mjs node --genesis .local/genesis.json --wallet .local/sequencer.json --dir .local/ledger
~~~

**在终端 2 启动推理提供者。** 默认情况下，适配器监听本机回环地址的 8789 端口，排序节点监听 8787 端口。

~~~powershell
node src/cli.mjs provider --genesis .local/genesis.json --wallet .local/provider.json
~~~

**在终端 3 请求推理、查询余额并转账。** 客户端返回模型回复、token 用量、费用和排序节点的确认信息。可使用 `--text-file FILE` 从 UTF-8 文件读取提示词。

~~~powershell
$provider = (Get-Content -Raw .local/provider.json | ConvertFrom-Json).address
node src/cli.mjs chat --genesis .local/genesis.json --wallet .local/user.json --provider-url http://127.0.0.1:8789 --provider-address $provider --text "什么是上下文窗口？" --max-input 1024 --max-output 128
node src/cli.mjs balance --genesis .local/genesis.json --address $provider
node src/cli.mjs transfer --genesis .local/genesis.json --wallet .local/user.json --to $provider --coins 0.01
node src/cli.mjs status --genesis .local/genesis.json
~~~

在另一个终端中启动可选的只读跟随节点。

~~~powershell
node src/cli.mjs follower --genesis .local/genesis.json --upstream http://127.0.0.1:8787 --dir .local/follower --port 8788
~~~

在空闲终端中，可验证该节点的签名检查点，并为下一周期预设 8,192 个 token 的输出上限。

~~~powershell
node src/cli.mjs verify --genesis .local/genesis.json --ledger http://127.0.0.1:8788
node src/cli.mjs settings --genesis .local/genesis.json --wallet .local/sequencer.json --max-output 8192
~~~

网络运行期间，新的提供者可以在自己的机器上创建钱包，并将公开地址发给排序节点运营者。运营者在自己的终端中输入该地址，使用排序节点的钱包签名并批准其加入。

~~~powershell
$newProviderAddress = Read-Host "新提供者的钱包公开地址"
$providerOrigin = Read-Host "提供者的 HTTPS 服务地址"
node src/cli.mjs add-provider --genesis .local/genesis.json --wallet .local/sequencer.json --address $newProviderAddress --url $providerOrigin
~~~

多机部署时，分发可信的创世文件，通过 HTTPS 提供远程账本和推理接口，并用 `--ledger URL` 指定账本。排序节点可用 `set-provider-endpoint --address ADDRESS --url URL` 更新已注册提供者的服务地址，将 `--url URL` 换成 `--withdraw` 即可撤下地址。本地启动脚本会自动登记回环地址。

运行 `node src/cli.mjs routes --genesis .local/genesis.json` 可以查看当前可用提供者的排名。在 `chat` 中省略提供者参数时，客户端在三秒内抽查最多 64 个候选节点，通过签名确认对方属于同一链且可以接受请求。每个候选节点最多测量三次 HTTP 往返时间（远程使用 HTTPS），只把提示词发给中位数最低的提供者。测量反映请求方当前的连接响应速度，地理距离和生成速度的排序可能不同。要固定选择某个提供者，可同时指定 `--provider-url URL --provider-address ADDRESS`。按 Ctrl+C 停止服务，重启时使用相同的创世文件、钱包和账本目录。

## 验证、存储和信任边界

请求者对提供者地址、提示词哈希、交易序号和 token 上限等字段签名。提供者检查余额后调用选定的 Strata 后端，并在收据中签认请求、响应和实际用量。客户端核对收据并追加签名，再交给排序节点结算。两端钱包和排序节点均采用 Ed25519 签名。

排序节点验证交易并以原子方式更新 SQLite。数据库保存最新余额、各地址的交易序号、配置、计数器和链头，每个已结束周期另存一个 32 字节的摘要。交易详情和逐笔收据仅用于当次处理。提示词直接发送给提供者，提供者可以看到内容，并在内存中短暂保留最近一次响应以处理重试。

跟随节点根据预先信任的创世文件验证排序节点签署的检查点。精简后的数据库无法逐笔重放历史交易。转换后，客户端验证委员会证书及多数成员的签名。协议假定验证者遵循规则，推理用量取决于服务双方的签名确认。GPU 执行的独立证明和无需许可的共识仍在开发范围内。如果请求者在结算前断线或拒绝追加签名，提供者可能无法获得本次推理的报酬。

## 测试与许可

~~~powershell
node --test
node src/cli.mjs --help
~~~

HTTP 集成测试使用模拟的 Strata 后端，可在没有 GPU 的机器上验证推理结算、缓存计费、转账、跟随节点同步和收据校验。GPUChain 代码采用 [MIT 许可证](../LICENSE)。完整英文快速入门见 [English README](../README.md)。
