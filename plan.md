# 语雀 Token 替代方案 — 执行计划（私有库 · Cookie 模式）

> **⛔ 本计划已作废（2026-09-23），不要执行。**
> 实测否掉了它的前提：
> 1. **不需要替代 Token**。免费账户的 Token 权限范围实测齐全（`doc:read:detail` / `repo` / `group` / `private_search`），插件用到的 5 个只读端点没有一个是会员专属，「免费账户被限制」的真身是**按 Token 维度的小时级配额**，与会员、与权限都无关。
> 2. **Cookie 换不来收益**。它走的是同一个账号，且官方原话是「系统识别异常行为后会进行屏蔽处理，**可能会导致用户不可用**」——拿账号去赌一个未证实的降限流假设，且社区已有实现（`yuque-exporter` 等），插件不必内置。
> 3. **合规结论**：插件不内置任何非官方通道（决策见 `README.md` 与下文分析报告）。
>
> 真正的问题与对策已改为：**429 短探测 + 熔断 + 断点续跑**（见 `docs/CHANGELOG.md` v0.9.1）。下面内容仅作历史留存。

> 目标插件：`yuque-style`（Obsidian，v0.7.0）
> 已确认范围：目标库为**私有**；采用 **Cookie 会话认证**替代官方 Token；**不做**导出包导入、不做公开库匿名模式。
> 一句话：私有库无法"零凭证"，本方案把凭证从官方 `X-Auth-Token` 换成浏览器会话 Cookie（`_yuque_session` + `yuque_ctoken`），插件侧实现**统一认证抽象层**，对上层同步逻辑零侵入。

---

## 一、范围与基线

### 1.1 本次做什么 / 不做什么

| | 内容 |
| --- | --- |
| ✅ 做 | 认证抽象层；Cookie 输入/解析/校验；Cookie 模式下走语雀**网页端内部接口**；设置页认证方式切换；配置迁移；文档与免责声明 |
| ❌ 不做 | 公开库匿名模式；导出包导入；写回语雀 / 图床上传（插件本就只读） |
| 🔒 保持 | 官方 Token 模式**必须保留且默认**，老用户升级零感知、零破坏 |

### 1.2 当前认证基线（改造点定位）

| 项 | 位置 |
| --- | --- |
| Token 存储 | `src/main.ts:43` 定义；`main.ts:414-442` 设置页；落盘 `data.json` |
| 唯一认证头 | `X-Auth-Token` — `src/yuque/api.ts:93`（`rawRequest`）、`api.ts:250`（`getRaw`） |
| API 基址 | `const BASE = "https://www.yuque.com/api/v2"` — `api.ts:3` |
| 实例化点 | `main.ts:434`/`472`、`sync.ts:690`、`ui.ts:133`/`223`/`640`、`backfill.ts:70` |
| 离线工具实例化 | `tools/probe.ts:14`、`tools/census.ts`、`tools/orphan-diag.ts`、`tools/replicate.ts` |
| 已有能力 | 仅单向只读（语雀 → Obsidian）；无 POST/PUT；图片 `downloadBinary`（`api.ts:267`）本就不带 Token |

> **改造面小、影响面广**：认证逻辑只散落在 2 处请求头 + 1 个常量，但 `new YuqueApi(...)` 有 10 处调用点，需统一收敛到工厂函数。

### 1.3 前置阻塞项（必须最先解决）

> ⚠️ **私有库网页端接口契约未知**，这是整个 Cookie 方案的最大技术风险。
> 官方 `api/v2` 有公开文档，但 **Cookie 模式必须换到网页端内部接口（`/api/...`），该接口无公开契约、语雀可随时变更**。
> 因此**阶段 1.5 的接口探针是硬前置**：未确认接口形状前，不进入阶段 2 的编码。

---

## 二、分阶段任务

### 阶段 0 · 合规与体验确认（0.5 天）
- 撰写免责声明：Cookie 属非官方通道，存在与服务条款冲突、账号风控、Cookie 失效等风险，由用户自行判断。
- 明确 Cookie 失效时的降级体验：**不静默失败**，一律弹出「Cookie 已失效，请重新复制」并保留 Token 模式可切换。
- 明确存储策略：Cookie 与 Token 同存于本地 `data.json`（**敏感信息，README 需标注**），不上传任何第三方。

