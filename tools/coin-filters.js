/**
 * coin-filters.js — deterministic "avoid this coin" filters for SOL-sided DLMM.
 *
 * These encode the manual screening heuristics that the live screener does NOT
 * currently enforce (genre/narrative faces, unrevoked mint/freeze authority,
 * creator≠minter). Every filter is a PURE (or single-network-call) function that
 * returns a block-reason string or null, so the SAME code backs both:
 *   - scripts/backtest-filters.js  (measure net PnL impact against history)
 *   - the live screener            (once a filter proves net-positive)
 *
 * A filter returning a non-null string means "avoid / do not deploy".
 */

// ─── 1. Genre / narrative blacklist ──────────────────────────────
// Slow-rug-prone genres from the manual method: political faces, celebrities,
// "justice for X", dev/insider-hype coins. Keyword lists are intentionally
// conservative — expand as history reveals misses. Word-boundary matched to
// avoid substring false positives (e.g. "ELON" inside "MELON").
export const GENRE_RULES = [
  {
    category: "political",
    terms: ["trump", "maga", "elon", "musk", "baron", "biden", "obama",
            "kamala", "harris", "vance", "potus", "putin", "xi", "milei"],
  },
  {
    category: "celebrity",
    terms: ["kanye", "\\bye\\b", "kardashian", "taylor swift", "drake",
            "ronaldo", "messi", "mrbeast", "elonjet"],
  },
  {
    category: "justice-for",
    terms: ["justice ?for", "\\bjfr\\b", "\\brip ", "^rip", " rip$"],
  },
];

/**
 * matchGenre(name) → { category, term } | null
 * @param {string} name  pool/token name, e.g. "DR TRUMP-SOL"
 */
export function matchGenre(name) {
  if (!name || typeof name !== "string") return null;
  // Strip the "-SOL" / "-USDC" quote suffix so we only test the base token.
  const base = name.replace(/-(SOL|USDC|WSOL|USDT)$/i, "").toLowerCase().trim();
  for (const rule of GENRE_RULES) {
    for (const term of rule.terms) {
      // Terms already containing regex anchors/boundaries are used as-is;
      // plain words get word-boundary wrapped.
      const pattern = /[\\^$]/.test(term) ? term : `\\b${term}\\b`;
      let re;
      try { re = new RegExp(pattern, "i"); } catch { continue; }
      if (re.test(base)) return { category: rule.category, term };
    }
  }
  return null;
}

// ─── 2. Mint / freeze authority not revoked ──────────────────────
/**
 * checkAuthorities(connection, mints) → Map<mint, {mintAuthority, freezeAuthority, revoked, reason}>
 * A live mint authority = infinite-dilution risk; a live freeze authority = the
 * token can freeze the account holding the bag you bought on the way down.
 * Uses getMultipleParsedAccounts in batches of 100. `revoked` = both are null.
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string[]} mints  base-token mint addresses
 */
export async function checkAuthorities(connection, mints) {
  const { PublicKey } = await import("@solana/web3.js");
  const out = new Map();
  const unique = [...new Set(mints.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    let infos;
    try {
      const keys = chunk.map((m) => new PublicKey(m));
      const res = await connection.getMultipleParsedAccounts(keys, { commitment: "confirmed" });
      infos = res.value;
    } catch (err) {
      for (const m of chunk) out.set(m, { error: err.message, revoked: null, reason: null });
      continue;
    }
    chunk.forEach((mint, idx) => {
      const parsed = infos[idx]?.data?.parsed?.info;
      if (!parsed) { out.set(mint, { revoked: null, reason: null, error: "no-parse" }); return; }
      const mintAuthority = parsed.mintAuthority ?? null;
      const freezeAuthority = parsed.freezeAuthority ?? null;
      const revoked = mintAuthority == null && freezeAuthority == null;
      const flags = [];
      if (mintAuthority) flags.push("mint-authority-live");
      if (freezeAuthority) flags.push("freeze-authority-live");
      out.set(mint, {
        mintAuthority, freezeAuthority, revoked,
        reason: revoked ? null : flags.join("+"),
      });
    });
  }
  return out;
}

// ─── 3. Creator ≠ minter (pumpfun offchain) ──────────────────────
// PHASE 2 — needs pumpfun/Helius first-buyer lookup that isn't reliably
// available for older mints. Scaffolded so the harness is complete; returns a
// "skipped" marker until a data source is wired in.
export function checkCreatorMinter(/* mint */) {
  return { status: "skipped", reason: null, note: "needs Helius DAS / pumpfun first-buyer source" };
}
