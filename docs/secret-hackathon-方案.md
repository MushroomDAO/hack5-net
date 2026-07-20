# hack5 Secret · 企业私密黑客松 — 产品 + 技术方案(设计稿)

> 目标:在现有开放式 hack5 之上,增加一种**私密 / 企业模式**——企业发布赛题与资料、邀请制参赛、
> 参赛者**不暴露源代码**地提交(在线 Demo + 凭据 + README + 文档 + 视频),评委通过 Demo 评审打分。
> 原则:**底层组件尽量复用,业务逻辑相互隔离**。本文只做设计,不含实现。

---

## 1. 两种模式的差异(Open vs Secret)

| 维度 | 开放式(现有) | 私密 / 企业(新) |
|---|---|---|
| 站点可见性 | 公开,任何人可浏览作品墙 | **门禁**:无访问码看不到任何内容 |
| 进入方式 | 直接进 | **访问码**(全场共享口令 或 每人一次性码) |
| 赛题 / 资料 | 首页简介 | 可**下载的赛题简报 + 资料**(PDF / Word / 链接) |
| 代码提交 | GitHub **Public** 仓库(强制公开,系统校验) | GitHub **Private** 仓库;参赛者把**评委的 GitHub 账号加为协作者**,评审期保持、结束后可移除 |
| 评委怎么看 | 仓库 + 视频 + 截图 | **在线 Demo + Demo 账号密码** + README 文本 + PDF/PPT + 视频 + **作为协作者 clone 私有仓库评估** |
| 作品墙 | 公开 | 仅评委 / 管理员可见,不公开 |
| 海报 / 一键转发 | 有 | 关闭(私密不对外传播) |

---

## 2. 角色与流程

### 2.1 企业主办方(Enterprise organizer)
1. 邮箱登录 → 发起黑客松时**选择「私密 / 企业」模式**。
2. 写**赛题简报** + 上传**资料**(PDF / Word / 外链)。
3. 设置**访问码**:全场共享口令(必填)+ 可选每人一次性码。
4. 生成**评委码**(复用现有评委机制)。
5. 邀请参赛者(把访问码/一次性码发出去,系统不强制发信)。

### 2.2 参赛者(Participant)
1. 打开站点 → **门禁页**输入访问码 → 获得访问会话。
2. 查看赛题简报 + **下载资料**。
3. **提交作品**(强约束,不暴露源码):
   - 产品名称 *
   - **在线 Demo URL** *(评委据此评审)
   - **Demo 账号 + 密码** *(仅评委可见,评委用它登录体验)
   - **README(直接粘贴 Markdown 文本)** *(项目大概介绍,不从私有仓库抓)
   - **GitHub Private 仓库 URL** + 按页面展示的**评委 GitHub 清单,把评委加为该私有仓库协作者**(评审后可移除)
   - PDF / PPT 项目介绍(可选,上传)
   - 演示视频链接(B站 / YouTube,可选)
4. 用返回的**编辑令牌**改稿(复用现有机制)。

### 2.3 评委(Judge)
1. 评委码登录 + **提供自己的 GitHub 账号**(用于被参赛者加为私有仓库协作者)。
2. 打开每个作品:**用提供的 Demo URL + 账号密码登录体验产品** → 读 README / PDF / 视频 → **作为协作者 clone 私有仓库看代码**。
3. 按四维打分(创新 / 技术 / 完成度 / 展示)→ 私密排行榜 → 管理员导出 CSV。(全部复用)

---

## 3. 复用 vs 隔离(核心架构决策)

**结论:不另起一套代码库,而是给 tenant 加一个 `mode` 开关,同一套表/函数按 mode 分支。** 这样底层最大化复用,业务通过 `mode` 判断隔离。

### 3.1 直接复用(几乎 0 改动)
- 多租户解析 `resolveTenant` / 子域名 / D1 / KV / 无状态 HMAC cookie。
- **评委码 + 四维打分 + 排行榜 + CSV 导出**(scores / judges 表)——私密模式排行榜不公开即可。
- 邮箱登录 + 建站 + 配额(users / tenants)。
- **编辑令牌**改稿、图片上传到 KV 的压缩管线、README 沙箱渲染(现有 iframe sandbox)。
- 深色模式 / i18n / 组织资料 / 页脚。

