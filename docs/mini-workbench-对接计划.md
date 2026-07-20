# Mini × WorkBench 对接 —— hack5 侧执行计划

> **给谁看**:在 hack5-net 仓库跑 `/loop` 的工程执行者。按 §7 顺序把 A1–A7 实现掉,
> 每项**独立分支 + 自测(`npm run typecheck` + 抽 client JS `node --check` + 本地 wrangler dev)+ 开 PR,禁止自动合并**,等人 review。
>
> **协作背景**:hack5 Mini 黑客松(面向非开发者)要让参赛者「输入一句想法 → WorkBench 自动生成规格 + 编码 →
> 入库到参赛者命名的**公有**仓库(隔离 bot 账户下)→ 部署上线」。WorkBench 侧补 W1–W7,hack5 侧建 A1–A7。
> 协同任务:Seeder · **Cooperation-Center · CC-51**(`from:hack5-net` / `repo:workbench`)。契约已定稿 **v2**(见 §5)。

---

## 1. 端到端目标流程

```
参赛者(mini页) ─①输入想法─► hack5 Worker
hack5 ─②建公有仓(隔离 bot 账户, repo=参赛者命名, 仓库级短时 token)─► GitHub
hack5 ─③POST /api/clients{黑客松}─► fde-copilot
hack5 ─④POST /api/clients/x/projects{想法}─► fde-copilot
参赛者 ⇄⑤POST /api/chat(多轮追问, 自动 commit spec)⇄ fde-copilot  ← 直到 readiness.loop_ready
hack5 ─⑥POST /api/commit{push:true, repo=②}─► 推 spec 到公有仓
hack5 ─⑦POST /plan+/run(入队) ─► loop-engineer(Mac Mini): plan→code→review→push
loop ─⑧回调 hack5(loop_ready/coding_done/deployed)─► hack5 部署 → 上线 URL
hack5 ─⑨GET /api/usage?client= 汇总 token ─► 计费(mini 免费1场/后付费/可赞助代付)
```

---

## 2. 职责划分

- **hack5 侧(A1–A7,本文)**:WorkBench 客户端模块(可 mock)、建公有仓、mini「做成应用」入口 UI、构建状态、作品详情页、AI 起名、计费汇总。付费门禁 `plan='paid'` 已完成。
- **WorkBench 侧(W1–W7,见 CC-51 + `Self-FDE-WorkBench/docs/hack5-对接-实现计划.md`)**:loop-engineer 薄 HTTP(入队)、commit/loop 指定目标仓库、per-参赛者隔离+作用域 token、建仓+部署、回调、出账单、并发。
- **隔离原则**:所有 mini 逻辑按 `mode==='mini'` 隔离,open/secret 不受影响。

---

## 3. 接口契约(§5 v2 唯一真相来源)

见 §5。hack5 侧新增环境:`WORKBENCH_BASE_URL`、`WORKBENCH_TOKEN`(admin,CF secret)、`WORKBENCH_CALLBACK_SECRET`(回调验签)、`WORKBENCH_MOCK=1`(未联调走假数据)。

---

## 4. hack5 侧可执行任务(A1–A7)

| # | 任务 | 验收 | 今晚自主? | 依赖 |
|---|---|---|---|---|
| **A0** | 付费门禁 `plan='paid'` | 免费账户开 secret 被拦、mini 首场后被拦;paid 无限 | ✅ **已完成**(branch `feat/paid-accounts`) | — |
| **A1** | **WorkBench 客户端模块** `src/workbench.ts`:typed fetch 封装 clients/projects/chat/commit/plan/run/status/usage,带 admin `x-workbench-token`,**mock 模式** | mock 下各函数返回契约 v2 形状;真实模式打 `WORKBENCH_BASE_URL` | ✅ 是(mock 可测) | §5 v2 |
| **A2** | **建公有仓 API** `createParticipantRepo(name)`:隔离 bot 账户、**仓库级短时 token**、仓库名白名单(`^[a-z0-9][a-z0-9-]{0,38}$`) | 真实 GitHub 建一次性仓再删;非法名被拒;token 不落 env/日志 | ✅ 是(打真实 GitHub) | bot 账户 + token |
| **A3** | **mini「做成应用」入口 UI**:mini 提交页加"✨ 让 AI 帮我做成应用"→ 走 A1 的 chat 多轮 → 显示 readiness + 队列位 | 本地 wrangler dev 走 mock,多轮对话、显示 loop-ready/queuePos | ✅ 是(对 mock) | A1 |
| **A4** | **状态 + 构建展示**:submissions 增 `wb_client/wb_project/repo_url/app_url/build_state`;卡/详情显示 排队/构建/上线/失败 | migration + 展示;状态按 v2 状态机流转(mock/回调驱动) | ✅ 是 | A1,A3 |
| **A5** | **作品详情页** `/s/<id>`:截图+简介+仓库链接+在线 URL+构建状态徽章+点赞分享 | 路由渲染;mini 作品可点进详情 | ✅ 是 | A4 |
| **A6** | **AI 起名** `POST /api/tenant/mini/name`:gpt-4o-mini 给 2–3 个项目名建议(复用 miniAssist 限流+配额) | 返回候选名;每日配额限流 | ✅ 是 | — |
| **A7** | **计费汇总**:`GET /api/usage?client=` 按 hackathon/参赛者归集;mini 免费1场/之后累计待结算(先只读展示) | 展示每人 token 用量;对齐免费额度 | ⚠️ 半(mock 用量可做,真值等 WorkBench) | A1 |
| **A8** | **真实端到端联调**(关 mock,打真实 WorkBench + 部署) | 一个想法从输入到上线跑通 | ❌ **阻塞**:需 Mac Mini + W1/W2 交付 | W1,W2,W4 |

