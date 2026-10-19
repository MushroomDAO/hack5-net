# OP Mainnet 签到押金 — 产品 + 技术方案

> 状态:设计稿,2026-10-19 经 Claude Opus 评审后修订。链是 **OP Mainnet(chainId 10)**。解锁交易由 **hack5 Worker 代发并付 gas**。参赛者先把钱包绑到已验证邮箱,再存款。
>
> 评审方式:`claude -p --model opus --permission-mode plan`,只读。Codex MCP 当时连不上,所以这是一次 Opus 审读,不是第二家模型的交叉评审。评审要求在写代码前改完四处,因为它们会冻住阶段 1 的表结构和签名格式:SIWE、nonce 原子消费、删掉「表不存在视为无锁」、绑定历史加冷却期。这四处已写进本文。阶段 2–4 的合约与代发要求也写在本文,但这一轮只实现阶段 1。
>
> 本文是实现的依据。分阶段见 §9。阶段 1 只做绑定,不部署合约。

## 1. 要做什么

一场黑客松可以要求报名押金。钱锁在托管合约里,直到现场签到后原路退回。

- 默认资产:ETH、Circle 原生 USDC、USDT。具体地址和额度由 Safe 配置,不写死在字节码里。
- 合约由 EOA 部署并完成配置,再用 OpenZeppelin `Ownable2Step` 交给一条链 ID 10 上的 Safe。Safe 接受之前,所有权仍在 EOA。
- 签到码沿用 `email_codes` 的 6 位、只存哈希、次数限制、过期、一次性。码发给已验证邮箱,核销在 hack5,不上链。
- 核销成功后 Worker 用一把只能调用 `release(user)` 的钥匙代发交易。钱只回到存款地址。

没有现成的审计合约能做「邮件验证码解锁 ERC-20 / ETH」。OpenZeppelin Contracts 5.0 已删除 `Escrow` / `ConditionalEscrow` / `RefundEscrow`,且那些合约只处理 ETH。资金移动、权限交接、重入防护用 OpenZeppelin;记账是一层薄合约。6 位验证码不能当链上密钥:交易进内存池后码是公开的,可以被抢跑。

## 2. 已定参数

| 项 | 值 |
|---|---|
| 链 | OP Mainnet,chainId `10` |
| 浏览器添加网络 | RPC 生产用单独节点,不把 `https://mainnet.optimism.io` 当生产写入口(公共端点有频率限制) |
| 浏览器只读 | 可用公共 RPC |
| ETH | `address(0)`,18 位小数 |
| USDC | Circle 原生 `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`,6 位小数 |
| 不用 | 桥接 USDC.e `0x7F5c764cBc14f9669B88837ca1490cCa17c31607` |
| USDT | 每场只启用一个 USDT。部署当天由 Safe 选定,6 位小数。旧桥接合约 `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` 正在迁到 USDT0 `0x01bFF41798a0BcF287b996046Ca68b395DbC1071`。配置前以 Tether 当时公布的合约为准。两个地址不要同时启用 |
| 谁付 gas | 存款和 `approve` 由参赛者自己的钱包付。`release` 由 Worker 付 |
| 账号 | 邮箱。钱包是这笔押金的收款地址,不是登录身份 |
| 一场一个合约 | 每场黑客松自己的托管合约。`tenants.escrow_address` 在阶段 3 写入。不让多场共用一份锁仓,否则后一场无法存款,签到 A 会解开 B |

## 3. 合约

阶段 2 实现。这里先写死不变量,避免阶段 1 的数据模型和后面的合约对不上。

继承 OpenZeppelin `Ownable2Step`、`Pausable`、`ReentrancyGuard`。ERC-20 只用 `SafeERC20`。用它是因为各代币 `transfer` 的返回值不一致;「USDT 的 transfer 不返回 bool」只适用于以太坊主网的旧 USDT,不能拿来描述 OP 上的 USDT / USDT0。ETH 退回用 `Address.sendValue`。

`Ownable2Step` 自带 `renounceOwnership()`。本合约覆盖它,直接 revert。owner 永远不能是 0 地址。Forge 测试要覆盖这一点。

状态:

