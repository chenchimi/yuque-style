import { Notice } from "obsidian";
import type { YuqueStylePlugin } from "../main";
import { nsPath, pickHeader, YuqueApi, YuqueRepo } from "./api";
import { describeQuota, YUQUE_QUOTA_DOCUMENTED } from "./quota";
import { describeRateLog, headerDump } from "./rate";
import type { SyncLogFn } from "./sync";
import { runWithSyncModal } from "./sync-modal";

/** 「诊断」：直接输出语雀 API 原始响应，定位拉取为空等问题。只读 data 字段，其余当 unknown */
function safeJson(text: string): { data?: unknown } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 把 429/401/403 的归因讲清楚。
 * 这一步是被现实教出来的：本仓库曾把「Token 配额用尽」误判为「免费账户权限受限」，
 * 白折腾了一大圈——所以诊断必须把「限流层」与「Token 权限」摆到台面上。
 *
 * 关于 `X-RateLimit-*`：旧版这里写死了「语雀不提供配额头」，而那行文案**从未检查过**这两个头。
 * 官方文档明确说会返回它们，实测 429 上又看不到——两者可能都对（网关层先拦，配额头就不会出现）。
 * 所以现在只如实报告「这一次到底有没有」，并把区分两个限流器的依据一起给出来。
 */
function explainStatus(
  log: SyncLogFn,
  api: YuqueApi,
  status: number,
  headers: Record<string, string>,
): void {
  if (status === 429) {
    const via = pickHeader(headers, "via");
    const retryAfter = pickHeader(headers, "retry-after");
    const limit = pickHeader(headers, "x-ratelimit-limit");
    const remaining = pickHeader(headers, "x-ratelimit-remaining");
    const reset = pickHeader(headers, "x-ratelimit-reset");
    const hasRateHeaders = !!(limit || remaining);
    log("  429 判定：语雀 API 配额已用尽（按账号/团队维度生效，不是权限问题）", "error");
    log(
      `  限流层：${via ?? "(响应头未给出 via)"}` +
        (via?.includes("[429]") ? "　← 带 [429] 表示限流发生在语雀网关层" : ""),
    );
    log(
      `  归因：${
        hasRateHeaders
          ? "带 X-RateLimit-*，来自应用层限流器（即官方记载 5000 次/小时那个）"
          : via?.includes("[429]")
            ? "无配额头且由网关吐出 → 网关层限流器（已实测确认；官方文档未记载，额度与窗口均未知）"
            : "无配额头，无法据此判断是哪一层"
      }`,
    );
    if (!hasRateHeaders) {
      // 这条纠正的是旧版写死在 UI 里的那句「语雀不提供配额头」——它从未被验证过，
      // 真相是网关先拦了、应用层还没来得及加这个头
      log(
        "  为什么没有配额头：网关在应用层之前就拦下了请求，应用层没机会加上 X-RateLimit-*。" +
          "「读不到配额头」不等于「语雀不提供」",
        "info",
      );
    }
    log(
      `  Retry-After：${retryAfter ?? "未返回"}；X-RateLimit-Limit：${limit ?? "未返回"}；` +
        `X-RateLimit-Remaining：${remaining ?? "未返回"}；X-RateLimit-Reset：${reset ?? "未返回"}`,
      "info",
    );
    log(`  配额口径：${describeQuota()}`, "info");
  } else if (status === 401) {
    log("  401 判定：Token 无效或已被重置，请到语雀「设置 → Token」重新生成", "error");
  } else if (status === 403) {
    log("  403 判定：Token 权限范围不含该资源，或该账号本身无权访问此知识库", "error");
  }
  if (api.lastRateInfo) {
    log(`  最近一次请求：${api.lastRateInfo.path} @ ${new Date(api.lastRateInfo.at).toLocaleString()}`);
  }
}

/**
 * 打印完整响应头：摘要进弹窗，全量进控制台。
 * 这是本次修复里最缺的一环——此前只挑三个头名看，「语雀不返回配额头」这个结论
 * 其实从来没有被完整验证过。要判定 429 来自应用层还是网关层，靠的就是完整头。
 */
function dumpHeaders(
  log: SyncLogFn,
  label: string,
  headers: Record<string, string> | undefined,
): void {
  const lines = headerDump(headers);
  console.log(
    `[yuque-style 诊断] ${label} 完整响应头\n${lines.length > 0 ? lines.join("\n") : "(无响应头)"}`,
  );
  const picked = ["via", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]
    .map((k) => `${k}=${pickHeader(headers, k) ?? "-"}`)
    .join("  ");
  log(`  ${picked}`);
}

