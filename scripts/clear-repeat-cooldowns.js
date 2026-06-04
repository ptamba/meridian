#!/usr/bin/env node
/**
 * Clear repeat-deploy (rotate-winners / cut-losers) cooldowns from pool-memory.json.
 *
 * Why: flipping repeatDeployCooldownMode is NOT retroactive — cooldown windows
 * already written under the old mode persist for up to repeatDeployCooldownHours
 * (default 12h). This drains those stale repeat-deploy cooldowns so the new mode
 * takes effect immediately, WITHOUT touching low-yield or OOR cooldowns.
 *
 * Match: cooldown_reason / base_mint_cooldown_reason matching /repeat (winners|
 * losers)/i. Deliberately does NOT match "repeated OOR closes (3x)" or "low yield".
 *
 * Usage:
 *   node scripts/clear-repeat-cooldowns.js            # dry run — preview only
 *   node scripts/clear-repeat-cooldowns.js --apply     # write (backs up to .bak)
 *   node scripts/clear-repeat-cooldowns.js --file PATH
 *
 * Idempotent and safe to re-run. The bot may re-save pool-memory.json on a close;
 * since the mode is now flipped, such a close won't recreate a winners cooldown,
 * but if a close lands mid-run just re-run this to be sure.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repeat-DEPLOY cooldown reasons across code versions:
//   "repeat winners (3x) — rotate-winners mode"
//   "repeat losers (3x) — cut-losers mode"
//   "repeat fee-generating deploys (3x)"   (legacy wording for the winners streak)
// The leading "repeat\s+" (whitespace required) deliberately does NOT match the OOR
// reason "repeated OOR closes (3x)" (no space after "repeat") or "low yield".
const REPEAT_DEPLOY_RE = /repeat\s+(winners|losers|fee-generating)/i;

function parseArgs(argv) {
  const args = { apply: false, file: path.join(__dirname, "..", "pool-memory.json") };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/clear-repeat-cooldowns.js [--apply] [--file PATH]");
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.file)) {
    console.error(`pool-memory file not found: ${args.file}`);
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(args.file, "utf8"));
  const nowMs = Date.now();
  const cleared = [];

  for (const [addr, entry] of Object.entries(db)) {
    if (!entry || typeof entry !== "object") continue;
    const label = entry.name || `${addr.slice(0, 8)}…`;

    if (entry.cooldown_until && REPEAT_DEPLOY_RE.test(entry.cooldown_reason || "")) {
      cleared.push({ label, kind: "pool", until: entry.cooldown_until, reason: entry.cooldown_reason, active: new Date(entry.cooldown_until).getTime() > nowMs });
      delete entry.cooldown_until;
      delete entry.cooldown_reason;
    }
    if (entry.base_mint_cooldown_until && REPEAT_DEPLOY_RE.test(entry.base_mint_cooldown_reason || "")) {
      cleared.push({ label, kind: "base_mint", until: entry.base_mint_cooldown_until, reason: entry.base_mint_cooldown_reason, active: new Date(entry.base_mint_cooldown_until).getTime() > nowMs });
      delete entry.base_mint_cooldown_until;
      delete entry.base_mint_cooldown_reason;
    }
  }

  const activeCount = cleared.filter((c) => c.active).length;
  console.log(`Repeat-deploy cooldowns matched: ${cleared.length}  (${activeCount} currently active, ${cleared.length - activeCount} already expired)`);
  for (const c of cleared) {
    console.log(`  ${(c.active ? "ACTIVE " : "expired")}  ${c.label.padEnd(20)} ${c.kind.padEnd(9)} until ${c.until}  "${c.reason}"`);
  }
  // Sanity: report what we deliberately KEPT (active status shown), so it's obvious
  // OOR/low-yield survive — and so a stray active keep can't hide unnoticed.
  const kept = [];
  for (const [addr, entry] of Object.entries(db)) {
    if (!entry || typeof entry !== "object") continue;
    const label = entry.name || addr.slice(0, 8);
    if (entry.cooldown_until) kept.push({ label, kind: "pool", until: entry.cooldown_until, reason: entry.cooldown_reason, active: new Date(entry.cooldown_until).getTime() > nowMs });
    if (entry.base_mint_cooldown_until) kept.push({ label, kind: "base_mint", until: entry.base_mint_cooldown_until, reason: entry.base_mint_cooldown_reason, active: new Date(entry.base_mint_cooldown_until).getTime() > nowMs });
  }
  if (kept.length) {
    console.log(`\nKept (non-repeat-deploy) cooldowns: ${kept.length}  (${kept.filter((k) => k.active).length} active)`);
    for (const k of kept) console.log(`  ${(k.active ? "ACTIVE " : "expired")}  ${k.label.padEnd(20)} ${k.kind.padEnd(9)} "${k.reason}"`);
  }

  if (!cleared.length) {
    console.log("\nNothing to clear.");
    return;
  }
  if (!args.apply) {
    console.log("\nDRY RUN — no file written. Re-run with --apply to clear the above.");
    return;
  }
  fs.copyFileSync(args.file, args.file + ".bak");
  fs.writeFileSync(args.file, JSON.stringify(db, null, 2));
  console.log(`\nApplied. ${cleared.length} cooldown field-set(s) cleared. Backup: ${args.file}.bak`);
}

main();
