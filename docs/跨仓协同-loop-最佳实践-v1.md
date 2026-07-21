# 跨仓协同 · 自主 /loop 最佳实践 v1

> 从 2026-07-20 晚 hack5 Mini × WorkBench(CC-51)一晚跑通 A1–A7 的实战里抽象出来的标准流程。
> 定位:**「发起方一个对话框 + 后台 review 机器人 + Seeder 协同看板」三者配合,把一批 PR-per-item
> 的任务自主推进到全部合并**。这是 local loop 的第一版规程,后续可迭代。

---

## 0. 一晚发生了什么(事实基线)

- 一个对话框跑 `/loop`,在 `hack5-net` 单仓内依次实现 A1–A7,每项:独立分支 → 实现 →
  三道本地自测 → 开 PR → **不自动合并** → 等 review。
- 一个**后台 review 机器人**(账号 `clestons`)对每个 PR 做最多 4 轮 review,给 APPROVED /
  CHANGES_REQUESTED。
- 结果:7 个 PR(#29–#35)全部合并;机器人抓到并被修复 **3 个真实跨仓 bug**,全是「两侧格式/契约对不齐」:
  1. A1 作用域 token 的 claim 字段 / HMAC 输入 / 编码 / 密钥名,与 WorkBench verifier 不咬合;
  2. A4 回调签名 WorkBench 带 `sha256=` 前缀、hack5 裸 hex 比对 → 每个合法回调都 401;
  3. A3 公开 mini 下 chat/launch 匿名可无限烧钱/建仓(零限流)。
- **结论**:跨仓任务里,绝大多数返工来自「契约的字节级细节两侧没对齐」和「成本/权限边界没堵」,
  而不是业务逻辑。流程要专门为这两类问题设防。

---

## 1. 角色模型(谁做什么)

| 角色 | 是谁 | 职责 |
|---|---|---|
| **发起方 Initiator** | 需求所在仓的 loop(如 hack5-net) | 拆任务、定契约草案、PR-per-item 实现自己这侧、对着 mock 跑通、开 PR、响应 review |
| **协同方 Collaborator** | 被依赖仓的 loop(如 WorkBench) | 认领对方提的 W 任务清单、评审契约、补自己这侧、也 PR-per-item |
| **军师 / 协调层** | Seeder 的 Cooperation-Center(CC-xx 任务) | **唯一的跨仓真相来源**:契约定稿、分工、阻塞点(B/C/Q)都写在这条任务的评论里 |
| **Review 机器人** | 后台常驻进程(clestons) | 轮询开着的 PR,做对抗式 review,给 APPROVED / CHANGES_REQUESTED;**它是合并闸门** |

关键点:**这是 4 个独立进程**,不是一个。发起方和协同方各跑各的 loop(各自一个对话框),
靠 CC 任务异步对齐,靠 review 机器人把关。

---

## 2. 一个对话框还是两个?

**每个仓一个对话框(一个 loop)。**

- hack5-net 侧 A1–A7 = 1 个对话框跑 `/loop`。
- WorkBench 侧 W1–W7 = **另一个对话框**跑它自己的 `/loop`(在 WorkBench 仓里)。
- review 机器人 = 独立后台进程,**不占对话框**。
- 两个 loop **不直接通信**,只通过 Seeder CC 任务的评论异步握手(契约、阻塞、交付状态)。

为什么不合成一个:两侧仓库、工具链、评审都独立,合一会互相阻塞(等对方在线才能推进),
而拆开后「对着 mock/桩先做」就能各自全速,交付即联调。

---

## 3. 启动顺序与依赖条件(什么时候能启动 loop)

```
① 军师建 CC 任务(Seeder Cooperation-Center)
   └─ 写清:端到端目标、职责边界、给协同方的 W 清单、接口契约草案
② 双方在 CC 评论里评审契约 → 达成「契约 vN 定稿」
   └─ 阻塞级问题(鉴权模型、密钥粒度、并发语义、成本边界)必须先拍板,否则返工
③ 把定稿契约同步进两仓的 docs(§5 契约 = 唯一真相来源)
④ 各仓开一个对话框跑 /loop —— 此时才启动
```

**硬门槛:契约 vN 未定稿前,不要启动会「动鉴权 / 动 push / 动跨仓数据形状」的 loop。**
可以先做纯本地、不碰契约的部分(如 mock 客户端骨架),但涉及两侧咬合的代码必须等定稿。

昨晚就是先在 CC-51 把 B1(入队语义)/B2(隔离 bot + 仓库级短时 token)/B3(双层鉴权)/
C1–C4/Q1–Q3 全部拍板成「契约 v2」,才启动 loop —— 这一步省掉了大量返工。

---

## 4. 发起方 loop 的内循环(每一项)

```
for 每个任务项 in §7 顺序(按真实依赖排,不是编号):
  1. 从最新 main 开独立分支(git fetch + 基于 origin/main)
  2. 实现(隔离原则:新代码不碰无关模式/路径)
  3. 三道自测闸门(见 §6),全绿才继续
  4. git commit(带 Claude-Session trailer)+ push + gh pr create --base main
  5. 【停】不自动合并,进入 review 等待
  6. 继续下一项(不阻塞等 review)
并行:后台监听 PR review 决定 →
  APPROVED       → 合并(squash --delete-branch)→ pull main → 解决后续分支冲突
  CHANGES_REQUESTED → 读 comment → 修 → push → 评论说明 → re-request review
直到所有项 APPROVED 且合并 → 收尾(通知 + 停 loop)
```

### 分支 / PR 纪律
- **每项独立分支、独立 PR、base = main**,PR 之间互不依赖评审。
- **禁止自动合并**;合并的唯一授权 = review 机器人 APPROVED。
- 依赖链:若 B 依赖 A 的产物(如新增的 DB 列),**等 A 合并进 main 再从新 main 开 B 分支**,
  不要基于未合并的 A 分支开 B(会把 A 的 diff 混进 B 的 PR)。
- **顺序按真实依赖,不按计划编号**。昨晚计划 §7 写 A5→A4→A3,但依赖上 A5 需要 A4 的列、
  A4 需要 A3 写入 —— 实际按 A4→(A5,A3)→ 依赖满足才做,并在 PR 里说明这个调整。

### 合并后的连锁冲突(单大文件的代价)
若所有项都改同一个大文件(如 `src/index.ts` 的 Env / 路由表 / 函数区),先合的会让后面的分支
在这些锚点冲突。处理:`git rebase main` → 保留两边新增、删掉重复(如重复的 env 变量)→ force-push。
**能减少并发未合并分支就减少**(尽量串行合并),冲突面更小。

---

## 5. Review 轮询机制(怎么知道 PR 被 review 了)

用一个**常驻 Monitor**(后台 poll 脚本),而不是自己反复手动查。核心两点:

1. **按每个 PR「最新一条 review 的 `submitted_at`」做去重键**,不要用 PR 的 `updatedAt`。
   - 踩坑:v1 用 `reviewDecision + updatedAt` 做键 → 我自己发一条评论/re-request 也会改 `updatedAt`,
     导致同一条 CHANGES_REQUESTED 反复误触发。
   - v2 正解:`gh api repos/OWNER/REPO/pulls/N/reviews` 取 `state ∈ {APPROVED,CHANGES_REQUESTED}`
     里 `submitted_at` 最大的那条,键 = `N|state|submitted_at`。只有**真的来了新 review** 才触发。

2. **只在有可行动的状态时才发事件**(APPROVED / CHANGES_REQUESTED),poll 间隔 60–90s(远程 API 限流)。

参考 Monitor 命令(每 90s poll 一次,新 review 才 echo 一行):

```bash
SEEN=/tmp/pr_seen.txt; touch "$SEEN"
while true; do
  for n in $(gh pr list --repo OWNER/REPO --state open --json number --jq '.[].number'); do
    line=$(gh api "repos/OWNER/REPO/pulls/$n/reviews" \
      --jq '[.[]|select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")]
            | sort_by(.submitted_at) | last | select(.!=null) | "\(.state)|\(.submitted_at)"')
    [ -z "$line" ] && continue
    key="$n|${line}"
    grep -qxF "$key" "$SEEN" || { echo "$key" >> "$SEEN"; echo "PR #$n ${line%%|*}"; }
  done
  sleep 90
done
```

事件到了怎么动:
- **APPROVED** → `gh pr merge N --squash --delete-branch` → `git pull --ff-only origin main` →
  若有后续分支变 CONFLICTING,逐个 rebase 解决。
- **CHANGES_REQUESTED** → `gh api .../reviews` 读 body → 定位改动 → 修 → 重跑三道自测 →
  `git push` → `gh pr comment N`(逐条说明怎么修的)→ `gh pr edit N --add-reviewer <bot>` 重审。
- **注意 rebase 后 force-push 可能触发重审**:昨晚机器人对 rebase 后仍保留 APPROVED,但不同
  仓库设置可能「dismiss stale approvals」,遇到就再等一轮。

---

## 6. 本地自测三道闸门(每项必过,才允许开 PR)

针对 Cloudflare Worker(单文件 + 内嵌 client JS)这类项目,昨晚固化出三道:

1. **类型**:`npm run typecheck`(`tsc --noEmit`)。
2. **抽取内嵌 client JS 做语法检查**:把 `APP_HTML` 里 `<script>…</script>` 抽出来 `node --check`。
   - 坑:正则别误匹配代码注释里出现的 `<script>` 字样 —— 从 `const APP_HTML` 之后再扫。
3. **临时无 routes 的 `wrangler dev` 本地冒烟**:
   - 生产 `wrangler.jsonc` 带 custom-domain routes,本地绑不了 → 生成一个**去掉 routes**、
     `workers_dev:true`、注入本地测试 vars(如 `WORKBENCH_MOCK=1`)的临时配置跑 dev,curl 打端点。
   - 把临时配置加进 `.git/info/exclude`,别误提交。

配套「mock 优先」:每个模块都有 `WORKBENCH_MOCK=1` 的离线假数据路径 + 一个**仅 mock 下可用
(生产 404)的 selftest 端点**,让全链路在没有真实后端/凭据时就能 wrangler dev 自测。
真实联调(A8)阻塞的部分,老实标注,不假装跑通。

---

## 7. 跨仓契约对齐(3 个 bug 的通用教训)

跨仓最容易错的是**「字节级契约」**。对齐清单(签发方 ↔ 校验方逐项核对):

- **签名/token**:claim 的**字段名**、HMAC 的**输入是原始字节还是编码后串**、sig 的**编码
  (hex vs base64url)**、**header 是否带前缀**(如 `sha256=`)、**密钥用哪个 env 名且两侧同值**。
- **语义枚举**:状态机取值、事件名、`/run` 是「即时开跑」还是「入队 + queuePos」——两侧枚举要一致。
- **返回形状**:字段可选性(如 `sha` 何时缺省)、多出的字段(`committed`/`detail`)。
- **成本/权限边界**(最高优先):公开入口必须有**限流 + 每人配额**;凭据必须**最小权限 + 短时效 +
  对不可信执行沙箱不可见**(B2:仓库级 fine-grained / GitHub App installation token,绝不下发 account PAT)。

做法:**在 selftest 里把契约形状 assert 出来**(如把签好的 token 解回 claim 打印字段),
让 review 机器人一眼能对上另一侧。

---

## 8. /loop 提示词模板(可直接套用)

昨晚生效的提示词,抽象成模板:

```
按 <契约/计划文档路径>(含 §5 契约 vN)顺序实现 <任务清单,如 A1–A7>,跳过已完成项;
每项:开独立分支 → 实现 → 跑 <自测闸门:如 npm run typecheck + 抽 client JS 做 node --check
  + 临时无 routes 的 wrangler dev 本地自测(mock)> → 通过后开 PR 停在待 review(禁止自动合并)
  → 再继续下一项;
<关键安全/契约硬约束,如:A2 建公有仓必须用隔离 bot 账户 + 仓库级短时 token(B2),仓库名白名单>;
【背景:有一个后台机器人在循环 review 我的 PR。approve 了就 merge 进 main 再继续;
  request change 了就看 comment 修改后 re-request review。只有 review 通过才可以合并。】
直到 <任务清单> 全部开出 PR 并合并。
```

提示词写法要点:
- **明确「不自动合并 + 等 review 机器人」**——否则 loop 会自己合,失去评审闸门。
- **把最高优先的安全/契约硬约束单独点出来**(如 B2 token 粒度),别埋在文档里让它自己领会。
- **说清「跳过已完成项」**,让重入(每次 /loop 唤醒)幂等。
- **给出自测闸门的确切命令**,别只说「测一下」。
- 这是 dynamic /loop(无固定间隔):自定步调 + Monitor 事件驱动 + fallback 心跳(1200–1800s)。

---

## 9. 待改进(v1 的坑,v2 要修)

1. **Monitor 去重键**:必须用 `latest review submitted_at`,别用 PR `updatedAt`(见 §5)。已在 v1 中途修正,写进规程。
2. **单大文件冲突**:所有项改同一文件 → 连锁 rebase。建议尽量拆文件,或**串行合并**(合一个再开下一个分支)减少并发未合并分支。
3. **计划顺序 vs 真实依赖**:文档编号顺序可能与依赖倒挂,启动前先按依赖拓扑排一遍,在 PR 里注明调整。
4. **本地 D1 seeding 踩坑**:种测试租户要给 `created_at/updated_at`(NOT NULL)+ `mode='mini'`,否则 insert 静默失败、后续查询 404。把 seed 脚本沉淀成工具。
5. **rebase 后重审的不确定性**:不同仓的「dismiss stale approvals」设置不同,合并前确认策略,别假设 approval 一定保留。
6. **成本护栏应「默认内建」**:公开入口的限流 + 每人配额不该等 review 才补 —— 应做进脚手架/checklist,开 PR 前自查。
7. **凭据串联要一次到位**:B2 的仓库级 push token,mock 阶段就把「铸取 + 透传」的形状留好(如 `CommitInput.pushToken`),别等真推时才发现 A1 契约没这个字段。

---

## 10. 可复用脚手架清单

- `check-client-js.mjs`:从 `src/index.ts` 抽 `APP_HTML` 内 `<script>` 块,`node --check`(从 `const APP_HTML` 之后扫,避开注释里的 `<script>`)。
- `mk-dev-config.mjs`:读生产 `wrangler.jsonc` → 去 routes、`workers_dev:true`、注入测试 vars → 写临时 `wrangler.dev.jsonc`(用完删,已 gitignore)。
- PR-review Monitor 命令(见 §5)。
- selftest 端点约定:`/api/.../selftest`,仅 `MOCK=1` 可用、生产 404,assert 契约形状。

---

## 11. 可执行开机 SOP(一步做什么、二步做什么)

**第一步 · 建协同任务(军师,协调对话框里一次)**
用 `/goutou` 建/更新一条 Seeder CC 任务,正文写清:端到端目标 + 职责边界(A 清单给发起方 /
W 清单给协同方)+ §5 接口契约草案;打 `from:<发起仓>` / `repo:<协同仓>` 标签。

**第二步 · 定契约(双方在 CC 评论里)**
协同方评审契约,挑出**阻塞级**问题(鉴权模型、密钥粒度、并发语义、成本边界 = B/C/Q)逐条拍板
→ **「契约 vN 定稿」**,同步进两仓 `docs/`。⚠️ 未定稿前不启动会碰鉴权/push/跨仓数据形状的 loop。

**第三步 · 各仓各起一个 loop(每仓一个终端)**
```bash
cd <仓库根目录> && claude      # 每个仓库一个终端 = 一个 loop
```
然后粘贴对应提示词(见 §8 模板)。发起仓填 A 清单,协同仓填 W 清单。后台 review 机器人已常驻。

**第四步 · 收尾**
两侧各自 loop 把自己的 PR 全合并后,**各自往 CC 回一条「交付状态」评论**(← v1 里 hack5 漏了这步,
导致看板一直显示 ⏳)。都齐 → CC 进入「联调」阶段。

---

## 12. 到底要几个对话框?goutou 要不要单独起?

- **同一个仓库 = 一个对话框 = 一个 loop。** 不需要为同仓的多个任务开多个窗口;A1–A7 全在一个 loop 里串行推进。
- **昨晚是「两个对话框」纯粹因为是两个仓库**(hack5-net 一个、Self-FDE-WorkBench 一个),各自跑各自的 loop。同仓从来只要一个。
- **`/goutou`(狗头)不是一个 loop,是一次性动作**(把跨仓诉求单写进 Seeder CC)。不要为它单开对话框/loop——把它**折进那一个 loop 的提示词**即可:「开工前先 `/goutou` 把给对方的诉求单发到 CC-<编号>;每合并一项回报状态到 CC」。loop 会自己调用 goutou。
- **协同方那侧的 W 工作仍需要它自己的 loop 来做**(在对方仓库里)。它是「自动起」还是「手动起」取决于有没有一个 goutou 巡逻 bot 盯着 CC、自动为新诉求单拉起工兵 loop——若有(见 CC 里的 `@repo:goutou 巡逻`),你就**只需起发起方一个 loop**,协同方自动响应;若没有,协同方要有人手动 `cd <协同仓> && claude` 起一个。**这一点按你们实际的 goutou 巡逻是否常驻来定。**

一句话:**同仓一个 loop;goutou 是一次性动作写进提示词,不单独起;跨仓才有第二个 loop,且可能被 goutou 巡逻自动拉起。**

---

*v1 · 源自 hack5 Mini × WorkBench(Seeder CC-51)一晚 A1–A7 全合并的实战。发起方 = hack5-net,
协同方 = Self-FDE-WorkBench,协调 = Seeder Cooperation-Center,闸门 = 后台 review 机器人。*