export async function diagnoseFlow(plugin: YuqueStylePlugin): Promise<void> {
  if (!plugin.settings.yuqueToken) {
    new Notice("请先在插件设置中填写语雀 Token");
    return;
  }
  await runWithSyncModal(plugin, "语雀同步诊断", async (log) => {
    // 0) 配额观测：先摊开本机已经量到的事实，它决定下面每个 429 该怎么解读。
    //    这一段完全离线、不消耗任何配额，所以永远排在最前面。
    //    同时整段打进控制台——弹窗日志每写一行就滚到底，排在开头的内容很容易被挤出视野
    const rateLines = describeRateLog(plugin.settings.yuqueRateLog);
    log("—— 配额观测（本机记录，不消耗配额）——");
    for (const line of rateLines) log(`  ${line}`);
    console.log(`[yuque-style 诊断] 配额观测\n${rateLines.join("\n")}`);
    log(
      `  官方口径：${YUQUE_QUOTA_DOCUMENTED.limitPerHour} 次/小时、` +
        `${YUQUE_QUOTA_DOCUMENTED.limitPerSecond} 次/秒（个人与团队下所有 Token 共享）`,
    );

    log("—— 实时探测 ——");
    const api = plugin.createApi();
    const userRes = await api.getRaw("/user");
    const user = safeJson(userRes.text)?.data as { login?: string; name?: string } | undefined;
    const login = user?.login;
    log(`GET /user → ${userRes.status}，用户：${user?.name ?? "?"}（login: ${login ?? "?"}）`);
    dumpHeaders(log, "GET /user", userRes.headers);
    // Token 权限：被 429 拦下时语雀**仍会返回**该头，可据此直接排除「权限不足」这个误判方向
    const scopes = pickHeader(userRes.headers, "x-oauth-scopes");
    log(
      scopes
        ? `Token 权限范围：${scopes}`
        : "Token 权限范围：未返回（请求可能在鉴权前就被网关拦下）",
    );
    if (userRes.status !== 200) {
      explainStatus(log, api, userRes.status, userRes.headers);
      log(`  响应：${userRes.text.slice(0, 200)}`, "error");
      return;
    }

    const reposRes = await api.getRaw(
      `/users/${encodeURIComponent(String(login))}/repos?offset=0&limit=100`,
    );
    const reposData = safeJson(reposRes.text)?.data;
    const repos: YuqueRepo[] = Array.isArray(reposData) ? reposData : [];
    log(`GET /users/${login}/repos → ${reposRes.status}，${repos.length} 个知识库`);
    dumpHeaders(log, "GET /users/:login/repos", reposRes.headers);
    if (reposRes.status === 429) {
      // 配额耗尽时后面的探测必然全 429，继续刷屏没有信息量
      explainStatus(log, api, 429, reposRes.headers);
      return;
    }
    for (const r of repos.slice(0, 30)) {
      log(`  · ${r.name}（namespace: ${r.namespace}，id: ${r.id}）`);
    }

    const tasks = plugin.settings.yuqueTasks || [];
    if (tasks.length === 0) {
      log("没有同步任务，仅列出知识库信息。可在上方 namespace 中选一个手动诊断", "info");
    }
    for (const task of tasks) {
      const probes: [string, string][] = [
        ["目录 by namespace", `/repos/${nsPath(task.namespace)}/toc`],
        ["目录 by id", `/repos/${task.repoId}/toc`],
        ["文档列表 by namespace", `/repos/${nsPath(task.namespace)}/docs?offset=0&limit=100`],
        ["文档列表 by id", `/repos/${task.repoId}/docs?offset=0&limit=100`],
      ];
      for (const [label, path] of probes) {
        const r = await api.getRaw(path);
        const data = safeJson(r.text)?.data;
        const count = Array.isArray(data) ? `${data.length} 项` : `非数组（${data === null ? "null" : typeof data}）`;
        log(`「${task.repoName}」${label} → ${r.status}，${count}`);
        dumpHeaders(log, `${label} ${path}`, r.headers);
        console.log(`[yuque-style 诊断] ${label} ${path}\n  status=${r.status}\n  ${r.text.slice(0, 3000)}`);
        if (r.status === 429) {
          explainStatus(log, api, 429, r.headers);
          return;
        }
        if (r.status !== 200) log(`  响应：${r.text.slice(0, 200)}`, "error");
      }
    }
    log("—— 完整响应头与响应体已打印到控制台（Ctrl+Shift+I → Console）——");
  });
}