### 3.2 需要隔离 / 新增的逻辑
| 能力 | 做法 |
|---|---|
| 模式开关 | `tenants.mode ∈ {open, secret}`;`resolveTenant`/`config` 带出 `mode` |
| **访问门禁** | secret 模式下,内容路由(config 详情 / 作品墙 / 资料下载 / 提交)需 `hv_access` 会话;无则返回门禁 |
| 访问码 | **每人一次性码**(复用 `invite_codes`,单次兑换)→ 起 `access_days` 会话(默认 7 天,主办方可改) |
| 评委 GitHub | `judges.github_user`;参赛者提交页展示评委 GitHub 清单,自行加为私有仓库协作者 |
| 私密提交字段 | `submissions` 加列:`demo_url` / `demo_user` / `demo_pass` / `readme_md` / `doc_key`(仅 secret 用,open 留空) |
| 不校验公开仓库 | open 模式会调 GitHub API 校验 repo 是 Public;secret **跳过**(私有仓库无法校验),只登记 URL |
| 敏感字段可见性 | `demo_user/demo_pass` 仅评委/管理员可见(复用现有 `includeContact` 门控思路) |
| 赛题资料 | 新增 `materials`(附件):PDF/Word 存 KV/R2,门禁后可下载 |
| 作品墙不公开 | secret 模式作品列表仅评委/管理员;公开访问返回门禁 |
| 关闭对外功能 | secret 模式隐藏 海报 / 一键转发 / 公开作品墙 导航 |

---

## 4. 数据模型改动

```sql
-- 模式 + 访问会话时效
ALTER TABLE tenants ADD COLUMN mode TEXT NOT NULL DEFAULT 'open';   -- 'open' | 'secret'
ALTER TABLE tenants ADD COLUMN access_days INTEGER NOT NULL DEFAULT 7; -- 访问会话有效天数(主办方可改)

-- 评委需绑定 GitHub(用于被参赛者加为私有仓库协作者)
ALTER TABLE judges ADD COLUMN github_user TEXT;

-- 私密提交(open 模式这些列留空)
ALTER TABLE submissions ADD COLUMN demo_url TEXT;
ALTER TABLE submissions ADD COLUMN demo_user TEXT;
ALTER TABLE submissions ADD COLUMN demo_pass TEXT;   -- 仅评委/管理员可见(§6);不落库加密——只是演示账号
ALTER TABLE submissions ADD COLUMN readme_md TEXT;   -- 参赛者粘贴的 Markdown
ALTER TABLE submissions ADD COLUMN repo_url TEXT;    -- 私有仓库 URL(只登记,不 fetch)
ALTER TABLE submissions ADD COLUMN doc_key TEXT;     -- PDF/PPT 在 R2/KV 的 key

-- 访问码:复用 invite_codes 作"每人一次性入场码"(单次兑换 → 起 access_days 会话)

-- 赛题资料(主办方上传,门禁后可下载)
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL,            -- 'file' | 'link'
  kv_key TEXT, url TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_tenant ON materials(tenant_id, created_at);
```

- 入场码复用 `invite_codes`(它已是"每码单次消费");可用途区分:secret 下既能当"入场"又能当"提交"码,或加一列 `purpose`。
- 文件存储:图片沿用 KV;**PDF/PPT/Word 体积大**,建议走 **R2**(现有 `VIDEO_UPLOAD` 已为 R2 预留开关,可复用 R2 绑定),KV 仅存小文件。

---

## 5. 访问门禁(私密模式的核心)

- 新增 `POST /api/tenant/access`:校验**每人一次性访问码**(复用 invite_codes,单次兑换)→ 下发 `hv_access` HMAC cookie(tenant 绑定,`exp = now + access_days*86400`,复用现有 cookie 签名工具)。**带失败次数上限**(§10.1)。
- Worker 入口中间件:若 `tenant.mode==='secret'` 且请求命中"受保护路由"(config-detail / 作品列表 / 详情 / 资料下载 / 提交),校验 `hv_access`;缺失 → 返回精简 config(只含名称 + `gated:true`),前端渲染**门禁页**要求输码。
- 管理员 / 评委的既有 `hv_auth` 会话可视为已通过门禁(他们本就有权限)。

---

## 6. 安全要点

- **Demo 账号密码**:按拍板,只是演示账号(不含源码/需求/企业数据),做到**仅评委/管理员可见**即可(公开/未登录返回 null,复用 `publicSubmission` 门控);**不落库加密**。但注意 §10.2:CSV 导出不带明文 demo_pass。
- **私有仓库 URL**:只登记、**不主动 fetch**(评委看不到也不需要);避免把 token 暴露给私有仓库。
- **README 文本**:参赛者粘贴,**沙箱 iframe 渲染**(复用现有 README 渲染的 `sandbox` + CSP),防注入。
- **资料 / 附件下载**:必须门禁后才可下;附件服务加 `nosniff` + CSP `sandbox`(复用 §已上线的上传服务加固)。
- **门禁绕过**:所有 secret 内容路由都要过 `hv_access`,别只在前端隐藏。
- **上传白名单**:PDF/PPT/Word 仅允许既定 MIME(application/pdf 等),拒可执行/SVG(复用 `isRasterImage` 的思路,扩一个文档白名单)。

