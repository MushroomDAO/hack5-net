# 积分 / Token 计费设计(mini「做成应用」)

> 目标:mini 参赛者用 `/make` 建应用会消耗 AI token。免费额度用完后,按 **token → 积分** 实时扣费继续。积分余额由**外部积分系统**持有(按 email 查询/扣减),hack5 不发放积分、只做**计量 + 实时扣费 + 门禁**。核心红线:**实时扣、防透支**。

## 1. 概念

| 概念 | 说明 |
|---|---|
| **token** | AI 工作量单位。`/make` 的 chat 每轮 + 建应用的 loop(拆规格/编码/评审)都消耗,由 **WorkBench 上报**。 |
| **积分(credit)** | 用户的钱。余额在**外部系统**,hack5 通过 email 查询/扣减。积分从哪来(充值/赞助)hack5 不管。 |
| **价格** | `CREDITS_PER_1K_TOKENS`(每 1000 token 折多少积分),可配置。`cost = ceil(tokens/1000 × rate)`。 |
| **身份** | 参赛者 **email**(#47 验证会话 / mini 提交 email)。**email ↔ 积分账户**一一绑定。 |
| **免费额度** | 现状保留:每 email 免费建 **1** 个应用(`FREE_LAUNCHES`),之后走积分。 |

## 2. 外部积分 API 契约(hack5 调用 → 你实现)

hack5 用 `CREDITS_API_SECRET` 做 HMAC 签名调用 `CREDITS_API_URL`。**你按这个契约实现你的 API 即可**(积分怎么来你自己管)。

| 端点 | 入参 | 出参 | 用途 |
|---|---|---|---|
| `POST /balance` | `{ email }` | `{ email, credits }` | **实时余额**(供「按 email 查积分」+ 门禁预检) |
| `POST /reserve` | `{ email, credits, ref }` | `{ ok, credits, holdId }` | **预扣/占用**(防透支:余额 < credits 时 `ok:false`) |
| `POST /settle` | `{ ref, actualCredits }` | `{ ok, credits }` | 结算实际用量,释放多占的 |
| `POST /release` | `{ ref }` | `{ ok }` | 任务失败,释放占用 |

- 全部 **按 `ref` 幂等**(ref 由 hack5 每次 build/turn 生成,重试不重复扣)。
- 若你只想给「余额查询 + 扣减」两个端点也行,hack5 可退化为**预扣估算 + 事后退差**;但 `reserve/settle` 是最干净的**防透支**路径,推荐。

## 3. 实时扣费 · 防透支流程(你强调的红线)

token 实际用量**跑完才知道**,所以要么预授权占用、要么每步小额实时扣:

- **chat 每轮**(小、可控):每轮**发起前**校验 `余额 ≥ 单轮估算`,不足 → `402`;跑完 `settle` 实际。单轮便宜,预占小额即防透支。
- **build / launch**(大、跑完才知):
  1. **发起前**估算本次上限 `maxCost` → `reserve(maxCost)`。**余额不足直接 402**(带充值入口),**不建仓、不跑 loop** → 从源头防透支。
  2. 建仓 + 跑 loop。
  3. WorkBench 回调/usage 报回**实际 token** → `settle(actual)`,释放多占。
  4. loop 失败 → `release`,不扣。
- **免费额度**:每 email 首次 build 免费,不走 reserve。

> 关键:**先 reserve 再干活**,任何真实消耗(建仓/跑 loop/调模型)之前余额已被占住,账户永远扣不到负。

## 4. hack5 侧结构(本 PR 初始化)

- **D1 `credit_ledger`**:本地流水(审计 + 幂等)。hack5 **不持有余额**(外部为准),但记录每笔 reserve/settle/release,用于对账 + 幂等 + 用量展示。
- **配置**:`CREDITS_API_URL` / `CREDITS_API_SECRET` / `CREDITS_PER_1K_TOKENS` / `CREDITS_ENABLED`(总开关,**关=现状不变**,免费额度逻辑照旧)。
- **`src/credits.ts`**:balance / reserve / settle / release 客户端(HMAC)+ 成本换算。
- **查询端点** `GET /api/tenant/mini/credits`:登录参赛者按自己 email 查余额(你要的「email 可查积分」)。未配置 → `{enabled:false}`。

## 5. token 来源(跨 WorkBench)

hack5 需要**每 job / 每轮的实际 token 数**才能精确 settle。来源:
- chat:fde-copilot 的 usage;loop:loop-engineer 的 coding_done/deployed 回调里带 token 统计。
- **需要一个跨仓协同项**:WorkBench 在回调 / usage 里上报**每 job 的 token 用量**。此项另发协同任务。

## 6. 分期

1. **本 PR(结构初始化)**:migration `credit_ledger` + config + `credits.ts` + 余额查询端点 + 本文档。**全程 feature-flag `CREDITS_ENABLED` 关闭,零行为改动**。
2. **接你的 API + 定价**:打开开关,launch 接 reserve/settle,超免费额度走积分。
3. **WorkBench 报 token**:精确 settle(协同任务)。

## 7. 待你拍板的参数

- `CREDITS_PER_1K_TOKENS`:1000 token = ? 积分(定价)。
- 外部 API:确认第 2 节契约(4 端点,或退化 2 端点),给我 `CREDITS_API_URL` + 带外 `CREDITS_API_SECRET`。
- build 的 `maxCost` 估算口径(固定上限,还是按 spec 规模估)。