- `mapping(address token => Asset)`:`amount`、`enabled`。`address(0)` 是 ETH。
- `mapping(address user => mapping(address token => uint256)) locked`。额度在存款时记下来,之后改价不影响已锁的钱。
- `address checkinSigner`。只有它能 `release`。不能是 0 地址。停机用 `pause`,不把钥匙设成 0。
- `uint64 cancelUntil`。这个时间之前存款人可以自己 `cancel()`。
- `uint64 withdrawAfter`。这个时间之后,存款人可以自己 `withdraw()`,即使合约处于 pause。缺省上限是 `cancelUntil + 90 days`:Safe 失联也不能把钱永久锁死。`withdraw()` 只打回本人。

函数:

| 函数 | 谁能调用 | 行为 |
|---|---|---|
| `deposit(token)` payable | 任何人 | 按当前额度锁定。`msg.sender` 是收款人。ERC-20 用 `safeTransferFrom`,且 `msg.value` 必须是 0。ETH 的 `msg.value` 必须等于额度。转入后核对余额增量。同一用户同一代币已有锁则拒绝。只接受 canonical 代币,不接受 fee-on-transfer |
| `cancel()` | 存款人 | `block.timestamp < cancelUntil` 时,把本人全部锁退回本人 |
| `release(user)` | `checkinSigner` | 将该用户全部锁打回 `user`。没有「打给别人」的参数。重复调用在余额为 0 时直接返回。每个代币单独 try/catch:USDC / USDT0 可升级且有黑名单,一个代币失败不能把同一次调用里的 ETH 一起回滚。失败的代币留在账上,稍后再 `release` 或 `refund` |
| `refund(user)` | owner(Safe) | 同样只打回 `user`。给还没到自助取回日的人提前退款 |
| `withdraw()` | 存款人 | `block.timestamp >= withdrawAfter`,或已过 `cancelUntil + 90 days`。pause 挡不住。只打回本人。这是缺席者的策略:全额退回本人,不罚没,也不打给 owner |
| `setAsset(token, amount, enabled)` | owner | 白名单和额度。只影响之后的存款 |
| `setCheckinSigner(address)` | owner | 换 Worker 钥匙。拒绝 0 地址 |
| `setCancelUntil(uint64)` / `setWithdrawAfter(uint64)` | owner | 开赛截止与自助取回时间。`withdrawAfter` 必须晚于 `cancelUntil` |
| `pause` / `unpause` | owner | 暂停存款和 `release`。`refund` 与 `withdraw` 在暂停时仍可用 |

不变量:

- 不存在把用户资金提到 owner 的函数。缺席者的钱回到存款人,或一直留到自助取回,不会变成主办方收入。
- `release` / `refund` / `cancel` / `withdraw` 的收款人永远是记账地址。
- 先改账本,再转账。ETH 路径加 `nonReentrant`。
- 只接受 Safe 白名单里的合约。
- 合约不读邮箱,不读验证码。合约也无法知道这个地址现在绑在哪个邮箱。邮箱归属以 hack5 的绑定历史为准(§4)。

部署顺序(阶段 5,人工,不进 CI):

1. 在链 ID 10 上建好 Safe。`eth_getCode` 必须非空。不接受仅仅是 CREATE2 预测出来的地址。
2. EOA 部署合约。构造函数里 `_pause()`。部署完立刻是暂停的,避免 Safe 还没 `acceptOwnership` 就有人存款。
3. `setAsset` 写入 ETH、USDC,以及当天确认过的那一个 USDT。写入 `checkinSigner`、`cancelUntil`、`withdrawAfter`。`checkinSigner` 不是部署用的 EOA,也不是 Safe 的签名者。
4. `transferOwnership(safe)`。`pendingOwner` 在接受前可以被覆盖,所以接受之前不要 unpause。
5. Safe 执行 `acceptOwnership()`,然后 `unpause()`。
6. 部署脚本断言 `owner() == safe`、`pendingOwner() == address(0)`、`paused() == false`、`checkinSigner` 不是部署 EOA。
7. EOA 不再有权限。

`checkinSigner` 只留少量 ETH 当 gas。丢了这把钥匙,存款人仍可在 `withdrawAfter` 之后自己取回。

阶段 5 运维页要当场核对 Tether / Circle 的官方页面:合约地址、symbol、decimals、代理管理员、近期转账量。界面上展示实际配置的合约地址。本文里的地址是撰写时的公开地址,上线前再核一次,不在阶段 1 写进字节码。

## 4. 绑定钱包(阶段 1)

绑定在平台层,不按活动拆开。一个邮箱当前一个地址,一个地址当前一个邮箱。换绑留下历史,供阶段 3 按区块时间归因。