### 阶段 1 · 认证抽象层（1–2 天）— 零风险地基
- **新增 `src/yuque/auth.ts`**
  ```ts
  export type AuthMode = "token" | "cookie";
  export interface AuthStrategy {
    baseUrl: string;
    applyHeaders(headers: Record<string, string>): void;
    buildUrl(path: string): string;          // 供 ctoken 等 query 参数注入
    ensureValid(): Promise<void>;            // 轻量连通性/有效性校验
  }
  export class TokenAuth implements AuthStrategy { ... }   // 等价现状
  export class CookieAuth implements AuthStrategy { ... }  // 阶段 2 实现
  export function parseYuqueCookie(raw: string): { session?: string; ctoken?: string };
  export function createApi(settings: YuqueSettings): YuqueApi;  // 统一工厂
  ```
- **改造 `src/yuque/api.ts`**
  - `constructor(private auth: AuthStrategy)` 替换 `api.ts:71`
  - `rawRequest`（`api.ts:88-98`）、`getRaw`（`api.ts:242-254`）改用 `auth.applyHeaders()` / `auth.buildUrl()`
  - 删除硬编码 `BASE`（`api.ts:3`），改为 `this.auth.baseUrl`
  - `401` 处理（`api.ts:129-131`）按模式区分文案（Token 无效 / Cookie 失效）
- **收敛 10 处实例化点到 `createApi(settings)`**：`main.ts:434`/`472`、`sync.ts:690`、`ui.ts:133`/`223`/`640`、`backfill.ts:70`，以及 `tools/` 下 4 个离线工具。
- **验收**：默认仍为 Token 模式，全量现有测试（约 275 例）**全绿**，产物行为与改造前逐字节一致。

### 阶段 1.5 · 接口探针（1 天）— 硬前置
- 扩展 `tools/probe.ts`（或其旁路脚本，产物已 gitignore 于 `tools/.probe/`）：
  - 用真实 Cookie 请求候选网页端接口，dump 状态码 + 原始响应结构到存档目录。
- 需确认的映射（**以下为候选，须实测，不可照抄**）：

  | 现有（v2，Token 模式） | 网页端候选（Cookie 模式） | 待确认 |
  | --- | --- | --- |
  | `/user` | 网页端 user 接口 | 字段名是否含 `login` |
  | `/users/:login/repos` | 书籍/知识库列表接口 | 分页参数（`offset` vs `page`） |
  | `/repos/:ns/docs` | `/api/books/:id/docs` | 是否含 `updated_at`、`slug` |
  | `/repos/:ns/toc` | `/api/books/:id/toc` | 节点字段（`uuid`/`parent_uuid`/`url`）是否与现有 `YuqueTocNode` 兼容 |
  | `/repos/:ns/docs/:slug` | `/api/docs/:slug?book_id=…` | `mode=markdown` 是否可用；返回 `body` 还是 `body_draft`/`body_html` |
- **产出：一份「接口映射确认表」+ 原始响应样本**，作为阶段 2 的契约输入（样本同时用于阶段 3 的合约测试）。
- **决策点**：若某接口在 Cookie 模式下无法取到（例如正文只返回 HTML），需评估是复用 `lake.ts` 增强 HTML 解析，还是该能力降级并在 UI 说明。

### 阶段 2 · Cookie 模式实现（3–5 天）
- **设置层**（`src/main.ts`）
  - `YuqueSettings`（`main.ts:31`）新增：`yuqueAuthMode: AuthMode`、`yuqueCookie: string`。
  - `DEFAULT_SETTINGS`（`main.ts:60`）新增默认值 `"token"` / `""`。
  - **迁移**：老配置无 `yuqueAuthMode` → 自动置 `"token"`，不弹窗、不改行为。
  - 设置页（`main.ts:414-442` 附近）新增「认证方式」下拉；Cookie 输入框（`password` 类型）+「测试连接」按钮复用现有逻辑。
- **Cookie 解析与校验**
  - `parseYuqueCookie` 从粘贴串提取 `_yuque_session`、`yuque_ctoken`（兼容 `key=value; key=value` 与仅值两种粘贴形态）。
  - 保存时调 `ensureValid()`，失败即提示且不落库。
- **`CookieAuth` 实现**
  - `baseUrl = "https://www.yuque.com"`（网页端，非 `/api/v2`）。
  - `applyHeaders` 注入 `Cookie`；`ctoken` 按接口要求注入 header 或经 `buildUrl` 加为 query。
  - `User-Agent` 需与浏览器一致（现状 `obsidian-yuque-style` 在 Cookie 模式下可能被风控识别，需按探针结果调整）。
