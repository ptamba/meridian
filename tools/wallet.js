import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || "";
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    // No enhanced Wallet API available — compose from RPC instead of failing.
    return getWalletBalancesViaRpc(walletAddress);
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    // Wallet API down/throttled (e.g. 429 on an exhausted HELIUS_API_KEY) — fall back to
    // RPC composition so callers still get SOL + token list off the (separate) RPC_URL key.
    log("wallet_warn", `Wallet API failed (${error.message}) — composing balances from RPC`);
    return getWalletBalancesViaRpc(walletAddress);
  }
}

/**
 * Batch USD prices by mint via Jupiter Price API v3 (free, not Helius). Returns a
 * { mint: priceUsd } map; missing/failed lookups are simply absent (best-effort).
 */
async function fetchUsdPrices(mints) {
  const ids = [...new Set(mints.filter(Boolean))];
  if (ids.length === 0) return {};
  try {
    const apiKey = getJupiterApiKey();
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${ids.join(",")}`, {
      headers: apiKey ? { "x-api-key": apiKey } : {},
    });
    if (!res.ok) return {};
    const data = await res.json();
    const map = data?.data ?? data; // v3 is a flat { mint: {...} }; tolerate a {data} wrapper
    const out = {};
    for (const [mint, info] of Object.entries(map || {})) {
      const p = info?.usdPrice ?? info?.price;
      if (p != null && Number.isFinite(Number(p))) out[mint] = Number(p);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Fallback wallet balances composed entirely from RPC_URL primitives — used when the
 * Helius enhanced Wallet API is unavailable or throttled. Returns the same shape as
 * getWalletBalances(): SOL via getBalance, token list via getParsedTokenAccountsByOwner,
 * USD via Jupiter (best-effort; usd is null for any mint Jupiter doesn't price).
 *
 * This removes the enhanced Wallet API as a hard dependency: /wallet, the LLM context,
 * and the orphan sweep all keep working off the healthy RPC key when Helius is capped.
 */
async function getWalletBalancesViaRpc(walletAddress) {
  try {
    const conn = getConnection();
    const owner = getWallet().publicKey;
    const SOL = config.tokens.SOL;

    const lamports = await conn.getBalance(owner, "confirmed");
    const sol = lamports / LAMPORTS_PER_SOL;

    const raw = [];
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
      for (const { account } of res.value) {
        const info = account.data?.parsed?.info;
        const bal = info?.tokenAmount?.uiAmount ?? 0;
        if (info?.mint && bal > 0) raw.push({ mint: info.mint, balance: bal });
      }
    }

    const prices = await fetchUsdPrices([SOL, ...raw.map((t) => t.mint)]);
    const solPrice = prices[SOL] ?? 0;
    const solUsd = sol * solPrice;

    const tokens = raw.map((t) => {
      const price = prices[t.mint];
      return {
        mint: t.mint,
        symbol: t.mint.slice(0, 8),
        balance: t.balance,
        usd: price != null ? Math.round(t.balance * price * 100) / 100 : null,
      };
    });

    const usdcEntry = tokens.find((t) => t.mint === config.tokens.USDC);
    const tokenUsd = tokens.reduce((s, t) => s + (t.usd || 0), 0);

    return {
      wallet: walletAddress,
      sol: Math.round(sol * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: usdcEntry ? Math.round(usdcEntry.balance * 100) / 100 : 0,
      tokens,
      total_usd: Math.round((solUsd + tokenUsd) * 100) / 100,
      source: "rpc-fallback",
    };
  } catch (error) {
    log("wallet_error", `RPC balance fallback failed: ${error.message}`);
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: error.message };
  }
}

/**
 * Cheap SOL-only balance via the RPC `getBalance` method (~1 credit) instead of
 * the 100-credit Helius Wallet API. Use this when a caller only needs native SOL
 * (deploy sizing, gas-reserve safety check) and not the full token list / USD values.
 *
 * On error returns 0 — the safe direction: it under-states SOL, so deploy sizing
 * floors out and the gas-reserve safety check blocks rather than over-deploys.
 */
export async function getSolBalance() {
  try {
    const lamports = await getConnection().getBalance(getWallet().publicKey, "confirmed");
    return lamports / LAMPORTS_PER_SOL;
  } catch (error) {
    log("wallet_error", `getSolBalance failed: ${error.message}`);
    return 0;
  }
}

// SPL token programs — hardcoded to avoid pulling in @solana/spl-token as a dep.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/**
 * Cheap RPC enumeration of SPL mints the wallet holds with a non-zero balance, via
 * `getParsedTokenAccountsByOwner` (standard RPC — far cheaper than the 100-credit Helius
 * Wallet API). Used as a pre-check so the orphan sweep only pays for the full USD-priced
 * scan on the rare cycle that actually has a token to consider.
 *
 * Returns a Set of mint strings, or null on error — callers should treat null as
 * "unknown, fall back to the full scan" so a transient RPC error never silently
 * disables sweeping.
 */
export async function getHeldTokenMints() {
  try {
    const owner = getWallet().publicKey;
    const conn = getConnection();
    const mints = new Set();
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
      for (const { account } of res.value) {
        const info = account.data?.parsed?.info;
        if (info?.mint && (info.tokenAmount?.uiAmount ?? 0) > 0) mints.add(info.mint);
      }
    }
    return mints;
  } catch (error) {
    log("wallet_error", `getHeldTokenMints failed: ${error.message}`);
    return null;
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  // Refuse a no-op same-mint swap (e.g. SOL → SOL). Jupiter would reject it anyway,
  // but guard here so callers can't accidentally route a balance into itself.
  if (input_mint && input_mint === output_mint) {
    log("swap_warn", `Refusing same-mint swap (${input_mint})`);
    return { success: false, skipped: true, error: "input and output mint are identical — nothing to swap" };
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
