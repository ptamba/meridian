# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlePct | screening | 30 |
| maxBotHoldersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| stopLossPct / takeProfitPct | management | -50 / 5 |
| trailingTriggerPct / trailingDropPct | management | 3 / 1.5 |
| trailingPeakConfirmDelayMs / Tolerance | management | 15000 / 0.85 |
| trailingDropConfirmDelayMs / TolerancePct | management | 15000 / 1.0 |
| lowYieldCooldownHours | management | 4 |
| lessonsMinEvolvePositions / MaxChangePerStep | lessons | 5 / 0.20 |
| deployRelaySlippageBps | swaps | 500 (Jupiter Ultra zap-in, 5%) |
| addLiquidityWideRangePct | swaps | 10 (Meteora wide-range, percent) |
| addLiquidityStandardBps | swaps | 1000 (Meteora standard, 10%) |
| liquidationSlippageBps | swaps | 5000 (OKX zap-out, 50% — wide on purpose) |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

The `swaps.*`, `lessons.*`, `lowYieldCooldownHours`, and `trailing*Confirm*` keys also accept env-var overrides (priority: user-config.json > env > default). See `.env.example` for the env names.

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Provider endpoint: `LLM_BASE_URL` env (default `https://openrouter.ai/api/v1`); set per-cycle model with `LLM_MODEL` env or per-role keys in user-config.json.
- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json — precedence: user-config > `LLM_MODEL` > built-in default
- Provider examples:
  - LM Studio: `LLM_BASE_URL=http://localhost:1234/v1`, `LLM_API_KEY=lm-studio`
  - DeepSeek: `LLM_BASE_URL=https://api.deepseek.com/v1`, model `deepseek-v4-flash` or `deepseek-v4-pro`
  - OpenAI: `LLM_BASE_URL=https://api.openai.com/v1`
  - MiniMax: `LLM_BASE_URL=https://api.minimax.io/v1`
- Thinking mode: `agent.js:145-148, 230-235` detects "thinking mode does not support tool_choice" errors (DeepSeek reasoner / similar) and retries the request without `tool_choice` for the rest of the run. No extra config needed.
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Known issue**: `evolveThresholds()` references `maxVolatility` and `minFeeTvlRatio` but config.js uses `minFeeActiveTvlRatio` and has no `maxVolatility` key — the evolution of these keys is a no-op

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.js`. **Opt-in**: disabled unless both `hiveMindUrl` (user-config.json) and `hiveMindApiKey` (user-config.json or `HIVEMIND_API_KEY` env) are set. `isHiveMindEnabled()` returns true only when both are non-empty; every request short-circuits to `null` otherwise. To enable, point at `https://api.agentmeridian.xyz` (or your own HiveMind-compatible server) and provide an API key.

---

## DRY_RUN Mode

`DRY_RUN=true` skips on-chain transactions — it is **not** paper trading.

- `deploy_position`, `close_position`, `claim_fees`, `swap_token` early-return `{ dry_run: true, would_*: ... }` before signing/sending. No position lands on-chain, `trackPosition()` is not called, `state.json` stays empty.
- Management cycle queries Meteora portfolio API → always returns 0 positions → TP/SL/OOR/trailing rules never evaluate in dry-run.
- Telegram notifications (`notifyDeploy`, `notifyClose`, `notifySwap`) are gated on `!result.dry_run` so no fake "✅ Deployed" alerts hit the channel (`tools/executor.js`).
- All system prompts (`prompt.js`) get a prominent DRY-RUN block injected when the flag is set: the LLM is required to label outcomes as simulations (`🧪 DRY RUN — no transaction was sent.`) and forbidden from using completion verbs/emojis like "Deployed", "Closed", "🚀", "✅".

Use dry-run for: screener tuning, prompt validation, integration testing (OKX, Helius, Telegram, HiveMind), safety-check verification. Don't use it for: validating TP/SL/trailing rules — no positions exist for those rules to evaluate. For that, deploy small live capital (default `deployAmountSol: 0.5`).

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `TELEGRAM_THREAD_ID` | No | Forum supergroup topic id — scopes inbound + outbound to that thread |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |
| `LPAGENT_API_KEY` | No | Direct LPAgent enrichment for accurate position PnL — without it, PnL falls back to Meteora's PnL API |
| `JUPITER_API_KEY` | No | Jupiter Ultra rate-limit upgrade; public tier works without it |
| `OKX_API_KEY` / `OK_ACCESS_KEY` | No | OKX OnchainOS — risk flags, bundle/sniper %, ATH price. Direct path (all 3 required keys set); falls back to Agent Meridian relay when absent |
| `OKX_SECRET_KEY` / `OK_ACCESS_SECRET` | No | OKX HMAC signing secret |
| `OKX_PASSPHRASE` / `OK_ACCESS_PASSPHRASE` | No | OKX passphrase; literal `"enter your passphrase here"` is treated as unset |
| `OKX_PROJECT_ID` / `OK_ACCESS_PROJECT` | No | OKX project id — required in practice for the OnchainOS `/api/v6/dex/market/...` endpoints. Without this header OKX returns 50114 "Invalid Authority" even with valid HMAC. |
| `OKX_MIN_INTERVAL_MS` | No | Min gap between authenticated OKX calls (default 500ms = 2 RPS). Set to 0 to disable throttle if your tier supports more |
| `LPAGENT_CACHE_TTL_MS` | No | TTL for LPAgent enrichment cache (default 30000ms). Absorbs bursts of `getMyPositions` calls without re-hitting LPAgent |
| `NODE_OPTIONS=--dns-result-order=ipv4first` | No | Set on cloud VMs with broken IPv6 routes. See README troubleshooting for the symptom (`Telegram fetch failed` every 5s) |

---

## Known Issues / Tech Debt

- `lessons.js evolveThresholds()` evolves `maxVolatility` + `minFeeTvlRatio` (wrong key names — should be `minFeeActiveTvlRatio`; `maxVolatility` doesn't exist in config at all). The evolution is a no-op for those keys.
- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