- **接口适配层**：按阶段 1.5 确认表，在 `api.ts` 内做「v2 路径 → 网页端路径 + 响应归一化」，**对上层 `sync.ts`/`ui.ts` 暴露的方法签名保持不变**。
- **错误处理**：`401/403` → 「Cookie 已失效，请重新复制」；限流策略按网页端实测阈值重新标定（现为 400ms 间隔 + 429 退避，见 `api.ts:77-82`/`115-127`）。

### 阶段 3 · 测试与验收（2 天）
- 新增 `tests/auth.test.ts`：`parseYuqueCookie`（多种粘贴形态）、`TokenAuth`/`CookieAuth` 的 header/url 组装、`AuthMode` 迁移。
- `tests/sync.test.ts`：注入假 `AuthStrategy`，验证同步主流程与认证解耦（现有 `sync.test.ts:68-80` 的假 `YuqueApi` 注入模式可复用）。
- 合约测试：用阶段 1.5 的真实响应样本 mock 网页端接口，**禁止真实联网**（沿用 `tests/mocks/obsidian.ts:74` 抛错策略）。
- 手工验收矩阵：

  | 场景 | 期望 |
  | --- | --- |
  | 私有库 + Token（回归） | 成功同步 |
  | 私有库 + Cookie | 成功同步，目录/属性/图片本地化与 Token 模式一致 |
  | Cookie 过期/被登出 | 明确提示重新复制，不静默失败，可切回 Token |
  | 触发 429 / 风控 | 退避重试后给出可读提示 |
  | 老用户升级 | 无感，仍为 Token 模式 |
  | Cookie 串含多余字段/换行 | 解析仍正确 |

### 阶段 4 · 文档与发布（1 天）
- `README.md`：认证方式对比表、Cookie 获取步骤（DevTools 复制）、**风险与免责声明**、`data.json` 敏感信息说明。
- `docs/CHANGELOG.md`：记录 v0.8.0。
- `manifest.json` 版本号 + `main.js` 重新构建。

---

## 三、涉及文件清单

| 类型 | 文件 |
| --- | --- |
| 新增 | `src/yuque/auth.ts`、`tests/auth.test.ts` |
| 修改 | `src/yuque/api.ts`、`src/main.ts`、`src/yuque/sync.ts`、`src/yuque/ui.ts`、`src/yuque/backfill.ts` |
| 同步适配 | `tools/probe.ts`、`tools/census.ts`、`tools/orphan-diag.ts`、`tools/replicate.ts` |
| 文档 | `README.md`、`docs/CHANGELOG.md`、`manifest.json` |

---

## 四、风险登记

| 风险 | 等级 | 应对 |
| --- | --- | --- |
| 网页端接口无契约、随时变更 | **高** | 阶段 1.5 先探明并固化样本；接口映射集中在 `api.ts` 一处，便于快速修复 |
| 私有内容触发风控 / 更严限流 | 中 | 沿用并可调低请求频率；429/403 明确提示；必要时提示"等待后再试" |
| Cookie 存储为明文敏感信息 | 中 | README 明确标注；设置页警示；不落任何第三方 |
| `ctoken` 轮换导致 403 | 中 | 403 统一归一为「重新复制 Cookie」引导 |
| 服务条款合规争议 | 中 | 免责声明；保留官方 Token 为默认模式 |
| 改造破坏现有 Token 流程 | 中 | 阶段 1 强制"行为逐字节一致"+ 现有测试全绿为门槛 |

---

## 五、工期

| 阶段 | 估时 |
| --- | --- |
| 0 合规与体验确认 | 0.5 天 |
| 1 认证抽象层 | 1–2 天 |
| 1.5 接口探针（硬前置） | 1 天 |
| 2 Cookie 模式实现 | 3–5 天 |
| 3 测试与验收 | 2 天 |
| 4 文档与发布 | 1 天 |
| **合计** | **约 8.5–11.5 天** |

**执行顺序**：`阶段 1 → 1.5 → 2 → 3 → 4`
- 阶段 1 完全无凭证依赖、无风险，可立即开工；
- 阶段 1.5 需要**你的一个真实 Cookie** 才能继续，是进入阶段 2 的门槛。

---

## 六、开工前唯一待办

- 提供一份**私有知识库账号的有效 Cookie**（浏览器 DevTools → Network → 任一语雀请求 → 复制 `Cookie` 请求头），用于阶段 1.5 探明接口契约。
  > 仅用于本地离线探针，样本会落到已 gitignore 的 `tools/.probe/`，不会提交、不会外传。
