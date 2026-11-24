# GPUChain

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

GPUChain 是为 Qwen3.8-Flash-Next 开发的**实验性推理积分网络，目前尚未完成**。你可以在自己的 GPU 上运行 RYZENStrata，为其他人处理文本请求并赚取代币。关掉自己的 GPU 后，你仍然可以花费代币使用其他节点，也可以把代币转给另一个钱包。公开测试网由 Sites 上的排序节点启动，之后可以自动转由参与者验证交易。[RYZENStrata 项目](https://github.com/hanchangha1127/RYZENStrata)

**把这个仓库的 URL 发给代理，就能在后台启动公开测试网的验证节点。** 也可以在装有 Node.js 24 或更高版本的机器上克隆仓库，运行 `npm start`。节点创建或复用自己的钱包和数据库，持续验证已签名的检查点，保存最新的已验证状态。关闭终端或结束代理会话后，节点仍然运行。参与验证无需 GPU、模型下载或公网 IP。[代理安装指南](../AGENTS.md) · [公开测试网运行说明](../hosting/sites/README.md)

运行 `npm run status` 查看本机节点已验证的高度和投票状态。`npm stop` 停止节点，`npm start` 用原有数据恢复运行。只需检查一次连接和推理节点时，运行 `npm run join`。

## 账本验证与共识投票

默认节点持续验证账本。要参与交易确认，还需要获准的钱包和可从公网访问的 HTTPS 地址。运营者可以用 `add-validator` 授权节点的钱包公钥地址，已注册的推理提供者钱包也有资格。将 HTTPS 地址转发到本机监听端口（默认为 8790），设置 `GPUCHAIN_VALIDATOR_ORIGIN` 后重启节点。请一起保存钱包和原始数据库，默认数据目录为 `~/.gpuchain/participant`。

Sites 核验三个就绪节点的签名、地址和数据库标识后，签发委员会证书。此后确认交易需要三个成员中至少两人签名。其他节点继续验证检查点。[共识切换与运行条件](../hosting/sites/README.md)

## 计费和设置更新周期

每个提供者都需要提供 **256K（262,144 个 token）的上下文窗口**。适配器检查 RYZENStrata 报告的已加载模型和上下文容量。每个请求签名授权的输入与输出上限之和不能超过 256K，结算按实际用量计算。

| 用量 | 每百万 token 的代币数 | 计入周期进度 |
| --- | ---: | --- |
| 未命中缓存的输入 | 0.15 | 是 |
| 生成的输出 | 0.47 | 是 |
| 命中缓存的输入 | 0.016 | 否 |

单价取自 QwenCloud 国际 API 价格表中的数值。账本使用整数记账，1 枚代币等于 10 亿个最小单位。例如，某次推理共输入 64 个 token，其中 32 个命中缓存，另有 10 个输出 token，请求者需向提供者支付 **0.000010012 枚代币**。此次推理为全网累计 **42 个 token**。创世文件指定代币的初始分配和获准提供服务的钱包地址。[QwenCloud 价格表](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

全网累计每达到 **10 亿（1,000,000,000）个未命中缓存的输入与生成的输出 token**，就进入下一个周期。排序节点可以预先设置下一周期的单次请求输出上限。跨越阈值的请求按原有上限结算，超出的 token 计入下一周期。每笔获准操作都会增加交易高度，周期编号则按全网累计 token 数递增。

## 在 Windows 上运行独立的本地网络

需要独立开发网络时，运行 `node scripts/bootstrap.mjs` 即可启动。也可以按以下步骤分别启动各个角色。

需要 Node.js 24 或更高版本。在仓库根目录的 PowerShell 中执行以下命令。钱包、客户端、账本和推理适配器均使用 Node.js 内置模块。提供者需要先在 RYZENStrata 中加载 Qwen 模型，并确保 `/v1/models` 可以访问。默认后端地址为 `http://127.0.0.1:8000/v1`，默认模型 ID 为 `qwen3.8-flash-next-q2_0`。可以通过 `--strata` 和 `--model-id` 指定其他部署。后端启用身份验证时，请在提供者进程的环境中设置 `STRATA_API_KEY`。

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

请求者对提供者地址、提示词哈希、交易序号和 token 上限等字段签名。提供者检查余额后调用 RYZENStrata，并在收据中签认请求、响应和实际用量。客户端核对收据并追加签名，再交给排序节点结算。两端钱包和排序节点均采用 Ed25519 签名。

排序节点验证交易并以原子方式更新 SQLite。数据库保存最新余额、各地址的交易序号、配置、计数器和链头，每个已结束周期另存一个 32 字节的摘要。交易详情和逐笔收据仅用于当次处理。提示词直接发送给提供者，提供者可以看到内容，并在内存中短暂保留最近一次响应以处理重试。

跟随节点根据预先信任的创世文件验证排序节点签署的检查点。精简后的数据库无法逐笔重放历史交易。转换后，客户端验证委员会证书及多数成员的签名。协议假定验证者遵循规则，推理用量取决于服务双方的签名确认。GPU 执行的独立证明和无需许可的共识仍在开发范围内。如果请求者在结算前断线或拒绝追加签名，提供者可能无法获得本次推理的报酬。

## 测试与许可

~~~powershell
node --test
node src/cli.mjs --help
~~~

HTTP 集成测试使用模拟的 Strata 后端，可在没有 GPU 的机器上验证推理结算、缓存计费、转账、跟随节点同步和收据校验。GPUChain 代码采用 [MIT 许可证](../LICENSE)。完整英文快速入门见 [English README](../README.md)。
