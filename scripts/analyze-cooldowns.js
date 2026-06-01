#!/usr/bin/env node
/**
 * Analyze the repeat-deploy cooldown's impact on the screener, from the daily
 * log files (logs/agent-YYYY-MM-DD.log). This is the only place the screener's
 * blocked/filtered deploys are recorded — lessons.json and pool-memory.json only
 * keep positions that actually opened, and pool-memory keeps just the LATEST
 * cooldown per entry (overwritten), so historical counts must come from logs.
 *
 * Usage:
 *   node scripts/analyze-cooldowns.js [options]
 *
 * Options:
 *   --since YYYY-MM-DD   Only count log lines on/after this date
 *   --logs DIR           Log directory (default: ./logs)
 *   --json               Emit JSON instead of formatted text
 *   --help, -h           Show this help
 *
 * What it reports:
 *   1. Repeat-deploy cooldown TRIGGERS — the N-consecutive-streak filter firing
 *      (precise: isolated from "Cooldown set ... (repeat winners/losers (Nx))").
 *   2. Screener candidates FILTERED by an active cooldown (aggregate across ALL
 *      cooldown sources — repeat-deploy, OOR-streak, low-yield — the log line
 *      doesn't name the source).
 *   3. Deploy-time SKIPS where deploy_position refused because of a cooldown.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { since: null, logs: path.join(__dirname, "..", "logs"), json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--logs") args.logs = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}
function printHelp() {
  console.log(`Usage: node scripts/analyze-cooldowns.js [options]

Options:
  --since YYYY-MM-DD   Only count log lines on/after this date
  --logs DIR           Log directory (default: ./logs)
  --json               Emit JSON instead of formatted text
  --help, -h           Show this help`);
}

// [ISO_TIMESTAMP] [CATEGORY] message
const LINE_RE = /^\[([^\]]+)\]\s+\[[^\]]+\]\s+(.*)$/;

// Cooldown TRIGGERS (repeat-deploy streak only — reason names the streak)
const TRIG_POOL_RE = /Cooldown set for (.+?) until \S+ \((repeat (winners|losers) \((\d+)x\)[^)]*)\)/;
const TRIG_MINT_RE = /Base mint cooldown set for (\w+) until \S+ \((repeat (winners|losers) \((\d+)x\)[^)]*)\)/;
// Screener candidates filtered by an ACTIVE cooldown (any source)
const FILT_TOKEN_RE = /Filtered cooldown token (\S+) \((\w+)\)/;
const FILT_POOL_RE  = /Filtered cooldown pool (.+?) \((\w+)\)/;
// Deploy-time refusals
const SKIP_MINT_RE  = /Base mint (\w+) is on cooldown .* skipping deploy for pool (\w+)/;
const SKIP_POOL_RE  = /Pool (\w+) is on cooldown .* skipping/;

function inc(map, key, n = 1) { map.set(key, (map.get(key) || 0) + n); }
function topEntries(map, n = 15) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.logs)) {
    console.error(`Log directory not found: ${args.logs}`);
    process.exit(1);
  }
  const files = fs.readdirSync(args.logs)
    .filter((f) => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .filter((f) => !args.since || f.slice(6, 16) >= args.since)
    .sort();
  if (!files.length) {
    console.error(`No agent-*.log files in ${args.logs}${args.since ? ` on/after ${args.since}` : ""}.`);
    process.exit(1);
  }

  // A single repeat-deploy trigger can emit two log lines (pool + base-mint) when
  // scope="both". Collect events and dedupe by second+mode so one logical trigger
  // counts once; prefer the readable pool name (XXX-SOL) over the raw mint prefix.
  const triggerEvents = new Map(); // key: `${ts-to-second}|${mode}` → { label, mode, count, isName }
  let triggerCountSeen = null;     // the Nx observed (e.g. 3)
  const filteredByToken = new Map();   // screener candidates removed (any cooldown)
  const skipsByKey = new Map();        // deploy-time refusals (any cooldown)
  let totalFiltered = 0, totalSkips = 0;
  let firstTs = null, lastTs = null;

  for (const file of files) {
    const text = fs.readFileSync(path.join(args.logs, file), "utf8");
    for (const raw of text.split("\n")) {
      const lm = raw.match(LINE_RE);
      if (!lm) continue;
      const [, ts, msg] = lm;
      if (args.since && ts.slice(0, 10) < args.since) continue;
      if (!firstTs) firstTs = ts;
      lastTs = ts;

      let m, isName = false;
      if ((m = msg.match(TRIG_POOL_RE))) isName = true;       // pool line → readable XXX-SOL name
      else m = msg.match(TRIG_MINT_RE);                       // mint line → raw mint prefix
      if (m) {
        const mode = m[3];
        triggerCountSeen = m[4];
        const key = `${ts.slice(0, 19)}|${mode}`;
        const prev = triggerEvents.get(key);
        // Keep one event per (second, mode); upgrade label to the readable name if seen.
        if (!prev) triggerEvents.set(key, { label: m[1], mode, isName });
        else if (isName && !prev.isName) { prev.label = m[1]; prev.isName = true; }
        continue;
      }
      if ((m = msg.match(FILT_TOKEN_RE))) { totalFiltered++; inc(filteredByToken, m[1]); continue; }
      if ((m = msg.match(FILT_POOL_RE)))  { totalFiltered++; inc(filteredByToken, m[1]); continue; }
      if ((m = msg.match(SKIP_MINT_RE)))  { totalSkips++; inc(skipsByKey, `mint:${m[1]}`); continue; }
      if ((m = msg.match(SKIP_POOL_RE)))  { totalSkips++; inc(skipsByKey, `pool:${m[1]}`); continue; }
    }
  }

  // Aggregate deduped trigger events
  const triggersByToken = new Map();
  const triggersByMode  = new Map();
  for (const ev of triggerEvents.values()) {
    inc(triggersByToken, ev.label);
    inc(triggersByMode, ev.mode);
  }
  const totalTriggers = triggerEvents.size;

  const report = {
    range: { files: files.length, firstAt: firstTs, lastAt: lastTs, since: args.since || null },
    repeatDeployTriggers: {
      total: totalTriggers,
      streakLength: triggerCountSeen ? Number(triggerCountSeen) : null,
      byMode: Object.fromEntries(triggersByMode),
      byToken: Object.fromEntries(topEntries(triggersByToken)),
    },
    screenerFilteredByCooldown: { total: totalFiltered, byToken: Object.fromEntries(topEntries(filteredByToken)) },
    deployTimeSkips: { total: totalSkips, byKey: Object.fromEntries(topEntries(skipsByKey)) },
  };

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

  const L = [];
  L.push("═".repeat(78));
  L.push("  MERIDIAN — COOLDOWN IMPACT ON SCREENER");
  L.push("═".repeat(78));
  L.push("");
  L.push(`  Logs scanned:   ${report.range.files} file(s)`);
  L.push(`  Range:          ${firstTs || "?"}  →  ${lastTs || "?"}`);
  if (args.since) L.push(`  Since filter:   ${args.since}`);
  L.push("");
  L.push("1. REPEAT-DEPLOY COOLDOWN TRIGGERS (the N-consecutive-streak filter firing)");
  L.push("-".repeat(78));
  L.push(`   Total triggers:   ${totalTriggers}${report.repeatDeployTriggers.streakLength ? `  (streak length: ${report.repeatDeployTriggers.streakLength}x)` : ""}`);
  L.push(`   By mode:          ${Object.entries(report.repeatDeployTriggers.byMode).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  if (totalTriggers) {
    L.push("   By token:");
    for (const [tok, n] of topEntries(triggersByToken)) L.push(`     ${tok.padEnd(28)} ${n}`);
  }
  L.push("");
  L.push("2. SCREENER CANDIDATES FILTERED BY AN ACTIVE COOLDOWN");
  L.push("   (aggregate across ALL cooldown sources: repeat-deploy + OOR-streak + low-yield)");
  L.push("-".repeat(78));
  L.push(`   Total filtered:   ${totalFiltered}`);
  if (totalFiltered) for (const [tok, n] of topEntries(filteredByToken)) L.push(`     ${tok.padEnd(28)} ${n}`);
  L.push("");
  L.push("3. DEPLOY-TIME SKIPS (deploy_position refused due to a cooldown)");
  L.push("-".repeat(78));
  L.push(`   Total skips:      ${totalSkips}`);
  if (totalSkips) for (const [k, n] of topEntries(skipsByKey)) L.push(`     ${k.padEnd(28)} ${n}`);
  L.push("");
  L.push("  Note: only section 1 is attributable to the repeat-deploy (consecutive-streak)");
  L.push("  filter specifically. Sections 2–3 bundle every cooldown source, because the");
  L.push("  filter/skip log lines don't record which cooldown was active.");
  L.push("═".repeat(78));
  console.log(L.join("\n"));
}

main();