未验证的报名 cookie 不能绑。那种 cookie 只说明浏览器填过邮箱。调用者必须是 `verified: true` 的参赛者会话,或已登录的平台用户(`hv_user`),且邮箱就是本人。同一请求上如果带着未验证的参赛者 cookie,直接拒绝,不退回到平台用户。

### 4.1 入口

- `/mine`:已验证邮箱后,面板下方一张「收款钱包」卡片。平时绑定、查看、换绑都在这里。
- `/settings`:平台用户(apex 上的 `hv_user`)在这里绑定。绑定是平台层的,组织者用同一套接口。
- 报名完成页:本场打开押金时(阶段 3,`tenants.escrow_address` 有值),下一步指向这张卡片。没绑定不出现存款按钮。
- 签到页(阶段 4):只展示已绑定地址,不提供换绑。

卡片写明:这一步只签名,不发交易,不切换网络。普通账户可以签。纯合约钱包(ERC-1271)这一阶段不支持。EIP-7702 委托过的普通账户仍能 `ecrecover`,可以绑。

### 4.2 签名:SIWE(EIP-4361)

不上链,不花钱。不用自制的四行 `personal_sign`。自制正文没有域名,钓鱼页可以展示同一段字,受害者签名后,地址就被绑到攻击者的邮箱上。

服务端用 viem `createSiweMessage` 生成 EIP-4361 消息,浏览器对这整段原文做 `personal_sign`。绑定阶段不调用 `wallet_switchEthereumChain`。chainId 10 写在消息里。钱包里没有配置 OP 也不影响绑定。切链只发生在阶段 3 的存款。

消息字段:

| 字段 | 值 |
|---|---|
| domain | 本次请求的 host。必须是 `ROOT_DOMAIN`(默认 `hack5.net`)、它的单个子域名,或本地的 `localhost` / `127.0.0.1`。拒绝 `workers.dev` 和其他域 |
| address | 用户声明、并经 `getAddress` 规范化的地址 |
| statement | `Bind this wallet to <小写邮箱> on hack5. This signature does not send a transaction.` |
| uri | 租户站 `origin/mine`,平台站 `origin/settings` |
| version | `1` |
| chainId | `10` |
| nonce | 32 字节,`crypto.getRandomValues`,十六进制 |
| issuedAt / expirationTime | 现在 / 5 分钟后 |

服务端:

1. `POST /api/wallet/nonce`,body `{ address }`。已验证会话。非法地址 400。生成消息并整段存进 `wallet_nonces`(主键是邮箱,新的一次请求作废旧 nonce)。同一邮箱 10 秒内重复请求返回 429。两个标签会互相覆盖 nonce,后签的那个会失败,错误要写清楚。
2. 浏览器 `personal_sign` 服务端返回的原文。不切链。
3. `POST /api/wallet/bind`,body `{ signature }`。服务端不接受客户端传来的消息正文。先按下面的原子步骤消费 nonce,再用 viem 验证存下来的那一段:`parseSiweMessage` + `validateSiweMessage` + `verifyMessage`(EOA 的 `ecrecover`)。当前 viem 的 `verifySiweMessage` 动作必须带 RPC 客户端,并且会按 ERC-6492 接受合约钱包;阶段 1 不连 RPC,也不接受合约钱包。校验 domain、nonce、chainId 10、statement 里的邮箱、恢复出的地址。验签失败也已经消费了 nonce,返回 401。
4. 地址已属于另一个邮箱:409。靠 `wallet_bindings.address` 的唯一索引,不是只靠先 SELECT 再 INSERT。并发时落败的一方也是 409。
5. 换绑覆盖本邮箱的旧地址,并写历史。阶段 1 不读取押金表,也不因为「表不存在」就当作没有锁。阶段 1 还没有存款。

nonce 消费,和登录码的 `used_at` 同一风格,必须先原子删掉再验签:

```sql
DELETE FROM wallet_nonces
 WHERE email = ? AND nonce = ? AND expires_at >= ?
```

`changes === 1` 才继续验签。两个并发请求只有一个删得到。

### 4.3 归属:历史 + 24 小时冷却

合约只认识地址。如果只按「当前绑定」给存款记账,会出现这个窗口:A 绑了 X 并存款,对账还没写入,A 换成 Y,B 绑走 X,对账把这笔钱记到 B 名下。B 签到后 `release(X)` 把钱退回 A,A 人没到现场也拿回了押金。

