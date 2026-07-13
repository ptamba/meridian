#!/usr/bin/env node
/**
 * backtest-filters.js — measure the net PnL impact of proposed "avoid" filters
 * against closed-position history (lessons.json), BEFORE wiring any into the
 * live screener.
 *
 * For each filter it reports:
 *   - positions it would have BLOCKED (these already passed the live screener)
 *   - losses avoided ($)      = -sum(pnl of blocked losers)      [good]
 *   - winners killed ($)      =  sum(pnl of blocked winners)     [opportunity cost]
 *   - NET impact ($)          = -sum(pnl of ALL blocked)         [ship if > 0]
 *   - stop-loss $ recovered   = -sum(pnl of blocked stop_loss rows)
 *   - funnel removed (%)      = blocked / total   (starvation risk — funnel is thin)
 *
 * A filter is worth shipping only if NET > 0 AND it doesn't gut the funnel.
 *
 * Usage:
 *   node scripts/backtest-filters.js [--file PATH] [--no-rpc] [--since YYYY-MM-DD] [--json]
 *
 *   --no-rpc   Skip the authority check (genre filter only; no network). Instant.
 *   --file     Path to lessons.json (default: ../lessons.json)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { matchGenre, checkAuthorities, GENRE_RULES } from "../tools/coin-filters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Env bootstrap (mirror cli.js) ───────────────────────────────
// The app decrypts RPC_URL from ~/.meridian/.env; a bare `node script.js`
// doesn't see it. Load it the same way so the authority check has an RPC.
async function bootstrapEnv() {
  const meridianEnv = path.join(os.homedir(), ".meridian", ".env");
  if (!fs.existsSync(meridianEnv)) return;
  try {
    const { loadEnv } = await import("../envcrypt.js");
    loadEnv({
      envPath: meridianEnv,
      keyPath: path.join(os.homedir(), ".meridian", ".envrypt"),
      override: false,
    });
  } catch (err) {
    console.error(`(env bootstrap skipped: ${err.message})`);
  }
}

function parseArgs(argv) {
  const a = { file: path.join(__dirname, "..", "lessons.json"), noRpc: false, since: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--no-rpc") a.noRpc = true;
    else if (v === "--json") a.json = true;
    else if (v === "--file") a.file = argv[++i];
    else if (v === "--since") a.since = argv[++i];
  }
  return a;
}

const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const pct = (n) => (n * 100).toFixed(1) + "%";

/** Aggregate a set of blocked rows into the report shape. */
function summarizeBlocked(rows, totalCount) {
  const losers = rows.filter((r) => r.pnl_usd < 0);
  const winners = rows.filter((r) => r.pnl_usd > 0);
  const stops = rows.filter((r) => r.close_reason_tag === "stop_loss");
  const sum = (arr) => arr.reduce((s, r) => s + (r.pnl_usd || 0), 0);
  const tokens = new Set(rows.map((r) => r.pool_name));
  return {
    blocked: rows.length,
    uniqueTokens: tokens.size,
    funnelRemovedPct: totalCount ? rows.length / totalCount : 0,
    avoidedLossUsd: -sum(losers),          // positive = good
    foregoneWinUsd: sum(winners),          // positive = cost
    netImpactUsd: -sum(rows),              // ship if > 0
    stopLossRecoveredUsd: -sum(stops),
    stopLossCount: stops.length,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.noRpc) await bootstrapEnv();

  if (!fs.existsSync(args.file)) {
    console.error(`No lessons.json at ${args.file}. Pass --file PATH (run on the VM where the data lives).`);
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(args.file, "utf8"));
  let rows = Array.isArray(doc.performance) ? doc.performance : [];
  if (args.since) rows = rows.filter((r) => (r.recorded_at || "") >= args.since);
  rows = rows.filter((r) => r.pnl_usd != null);
  const total = rows.length;

  // ── Filter 1: genre (pure, no network) ──
  const genreBlocked = [];
  const genreByCategory = {};
  for (const r of rows) {
    const hit = matchGenre(r.pool_name);
    if (hit) {
      genreBlocked.push(r);
      (genreByCategory[hit.category] ||= []).push({ name: r.pool_name, term: hit.term, pnl: r.pnl_usd });
    }
  }

  // ── Filter 2: mint/freeze authority (RPC) ──
  let authBlocked = [];
  let authNote = "skipped (--no-rpc)";
  let authErrors = 0;
  if (!args.noRpc) {
    if (!process.env.RPC_URL) {
      authNote = "skipped (no RPC_URL in env)";
    } else {
      const { Connection } = await import("@solana/web3.js");
      const conn = new Connection(process.env.RPC_URL, "confirmed");
      const mints = rows.map((r) => r.base_mint).filter(Boolean);
      const authMap = await checkAuthorities(conn, mints);
      for (const r of rows) {
        const a = authMap.get(r.base_mint);
        if (a?.error) authErrors++;
        if (a && a.revoked === false) authBlocked.push(r);
      }
      const checked = new Set(mints).size;
      authNote = `checked ${checked} unique mints (${authErrors ? authErrors + " lookup errors" : "no errors"})`;
    }
  }

  // ── Combined (union) ──
  const blockedSet = new Set([...genreBlocked, ...authBlocked]);
  const combined = [...blockedSet];

  const report = {
    totalPositions: total,
    filters: {
      genre: { ...summarizeBlocked(genreBlocked, total), byCategory: genreByCategory },
      authority: { note: authNote, ...summarizeBlocked(authBlocked, total) },
      combined: summarizeBlocked(combined, total),
    },
  };

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

  // ── Text report ──
  const line = "─".repeat(78);
  console.log("═".repeat(78));
  console.log("  BACKTEST — proposed 'avoid' filters vs closed-position history");
  console.log("═".repeat(78));
  console.log(`  Positions analyzed: ${total}${args.since ? `  (since ${args.since})` : ""}`);
  console.log(`  Genre rules: ${GENRE_RULES.map((g) => g.category).join(", ")}`);
  console.log();

  const printFilter = (label, f, extraNote) => {
    console.log(label);
    console.log(line);
    if (extraNote) console.log(`  ${extraNote}`);
    console.log(`  blocked:            ${f.blocked} positions  (${f.uniqueTokens} tokens, ${pct(f.funnelRemovedPct)} of funnel)`);
    console.log(`  losses avoided:     ${money(f.avoidedLossUsd)}   ✅`);
    console.log(`  winners killed:     ${money(f.foregoneWinUsd)}   ⬅ opportunity cost`);
    console.log(`  NET impact:         ${money(f.netImpactUsd)}   ${f.netImpactUsd > 0 ? "✅ ship" : "❌ do not ship"}`);
    console.log(`  stop-loss $ saved:  ${money(f.stopLossRecoveredUsd)}  (${f.stopLossCount} stop-loss closes)`);
    console.log();
  };

  printFilter("GENRE BLACKLIST", report.filters.genre);
  const byCat = report.filters.genre.byCategory;
  if (Object.keys(byCat).length) {
    console.log("  matched tokens by category:");
    for (const [cat, hits] of Object.entries(byCat)) {
      const totalPnl = hits.reduce((s, h) => s + h.pnl, 0);
      const names = [...new Set(hits.map((h) => h.name))].slice(0, 12).join(", ");
      console.log(`    ${cat.padEnd(12)} ${hits.length} closes  ${money(totalPnl)}  [${names}]`);
    }
    console.log();
  }

  printFilter("MINT / FREEZE AUTHORITY NOT REVOKED", report.filters.authority, report.filters.authority.note);
  printFilter("COMBINED (union, deduped)", report.filters.combined);

  console.log("NOTE: creator≠minter and dev-% filters are NOT in this run —");
  console.log("  creator≠minter needs a first-buyer source (phase 2); dev-% isn't");
  console.log("  backtestable (deploy-time holder distribution wasn't stored).");
}

main().catch((e) => { console.error(e); process.exit(1); });