---

## 5. 接口契约 v2(定稿 2026-07-20,CC-51 对齐)

鉴权分两层:**编排调用**(clients/projects/chat/commit/plan/run/status/usage)用 admin `x-workbench-token: <WORKBENCH_TOKEN>`;**参赛者会话**(chat)用 hack5 HMAC 签发的作用域 token。

```
# fde-copilot(已就绪,勿改形状)
POST /api/clients              { name, background }                         → { client:{slug,...} }
POST /api/clients/:c/projects  { name, deliverableName, deliverableType }   → { project:{slug,...} }
POST /api/chat                 { clientSlug, projectSlug, input, attachments? }
                               → { result:{ readiness:{ score, loop_ready } }, commit }
POST /api/commit               { clientSlug, projectSlug, push, repo? }      → { pushed, sha, ... }
GET  /api/usage?client=<slug>  → { global, perProject, byClient, at }

# loop-engineer 薄 HTTP(W1;复用 dashboard.ts:235 的 ~60% 脚手架)
POST /plan   { clientSlug, projectSlug, repo }  → { jobId }
POST /run    { jobId }                          → { accepted:true, jobId, queuePos }   ← 入队语义(B1)
GET  /status/:jobId  → { state: queued|planning|coding|reviewing|done|failed, prUrl?, appUrl? }

# 回调(W5)  hack5 接收端 POST /api/wb/callback,body 带 HMAC 签名(WORKBENCH_CALLBACK_SECRET)
{ event:'loop_ready'|'coding_done'|'deployed', clientSlug, projectSlug, repo, appUrl? }
```

**v2 关键约束(B/C/Q)**:
- **B1 入队**:`/run` 入队,不返 409;v1 串行队列,并发(W7)往后放;UI 显示 queuePos。
- **B2 push token 安全(最高优先)**:公有仓落**隔离 bot 账户**(如 `hack5-mini-bot`,不挂主 org);每想法用**仓库级短时 fine-grained token / GitHub App**;**对 loop 代码沙箱不可见**(不进 env/loop.json/worktree),只在 push 边界用;**绝不下发 account 级 PAT**。
- **B3 双层鉴权**:编排用 admin token;chat 用 hack5 HMAC 签发的作用域 token(claim 含 client/project 路径)。
- **B4 远程可达**:loop-engineer 保持本机绑定 + token 鉴权,hack5 经鉴权隧道打入、改写 Host。
- **C1 状态机**:持久化 per-job `queued→planning→coding→reviewing→done→failed` + prUrl/appUrl。
- **C2 回调加固**:HMAC 签名 + 重试 + 幂等键。
- **C3 部署范围**:v1 仅静态 + CF Worker/Pages Functions。
- **C4 计费**:成本模型 Phase 2;v1 只记录用量,免费/付费用 `plan='paid'`。
- **Q1–Q3**:`(client, participant)` 幂等键;30min 超时 + `maxAttempts=3` + 失败 UX;`jobId=manifest.id`。

---

## 6. 回答两个产品问题

**AI 起名(A6)**:mini 参赛者填完想法,一键让 AI 给 2–3 个项目名建议(非开发者常卡"叫啥")。轻量、便宜、限流,复用现成 miniAssist 管线。

**作品详情页(A5)建议**:mini 现在作品墙只有裸链接+点赞,无详情页。加 `/s/<id>`:项目名+一句话简介+作者;截图轮播;**三个关键链接**(在线试用 URL / 公有仓库 / 规格预览);**构建状态徽章**(排队/构建/上线/失败);点赞+分享(复用现有组件/二维码);深浅色+移动端堆叠。承接 WorkBench 产出(URL+仓库)的落点。

---

## 7. hack5 侧 /loop 顺序

1. **A0** 付费门禁(branch `feat/paid-accounts`,已完成,待并入)。
2. **A1** WorkBench 客户端模块(mock,按 §5 v2)。
3. **A2** 建公有仓 API(隔离 bot 账户 + 仓库级短时 token + 白名单)。
4. **A6** AI 起名。
5. **A5** 作品详情页 `/s/<id>`。
6. **A4** 构建状态字段 + 展示(状态机 v2)。
7. **A3** mini「做成应用」入口 UI(对 mock 走多轮 chat + 队列位)。
8. **A7** 计费汇总(mock 用量只读)。

每项:建分支 → 实现 → `npm run typecheck` + 抽 client JS `node --check` + 本地 wrangler dev(临时无 routes 配置)自测 → 开 PR → **停,等 review**(禁止自动合并)→ 下一项。**A8 真实联调阻塞**,等 WorkBench W1/W2/W4 + Mac Mini。

---

*执行计划稿(含契约 v2)。WorkBench 侧对应文档:`Self-FDE-WorkBench/docs/hack5-对接-实现计划.md`。协同:Seeder · CC-51。hack5 · Mycelium × AuraAI WorkBench。*