阶段 1 就建历史表,避免阶段 3 再改主键。规则:

- 当前绑定在 `wallet_bindings`。地址存小写。读出时用 `getAddress` 变成 EIP-55 给界面。唯一索引比对的是小写字符串。
- 每次成功绑定追加 `wallet_binding_history`。换绑时把旧行的 `unbound_at` 填上,`unbind_reason = 'rebind'`。
- 用户换绑后,旧地址 24 小时内不能被另一个邮箱绑走。同一邮箱可以立刻绑回去。冷却挡的是「对账完成前被别人领走」。
- 阶段 3 归因禁止读 `wallet_bindings` 的当前行。按存款交易所在区块的时间,找 `bound_at <= 区块时间 AND (unbound_at IS NULL OR unbound_at > 区块时间)` 的那一行。没有匹配就是孤儿存款:记下来,不能签到解锁,只能 Safe `refund` 或到期 `withdraw`。有多行匹配就拒绝归因并告警。
- 阶段 3 才禁止「本邮箱有 `escrow_deposits.status = 'locked'` 时换绑」。判断写在同一条写入 SQL 里(`NOT EXISTS`),不做成「表不存在则放过」。

申诉:平台运营方(`PLATFORM_ADMIN_EMAILS`,不是某一场的管理员)`POST /api/platform/admin/wallet/unbind`,body `{ email }`。解绑写入历史,`unbind_reason = 'admin'`,不启动 24 小时冷却,这样真正的主人可以马上绑上。一场的管理员不能解绑。

### 4.4 数据

`migrations/0030_wallet_bindings.sql`:

