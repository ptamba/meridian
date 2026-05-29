import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Resolve a numeric config in priority order: user-config.json → env → hardcoded default.
// All three are tolerated as undefined/missing; the final value is always a finite number.
function num(userValue, envName, fallback) {
  const fromUser = numericConfig(userValue);
  if (fromUser != null) return fromUser;
  const fromEnv = numericConfig(process.env[envName]);
  if (fromEnv != null) return fromEnv;
  return fallback;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    // Asymmetric OOR — bid-ask single-side SOL has different upside vs downside dynamics:
    // upside OOR (price ran up) is often temporary — pumps can retrace into range. Wait longer.
    // downside OOR (price fell through range) usually means the strategy failed; exit faster.
    // Each key falls back to outOfRangeWaitMinutes / outOfRangeBinsToClose when unset.
    outOfRangeWaitMinutesUp:    u.outOfRangeWaitMinutesUp    ?? u.outOfRangeWaitMinutes    ?? 30,
    outOfRangeWaitMinutesDown:  u.outOfRangeWaitMinutesDown  ?? u.outOfRangeWaitMinutes    ?? 30,
    outOfRangeBinsToCloseUp:    u.outOfRangeBinsToCloseUp    ?? u.outOfRangeBinsToClose    ?? 10,
    outOfRangeBinsToCloseDown:  u.outOfRangeBinsToCloseDown  ?? u.outOfRangeBinsToClose    ?? 10,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    // Trailing TP recheck — wait this long before confirming a peak/drop,
    // and only confirm if the new sample is within the configured tolerance.
    // Priority for every value below: user-config.json → env var → hardcoded default.
    trailingPeakConfirmDelayMs:      num(u.trailingPeakConfirmDelayMs,      "TRAILING_PEAK_CONFIRM_DELAY_MS",      15_000),
    trailingPeakConfirmTolerance:    num(u.trailingPeakConfirmTolerance,    "TRAILING_PEAK_CONFIRM_TOLERANCE",     0.85),
    trailingDropConfirmDelayMs:      num(u.trailingDropConfirmDelayMs,      "TRAILING_DROP_CONFIRM_DELAY_MS",      15_000),
    trailingDropConfirmTolerancePct: num(u.trailingDropConfirmTolerancePct, "TRAILING_DROP_CONFIRM_TOLERANCE_PCT", 1.0),
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // Cooldown after a "low yield" close — distinct from the OOR / repeat-deploy cooldowns.
    lowYieldCooldownHours: num(u.lowYieldCooldownHours, "LOW_YIELD_COOLDOWN_HOURS", 4),
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Lessons / Threshold Evolution ────
  // Priority: user-config.json → env var → hardcoded default.
  lessons: {
    minEvolvePositions: num(u.lessonsMinEvolvePositions, "LESSONS_MIN_EVOLVE_POSITIONS", 5),
    maxChangePerStep:   num(u.lessonsMaxChangePerStep,   "LESSONS_MAX_CHANGE_PER_STEP",  0.20),
  },

  // ─── Swap / Slippage ──────────────────
  // All values are basis points unless suffixed with Pct.
  // Priority: user-config.json → env var → hardcoded default.
  swaps: {
    deployRelaySlippageBps:   num(u.deployRelaySlippageBps,   "DEPLOY_RELAY_SLIPPAGE_BPS",   500),   // Jupiter Ultra zap-in via relay (5%)
    addLiquidityWideRangePct: num(u.addLiquidityWideRangePct, "ADD_LIQUIDITY_WIDE_RANGE_PCT", 10),    // Meteora wide-range path takes a percentage (10%)
    addLiquidityStandardBps:  num(u.addLiquidityStandardBps,  "ADD_LIQUIDITY_STANDARD_BPS",  1000),  // Meteora standard path (10%)
    liquidationSlippageBps:   num(u.liquidationSlippageBps,   "LIQUIDATION_SLIPPAGE_BPS",    5000),  // OKX zap-out close (50%) — wide on purpose so exits don't fail on thin memecoin liquidity
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  // Opt-in: leave url + apiKey empty to keep HiveMind disabled. Set both
  // hiveMindUrl and hiveMindApiKey in user-config.json (or HIVEMIND_API_KEY
  // env) to enable telemetry sync with the HiveMind server.
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
