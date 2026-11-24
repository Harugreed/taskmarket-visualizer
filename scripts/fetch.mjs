// Taskmarket Visualizer — server-side data fetcher.
// Runs in GitHub Actions (hourly) and locally: `node scripts/fetch.mjs`
// Fetches api.taskmarket.dev (which does not allow browser CORS), computes
// derived views (distinct posters per week, money flow, concentration,
// lifecycle) and writes static JSON into ./data/ for the static page.
// No numbers are invented: every figure comes from the API responses below.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.taskmarket.dev";
const CHAINS = [4217, 8453]; // Tempo, Base
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
mkdirSync(OUT, { recursive: true });

const ENDPOINTS_USED = [
  "/api/market/stats?chainId=…",
  "/api/stats/breakdowns?chainId=…",
  "/api/stats/platform-time-series?chainId=…&range=7d|30d|90d|all&bucket=day|week",
  "/api/stats/activity-heatmap?chainId=…&range=30d&dimension=hourOfWeek|mode",
  "/api/stats/activity-feed?chainId=…&limit=50",
  "/api/tasks?chainId=…&sort=newest&limit=100&cursor=…",
];

async function getJSON(path, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { "user-agent": "taskmarket-visualizer/1.0 (+https://taskmarket.dev)", accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

const write = (name, obj) => {
  writeFileSync(join(OUT, name), JSON.stringify(obj, null, 1) + "\n");
  console.log("wrote", name);
};

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// Reward amounts are reported by the API in micro-units (1 USDC = 1,000,000).
// Keep raw strings in the JSON; the page divides by 1e6 and labels the unit.
const sumMicro = (rows, key) => rows.reduce((a, r) => a + toNum(r[key]), 0);

function mondayOf(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

const fetchedAt = new Date().toISOString();
const failures = [];

// ---- per-chain fetches ----
const perChain = {};
for (const chain of CHAINS) {
  const c = {};
  try {
    c.market = await getJSON(`/api/market/stats?chainId=${chain}`);
  } catch (e) { failures.push(`market/${chain}: ${e.message}`); c.market = null; }
  try {
    c.breakdowns = await getJSON(`/api/stats/breakdowns?chainId=${chain}`);
  } catch (e) { failures.push(`breakdowns/${chain}: ${e.message}`); c.breakdowns = null; }
  c.timeseries = {};
  for (const [range, bucket] of [["7d", "day"], ["30d", "day"], ["90d", "day"], ["all", "week"]]) {
    try {
      c.timeseries[range] = await getJSON(`/api/stats/platform-time-series?chainId=${chain}&range=${range}&bucket=${bucket}`);
    } catch (e) { failures.push(`timeseries/${chain}/${range}: ${e.message}`); c.timeseries[range] = []; }
  }
  c.heatmap = {};
  for (const dim of ["hourOfWeek", "mode"]) {
    try {
      c.heatmap[dim] = await getJSON(`/api/stats/activity-heatmap?chainId=${chain}&range=30d&dimension=${dim}`);
    } catch (e) { failures.push(`heatmap/${chain}/${dim}: ${e.message}`); c.heatmap[dim] = null; }
  }
  try {
    c.feed = await getJSON(`/api/stats/activity-feed?chainId=${chain}&limit=50`);
  } catch (e) { failures.push(`feed/${chain}: ${e.message}`); c.feed = { items: [] }; }
  perChain[chain] = c;
  write(`chain-${chain}.json`, { chainId: chain, fetchedAt, ...c });
}

// ---- task list pagination (both chains, all statuses) ----
const seenIds = new Map(); // id -> compact task (dedupe across chains)
const perChainTasks = {};
for (const chain of CHAINS) {
  const list = [];
  let cursor = null;
  let pages = 0;
  try {
    for (;;) {
      pages++;
      if (pages > 60) break;
      const q = `/api/tasks?chainId=${chain}&sort=newest&limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const page = await getJSON(q);
      for (const t of page.tasks || []) {
        const compact = {
          id: t.id, chainId: t.chainId, ref: t.referenceCode || null,
          requester: t.requester || null, requesterName: t.requesterDisplayName || null,
          createdAt: t.createdAt || null, expiryTime: t.expiryTime || null,
          status: t.status || null, mode: t.mode || null,
          reward: t.reward ?? null, submissions: toNum(t.submissionCount),
          awards: toNum(t.awardCount), claimedBy: t.claimedBy || null,
        };
        list.push(compact);
        if (!seenIds.has(t.id)) seenIds.set(t.id, compact);
      }
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
  } catch (e) {
    failures.push(`tasks/${chain}: ${e.message} (after ${pages} pages, ${list.length} tasks)`);
  }
  perChainTasks[chain] = list;
  console.log(`chain ${chain}: ${list.length} tasks, ${pages} pages`);
}
const tasks = [...seenIds.values()];
write("tasks-compact.json", { fetchedAt, count: tasks.length, tasks });

// ---- derived: distinct posters per week (from the task list) ----
function postersWeekly(taskList) {
  const byWeek = new Map(); // week -> {posters:Set, tasks:n}
  for (const t of taskList) {
    if (!t.createdAt || !t.requester) continue;
    const w = mondayOf(t.createdAt);
    if (!byWeek.has(w)) byWeek.set(w, { posters: new Set(), tasks: 0 });
    const e = byWeek.get(w);
    e.posters.add(t.requester.toLowerCase());
    e.tasks++;
  }
  return [...byWeek.entries()].sort().map(([week, e]) => ({
    week, distinctPosters: e.posters.size, tasks: e.tasks,
  }));
}
write("posters-weekly.json", {
  fetchedAt,
  combined: postersWeekly(tasks),
  tempo: postersWeekly(perChainTasks[4217]),
  base: postersWeekly(perChainTasks[8453]),
  method: "Distinct requester wallet addresses grouped by ISO week (Monday) of task createdAt, from paginated /api/tasks for both chains, deduplicated by task id.",
});

// ---- derived: money flow + concentration + lifecycle ----
// NOTE (verified 2026-11-24): /api/stats/platform-time-series and
// /api/stats/breakdowns return IDENTICAL data for chainId=4217 and 8453 —
// they are platform-wide, not per-chain. Summing both chains would
// double-count, so money-flow totals use ONE chain's series and the page
// labels these views "platform-wide". Market stats, heatmaps, feeds and
// the /api/tasks lists genuinely differ per chain.
const seriesIdentical =
  JSON.stringify(perChain[4217].timeseries) === JSON.stringify(perChain[8453].timeseries);
const allSeries = perChain[8453].timeseries.all || [];
const putUpMicro = sumMicro(allSeries, "rewardVolume");
const paidMicro = sumMicro(allSeries, "paidVolume");
const completedTotal = allSeries.reduce((a, r) => a + toNum(r.completedTasks), 0);
const tasksCreatedTotal = allSeries.reduce((a, r) => a + toNum(r.tasksCreated), 0);
const settlementsTotal = allSeries.reduce((a, r) => a + toNum(r.settlements), 0);

// Open escrow = sum of rewards of currently-open tasks (deduped list).
const openTasks = tasks.filter((t) => t.status === "open");
const openEscrowMicro = openTasks.reduce((a, t) => a + toNum(t.reward), 0);
const openByChain = {
  4217: perChainTasks[4217].filter((t) => t.status === "open").reduce((a, t) => a + toNum(t.reward), 0),
  8453: perChainTasks[8453].filter((t) => t.status === "open").reduce((a, t) => a + toNum(t.reward), 0),
};

const statusCounts = {};
const modeCounts = {};
for (const t of tasks) {
  statusCounts[t.status || "unknown"] = (statusCounts[t.status || "unknown"] || 0) + 1;
  modeCounts[t.mode || "unknown"] = (modeCounts[t.mode || "unknown"] || 0) + 1;
}
const died = (statusCounts.cancelled || 0) + (statusCounts.expired || 0);
const decided = (statusCounts.completed || 0) + died;

const posterCounts = new Map();
for (const t of tasks) {
  if (!t.requester) continue;
  const k = t.requester.toLowerCase();
  const e = posterCounts.get(k) || { count: 0, name: t.requesterName };
  e.count++;
  if (!e.name && t.requesterName) e.name = t.requesterName;
  posterCounts.set(k, e);
}
const topPosters = [...posterCounts.entries()]
  .map(([wallet, e]) => ({ wallet, name: e.name || null, tasks: e.count }))
  .sort((a, b) => b.tasks - a.tasks)
  .slice(0, 10);
const top1Share = tasks.length ? topPosters[0].tasks / tasks.length : 0;
const top5Share = tasks.length ? topPosters.slice(0, 5).reduce((a, p) => a + p.tasks, 0) / tasks.length : 0;

const submissionsTotal = tasks.reduce((a, t) => a + t.submissions, 0);
write("derived.json", {
  fetchedAt,
  seriesIdenticalAcrossChains: seriesIdentical,
  moneyFlow: {
    putUpMicro, paidMicro, openEscrowMicro, openByChain,
    completedTasks: completedTotal, tasksCreated: tasksCreatedTotal, settlements: settlementsTotal,
    openTaskCount: openTasks.length,
    // Remainder (put up minus paid minus still-open) is mostly rewards on
    // cancelled/expired tasks returning to posters; shown as "released back".
    releasedBackMicro: Math.max(0, putUpMicro - paidMicro - openEscrowMicro),
    unit: "micro-units as reported by the API (1 USDC = 1,000,000); some tasks pay in other tokens, see Methods.",
  },
  lifecycle: {
    statusCounts, modeCounts, died, decided,
    diedShare: tasks.length ? died / tasks.length : 0,
    completionShareOfDecided: decided ? (statusCounts.completed || 0) / decided : 0,
    totalTasks: tasks.length,
  },
  concentration: {
    distinctPosters: posterCounts.size, top1Share, top5Share, topPosters,
    avgSubmissionsPerTask: tasks.length ? submissionsTotal / tasks.length : 0,
    submissionsTotal,
  },
});

write("meta.json", {
  fetchedAt, endpoints: ENDPOINTS_USED, chains: CHAINS,
  taskCount: tasks.length, failures,
  note: "All figures are fetched server-side from api.taskmarket.dev. Amounts are in micro-units as reported (÷1,000,000 = USDC for USDC tasks). VERIFIED: /api/stats/platform-time-series and /api/stats/breakdowns return identical data for chainId=4217 and 8453, i.e. they are platform-wide; totals use one chain's series to avoid double-counting. Market stats, heatmaps, feeds and /api/tasks lists differ per chain.",
});

if (failures.length) {
  console.error("FAILURES:", failures.join(" | "));
  process.exitCode = 1;
} else {
  console.log("OK — all endpoints fetched.");
}