```sql
CREATE TABLE wallet_bindings (
  email TEXT PRIMARY KEY,
  address TEXT NOT NULL,             -- 小写
  chain_id INTEGER NOT NULL DEFAULT 10,
  bound_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_wallet_bindings_address ON wallet_bindings(address);

CREATE TABLE wallet_binding_history (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  bound_at INTEGER NOT NULL,
  unbound_at INTEGER,                -- 空表示仍是当前绑定
  unbind_reason TEXT                 -- 关闭时为 rebind 或 admin
);
CREATE INDEX idx_wallet_hist_address ON wallet_binding_history(address, bound_at);

CREATE TABLE wallet_nonces (
  email TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  domain TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

`GET /api/tenant/me` 在 `verified === true` 时多返回 `wallet: { address, chainId } | null`。地址是 checksum。未验证会话不带 `wallet` 字段。`GET /api/wallet` 给 `/mine` 和 `/settings` 的卡片用,规则相同。

## 5. 存款(阶段 3)

Worker 不代发、不代付这笔 gas。一场一个合约,地址在 `tenants.escrow_address`。

1. 读该场合约当前 `asset(token)`。界面展示代币合约地址。
2. 交易 `from` 必须是已绑定地址。这只约束前端和我们自己的对账;合约仍然只认识 `msg.sender`。
3. 这时才 `wallet_switchEthereumChain` 到链 ID 10。
4. ETH:`deposit(address(0))` 并带上与额度相等的 value。
5. USDC / USDT:先 `approve` 托管合约,再 `deposit`。OP 上的 USDT 没有 permit。两条 ERC-20 都走 approve,不为 USDC 单独开捷径。
6. Worker 用 `eth_getLogs` 对上 `Deposited`。按 §4.3 的历史区间决定 email,写入 `escrow_deposits(tenant_id, email, address, token, amount, tx_hash, status)`。`status` 从 `locked` 到 `released` 或 `refunded`。对账以事件为准,不信任浏览器回报。
7. 本邮箱存在 `locked` 行时,换绑的那条 SQL 直接拒绝。

开赛前用户自己 `cancel()`。开赛后到自助取回日之前,只有签到解锁,或 Safe `refund`。

## 6. 签到与代发(阶段 4)

签到码不能复用现在的 `email_codes` 而不加列。登录成功会把该邮箱所有未使用的码作废,尝试次数和 15 分钟发送上限也是按邮箱共享的,表上没有 `tenant_id`。阶段 4 的迁移给 `email_codes` 增加 `purpose TEXT NOT NULL DEFAULT 'login'` 和 `tenant_id`。现有登录的查询、作废和限流都加上 `AND purpose = 'login'`。签到用 `purpose = 'checkin'`,哈希输入是 `checkin:<tenantId>:<email>:<code>`。

流程:

1. 主办者在后台核对是这个人。只有该场的主办者会话能发签到码。参赛者自己不能申请。
2. 参赛者在手机页提交验证码。页面展示将要解锁的地址,不提供换绑。核销规则与登录相同:哈希、10 次、过期、`used_at` 一次性。
3. 核销成功后插入 `checkin_jobs`。一行对应一笔 `escrow_deposits`。Worker 用 `waitUntil` 尝试发送,不等回执。
4. 状态:`queued → sending → confirmed | failed`。`waitUntil` 可能在签名之后、写入 `tx_hash` 之前死掉。不能靠「失败了再签一笔新 nonce」来重试:新 nonce 可能解开另一笔存款,也会卡住这把钥匙后面的交易。
5. 同一把钥匙的链上 nonce 用一行 `signer_state`:`UPDATE signer_state SET next_nonce = next_nonce + 1 ... RETURNING`,或一个 Durable Object。不要只用 `UPDATE checkin_jobs SET status = 'sending' WHERE status = 'queued'`,那只能防止同一行被做两次,不能防止两笔任务拿到同一个链上 nonce。
6. 广播之前先把 raw tx、tx hash、nonce 写入 job。重试是把同一笔 raw tx 再广播一次。要加速就做同 nonce 的 gas bump。定时任务(现有 `*/15` cron)收回超时停在 `sending` 的任务:查回执,有了就确认;链上 `locked[user] == 0` 就标完成。
7. 密钥 `CHECKIN_PRIVATE_KEY`、`OP_RPC_URL` 放 wrangler secret。同一条 cron 看这把钥匙的 ETH 余额,过低给主办邮箱发信。

## 7. 明确不做

- 不把验证码或邮箱写进合约。
- 不把 `checkinSigner` 做成 Safe 的签名者。
- 不在阶段 1 部署主网,不在 CI 里发主网交易。
- 不恢复 OpenZeppelin v4 的 Escrow。
- 不用 VestingWallet(它只认时间)。
- Worker 不替用户存款。
- 阶段 1 不实现换绑锁,不创建 `escrow_deposits`,也不把「表不存在」解释成没有锁。

## 8. 评审里接受、并写进上文的点

- 验证码留在链下。资金只回到记账地址。owner 不能抽走。
- 账本先于转账。`SafeERC20` + `sendValue`。不复活 v4 Escrow。
- `verified === true` 才算邮箱已证明,和 `participantMe` 的失败关闭一致。
- 用户付存款 gas,Worker 付 `release` 的 gas。
- 阶段 1 不引入 Foundry。签名校验用 viem,不自己实现 secp256k1。

## 9. 阶段

每个阶段一个 PR。这一轮只做阶段 1,落在分支 `feat/op-checkin-escrow`。阶段 2 起等阶段 1 合并后再开自己的分支,不把合约工具链和站点绑在同一个未合并分支上。

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| 1 | 本文 §4。migration 0030、nonce / bind / wallet 读接口、运营方解绑、`/mine` 与 `/settings` 卡片、vitest | `npm run typecheck` 与 `npm test` 通过。未验证会话绑不上。错签名 401 且 nonce 已消费。地址冲突 409,含并发。nonce 不能用两次。SIWE 的 domain 是当前 host,chainId 是 10。换绑写历史,24 小时内其他邮箱绑不走该地址,本邮箱可以绑回。运营方解绑不启动冷却 |
| 2 | Foundry 工程,只含托管合约和单元测试。依赖 `@openzeppelin/contracts` | `forge test` 通过。覆盖 deposit、cancel 窗口、release 只打回本人、owner 不能抽走、`renounceOwnership` revert、构造即 pause、`withdraw` 在 pause 下仍可取回、SafeERC20、ERC-20 拒绝 value、ETH value 必须等于额度、单代币失败不回滚其他代币 |
| 3 | 一场一个合约、`tenants.escrow_address`、存款按钮、切链、approve、按历史归因、有 locked 行时拒绝换绑 | 本地 Anvil 或 OP Sepolia 上走通一笔。主网仍不部署 |
| 4 | `email_codes.purpose` + `tenant_id`、签到码、job 表、签名者 nonce、先存 raw tx 再广播、cron 回收、低余额告警 | 用测试钥匙对 OP Sepolia 发一笔 `release`。主网钥匙不进仓库 |
| 5 | 人工:OP Mainnet 部署、Safe 接受所有权、核对代币、充 gas | 另写一页运维步骤,不进应用 PR |