---

## 7. UX / 页面

- **发起表单**:加「模式」选择(开放 / 私密);选私密时展开:访问口令、赛题简报、资料上传。
- **门禁页**(secret 未入场):居中一张卡「本黑客松为受邀私密活动,请输入访问码」。
- **参赛者提交页**(secret 版):Demo URL / Demo 账号密码 / README(Markdown 文本域)/ 私有仓库 URL / PDF/PPT 上传 / 视频链接。
- **评委详情页**(secret 版):醒目展示 **Demo 链接 + 账号密码(一键复制)**、README 渲染、附件下载、视频、评分面板。
- secret 模式**隐藏**:海报 / 一键转发 / 公开作品墙 / 组队墙(按需)。

---

## 8. 分期落地建议

**Phase 1(MVP,最大复用)**
- `tenants.mode` + `access_pass_hash` + 访问门禁 + 门禁页。
- secret 提交表单(demo_url / demo_user / demo_pass / readme_md / private repo URL)+ 敏感字段仅评委可见。
- 评委详情页(Demo 凭据 + README)+ 复用打分/排行榜/CSV。

**Phase 2**
- 赛题资料上传/下载(PDF/Word,R2)、PDF/PPT 作品附件、Demo 密码加密存储、每人一次性入场码、审计。

**Phase 3(可选)**
- 企业计费 / 独立品牌域名 / SSO / 更细的权限(观察员、多轮评审)。

---

## 9. 已确认决定(拍板)

1. **访问码 = 每人一个、一次性**:每个参赛者一枚专属访问码,**单次兑换**(领取即绑定该参赛者);兑换后进入一个**有时效的访问会话**。
2. **有效期默认 7 天,主办方可改**:在发起私密黑客松时设置有效期(默认 7 天);到期后该会话失效,需重新授权。→ 数据:`tenants.access_days`(默认 7)、`hv_access` cookie 的 `exp` = 首次兑换 + access_days。
3. **私有代码用「评委协作者」模式**(替代"评委看不到"):
   - 评委在**登录/注册时必须提供自己的 GitHub 账号**(用户名)。→ 数据:`judges.github_user`。
   - 参赛者提交时,看到**本场评委的 GitHub 账号清单**,把他们**加为自己私有仓库的协作者**(在 GitHub 上自行操作)。
   - 评审期保持协作关系,评委**用自己电脑 clone 代码评估**;评审结束后参赛者可移除协作者。
   - 平台只**登记私有仓库 URL + 展示评委 GitHub 清单**,不持有参赛者 token、不自动改协作者(MVP 手动;后续可选 OAuth 自动加)。
4. **Demo 密码只需"评委可见"级别,不做落库加密**:因为它只是一个不含源码/需求/企业数据的**演示账号**,用户名+密码足够;严格锁死**仅评委/管理员可见**即可(公开/未登录返回 null)。
5. **私密/企业模式 = 付费档**(对齐生态可持续文档的"消耗触发收费")。
6. 附件/域名:附件 PDF/PPT 走 R2(见 §4),体积上限实现时定;域名先用 `<sub>.hack5.net` + 门禁(不可枚举域放后续)。

## 10. 实现前必须纳入的安全点(review 补充)

1. **访问码限流**:共享/每人访问码校验要有**失败次数上限**(参照现有 email verify 的 `attempts` 机制),防暴力枚举。
2. **CSV 不导出明文 demo_pass**:导出(评分/名单 CSV)里**不放 demo 密码**明文,否则"仅评委可见"的约束被导出抵消;确需给主办方时单独走受控通道。
3. **编辑令牌 × 凭据隔离**:持 `edit_token` 者可改稿,但 `demo_pass` 的**可见性仍只对评委**开放——别让编辑令牌泄漏连带把 Demo 凭据也暴露给非评委。
4. **逐路由门禁清单**:实现时**列出所有 secret 数据路由**逐条确认挂了 `hv_access`(config 详情 / 作品列表 / 详情 / 资料下载 / 提交 / 附件),不能有一条漏挂只靠前端隐藏。

---

*决定已并入。底层复用、逻辑隔离的原则贯穿全文。待你说"开做"即进入 Phase 1 实现(仍开 PR 等你 review)。hack5 · Mycelium。*
