#!/usr/bin/env node
/**
 * Analyze closed-position history from lessons.json.
 *
 * Usage:
 *   node scripts/analyze-lessons.js [options]
 *
 * Options:
 *   --last N           Only analyze the last N closes (default: all)
 *   --since YYYY-MM-DD Filter by recorded_at >= date
 *   --token SYMBOL     Filter by pool_name substring (case-insensitive)
 *   --tag TAG          Filter by close_reason_tag (e.g. take_profit, stop_loss)
 *   --json             Emit JSON instead of formatted text
 *
 * Sections in the default text report:
 *   1. Summary (count, win rate, avg/median PnL, total PnL)
 *   2. Distribution by close_reason_tag (count, win rate, avg PnL, avg hold time)
 *   3. Win-by-token (top 10 winners and losers, by aggregate PnL)
 *   4. Best / worst individual closes
 *   5. Recent vs all-time regime comparison (last 20 vs full history)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = path.join(__dirname, "..", "lessons.json");

// ─── Args ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { last: null, since: null, token: null, tag: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--last")  args.last  = parseInt(argv[++i], 10);
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--token") args.token = String(argv[++i]).toLowerCase();
    else if (a === "--tag")   args.tag   = argv[++i];
    else if (a === "--json")  args.json  = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/analyze-lessons.js [options]

Options:
  --last N           Only analyze the last N closes (default: all)
  --since YYYY-MM-DD Filter by recorded_at >= date
  --token SYMBOL     Filter by pool_name substring (case-insensitive)
  --tag TAG          Filter by close_reason_tag
  --json             Emit JSON instead of formatted text
  --help, -h         Show this help`);
}

// ─── Classifier fallback (matches lessons.js) ────────────────────
function classifyCloseReason(reasonText) {
  const t = String(reasonText || "").toLowerCase();
  if (!t) return "agent_decision";
  if (/\bstop[\s_-]?loss\b|\bsl\b/.test(t))                return "stop_loss";
  if (/\btake[\s_-]?profit\b|\btp\b/.test(t))              return "take_profit";
  if (/pumped|above range|rule 3|run.*up.*range/.test(t))  return "pumped_above_range";
  if (/dumped|below range|rule 6/.test(t))                 return "dumped_below_range";
  if (/oor.*upside|out.of.range.*up|upside/.test(t))       return "oor_upside";
  if (/oor.*downside|out.of.range.*down|downside/.test(t)) return "oor_downside";
  if (/trailing/.test(t))                                  return "trailing_tp";
  if (/oor|out.of.range|range/.test(t))                    return "oor_upside";
  if (/low.yield|fee.{0,5}tvl/.test(t))                    return "low_yield";
  if (/wash|rugpull|rug/.test(t))                          return "rug_filter";
  if (/manual|user|telegram/.test(t))                      return "manual";
  return "agent_decision";
}

// ─── Stats helpers ───────────────────────────────────────────────
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sum    = (xs) => xs.reduce((a, b) => a + b, 0);
const mean   = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pad = (s, n) => String(s).padEnd(n, " ");
const lpad = (s, n) => String(s).padStart(n, " ");
const pct = (x, dp = 1) => (x == null ? "?" : x.toFixed(dp) + "%");
const usd = (x, dp = 2) => (x == null ? "?" : "$" + x.toFixed(dp));

// ─── Group / aggregate ───────────────────────────────────────────
function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = typeof key === "function" ? key(r) : r[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

function bucketStats(rows) {
  const pnls = rows.map((r) => num(r.pnl_pct)).filter((n) => n != null);
  const usds = rows.map((r) => num(r.pnl_usd)).filter((n) => n != null);
  const fees = rows.map((r) => num(r.fees_earned_usd)).filter((n) => n != null);
  const mins = rows.map((r) => num(r.minutes_held)).filter((n) => n != null);
  const wins = pnls.filter((p) => p > 0).length;
  return {
    count: rows.length,
    winRate: pnls.length ? wins / pnls.length : 0,
    avgPnlPct:    mean(pnls),
    medianPnlPct: median(pnls),
    totalPnlUsd:  sum(usds),
    avgFeesUsd:   mean(fees),
    avgHoldMin:   mean(mins),
  };
}

// ─── Renderers ───────────────────────────────────────────────────
function fmtStatsLine(s) {
  return `${lpad(s.count, 4)}  ${lpad((s.winRate * 100).toFixed(0) + "%", 5)}  ` +
         `${lpad(pct(s.avgPnlPct, 2), 8)}  ${lpad(pct(s.medianPnlPct, 2), 8)}  ` +
         `${lpad(usd(s.totalPnlUsd, 1), 10)}  ${lpad(usd(s.avgFeesUsd, 2), 9)}  ` +
         `${lpad(s.avgHoldMin.toFixed(0) + "m", 7)}`;
}

const STATS_HEADER = "       n  win%   avg PnL%  med PnL%  total $$$  avg fees   hold";

function renderText(report) {
  const lines = [];
  lines.push("═".repeat(78));
  lines.push("  MERIDIAN — CLOSED-POSITION ANALYSIS");
  lines.push("═".repeat(78));

  // Summary
  lines.push("");
  lines.push("SUMMARY");
  lines.push("-".repeat(78));
  lines.push(`  Closes analyzed:   ${report.summary.count}`);
  if (report.filtered.appliedFilters.length) {
    lines.push(`  Filters applied:   ${report.filtered.appliedFilters.join(", ")}`);
  }
  lines.push(`  Date range:        ${report.summary.firstAt || "?"}  →  ${report.summary.lastAt || "?"}`);
  lines.push(`  Win rate:          ${(report.summary.winRate * 100).toFixed(1)}%  (${report.summary.wins}/${report.summary.count})`);
  lines.push(`  Avg PnL:           ${pct(report.summary.avgPnlPct, 2)}   median ${pct(report.summary.medianPnlPct, 2)}`);
  lines.push(`  Total PnL:         ${usd(report.summary.totalPnlUsd, 2)}`);
  lines.push(`  Total fees earned: ${usd(report.summary.totalFeesUsd, 2)}`);
  lines.push(`  Avg hold time:     ${report.summary.avgHoldMin.toFixed(0)} min`);

  // Close-reason distribution
  lines.push("");
  lines.push("BY CLOSE REASON");
  lines.push("-".repeat(78));
  lines.push("  " + pad("tag", 22) + STATS_HEADER);
  for (const [tag, s] of report.byReason) {
    lines.push("  " + pad(tag, 22) + fmtStatsLine(s));
  }

  // Top winners and losers (by token aggregate)
  lines.push("");
  lines.push("TOP WINNERS BY TOKEN (aggregate PnL)");
  lines.push("-".repeat(78));
  lines.push("  " + pad("token", 22) + STATS_HEADER);
  for (const [name, s] of report.topWinners.slice(0, 10)) {
    lines.push("  " + pad(name, 22) + fmtStatsLine(s));
  }
  lines.push("");
  lines.push("TOP LOSERS BY TOKEN (aggregate PnL)");
  lines.push("-".repeat(78));
  lines.push("  " + pad("token", 22) + STATS_HEADER);
  for (const [name, s] of report.topLosers.slice(0, 10)) {
    lines.push("  " + pad(name, 22) + fmtStatsLine(s));
  }

  // Best and worst individual closes
  lines.push("");
  lines.push("BEST CLOSES (top 5 by pnl_pct)");
  lines.push("-".repeat(78));
  for (const r of report.bestCloses) {
    lines.push(`  ${pad(r.pool_name || "?", 22)}  ${lpad(pct(num(r.pnl_pct), 2), 8)}  ` +
               `fees ${usd(num(r.fees_earned_usd), 2)}  ${lpad(((r.minutes_held ?? 0) + "m"), 6)}  ` +
               `${r.close_reason_tag || "?"}`);
  }
  lines.push("");
  lines.push("WORST CLOSES (bottom 5 by pnl_pct)");
  lines.push("-".repeat(78));
  for (const r of report.worstCloses) {
    lines.push(`  ${pad(r.pool_name || "?", 22)}  ${lpad(pct(num(r.pnl_pct), 2), 8)}  ` +
               `fees ${usd(num(r.fees_earned_usd), 2)}  ${lpad(((r.minutes_held ?? 0) + "m"), 6)}  ` +
               `${r.close_reason_tag || "?"}`);
  }

  // Regime
  lines.push("");
  lines.push("REGIME — recent N=20 vs full history");
  lines.push("-".repeat(78));
  lines.push("  " + pad("window", 22) + STATS_HEADER);
  lines.push("  " + pad("recent (last 20)", 22) + fmtStatsLine(report.regime.recent));
  lines.push("  " + pad("all-time", 22) + fmtStatsLine(report.regime.all));
  const drift = report.regime.recent.winRate - report.regime.all.winRate;
  const driftPct = drift * 100;
  const driftLine = drift >= 0.05 ? "  ✅ recent regime is favorable" :
                    drift <= -0.05 ? "  ⚠️  recent regime is hostile (consider pausing or reviewing screener)" :
                                     "  ➖ recent regime is similar to historical baseline";
  lines.push(`  Drift in win rate:   ${(driftPct >= 0 ? "+" : "") + driftPct.toFixed(1)}%`);
  lines.push(driftLine);
  lines.push("");
  lines.push("═".repeat(78));

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(LESSONS_FILE)) {
    console.error(`No ${LESSONS_FILE} found. Run the bot for a while first.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  const all = Array.isArray(raw.performance) ? raw.performance : [];

  if (!all.length) {
    console.error("lessons.json has no closed positions yet.");
    process.exit(1);
  }

  // Apply filters
  let rows = all.slice();
  const appliedFilters = [];
  if (args.since) {
    rows = rows.filter((r) => r.recorded_at && r.recorded_at >= args.since);
    appliedFilters.push(`since=${args.since}`);
  }
  if (args.token) {
    rows = rows.filter((r) => String(r.pool_name || "").toLowerCase().includes(args.token));
    appliedFilters.push(`token=${args.token}`);
  }
  if (args.tag) {
    rows = rows.filter((r) => (r.close_reason_tag || classifyCloseReason(r.close_reason)) === args.tag);
    appliedFilters.push(`tag=${args.tag}`);
  }
  if (args.last && args.last > 0) {
    rows = rows.slice(-args.last);
    appliedFilters.push(`last=${args.last}`);
  }

  if (!rows.length) {
    console.error("No closes match the given filters.");
    process.exit(1);
  }

  // Backfill tags for rows recorded before classifyCloseReason existed
  rows = rows.map((r) => r.close_reason_tag
    ? r
    : { ...r, close_reason_tag: classifyCloseReason(r.close_reason) });

  // ─── Stats ─────────────────────────────────────────────────────
  const summaryStats = bucketStats(rows);
  const wins = rows.filter((r) => num(r.pnl_pct) != null && num(r.pnl_pct) > 0).length;
  const totalFees = sum(rows.map((r) => num(r.fees_earned_usd) ?? 0));

  // By reason
  const byReasonMap = groupBy(rows, "close_reason_tag");
  const byReason = [...byReasonMap.entries()]
    .map(([tag, rs]) => [tag, bucketStats(rs)])
    .sort((a, b) => b[1].count - a[1].count);

  // By token (winners + losers)
  const byTokenMap = groupBy(rows, (r) => r.pool_name || "?");
  const byToken = [...byTokenMap.entries()]
    .map(([name, rs]) => [name, bucketStats(rs)])
    .filter(([, s]) => s.count >= 1);
  const topWinners = [...byToken].sort((a, b) => b[1].totalPnlUsd - a[1].totalPnlUsd).filter(([, s]) => s.totalPnlUsd > 0);
  const topLosers  = [...byToken].sort((a, b) => a[1].totalPnlUsd - b[1].totalPnlUsd).filter(([, s]) => s.totalPnlUsd < 0);

  // Best / worst individual closes
  const sortedByPnlPct = [...rows].sort((a, b) => (num(b.pnl_pct) ?? 0) - (num(a.pnl_pct) ?? 0));
  const bestCloses  = sortedByPnlPct.slice(0, 5);
  const worstCloses = sortedByPnlPct.slice(-5).reverse();

  // Regime: last 20 vs all
  const recentN = Math.min(20, rows.length);
  const recentStats = bucketStats(rows.slice(-recentN));
  const allStats = bucketStats(rows);

  const report = {
    summary: {
      ...summaryStats,
      wins,
      totalFeesUsd: totalFees,
      firstAt: rows[0]?.recorded_at?.slice(0, 19).replace("T", " ") || null,
      lastAt:  rows[rows.length - 1]?.recorded_at?.slice(0, 19).replace("T", " ") || null,
    },
    filtered: { appliedFilters, totalAvailable: all.length, totalAnalyzed: rows.length },
    byReason,
    topWinners,
    topLosers,
    bestCloses,
    worstCloses,
    regime: { recent: recentStats, all: allStats },
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
  }
}

main();
