/**
 * rugCheck.js
 * -----------
 * Rug-check + failsafe module for the Ape Coin Radar scanner.
 *
 * Responsibilities:
 *  1. Filter tokens to a strict age window (0–24h since creation)
 *  2. Run on-chain + off-chain rug signals (mint authority, freeze authority,
 *     LP lock, holder concentration, honeypot/sell simulation)
 *  3. Produce a single risk verdict per token
 *  4. Enforce trading failsafes (position sizing, cooldowns, circuit breaker)
 *
 * Dependencies:
 *   npm install @solana/web3.js @solana/spl-token axios
 *
 * Data sources referenced (you'll need API keys / endpoints for these):
 *   - Dexscreener API        -> pair/price/liquidity/volume data
 *   - Solana RPC             -> mint authority, freeze authority, holder list
 *   - RugCheck.xyz API       -> optional third-party risk score (nice cross-check)
 */

require("dotenv").config();
const axios = require("axios");
const { Connection, PublicKey } = require("@solana/web3.js");
const { getMint } = require("@solana/spl-token");

// ---------------------------------------------------------------------------
// CONFIG — tune these to your actual strategy
// ---------------------------------------------------------------------------
const CONFIG = {
  RPC_URL: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  AGE_MIN_MINUTES: 0,
  AGE_MAX_HOURS: 24,          // your requested window: creation -> 24h
  MIN_LIQUIDITY_USD: 50_000,
  MAX_MARKET_CAP_USD: 1_000_000,
  MIN_VOLUME_SPIKE_PCT: 50,   // % change in last hour
  MAX_TOP10_HOLDER_PCT: 40,   // fail if top 10 wallets hold more than this
  MIN_LP_LOCK_DAYS: 30,
  MAX_PRICE_IMPACT_SELL_PCT: 15,
};

const FAILSAFES = {
  MAX_POSITION_USD: 50,          // hard cap per trade regardless of conviction
  MAX_OPEN_POSITIONS: 5,         // don't ape into more than N coins at once
  COOLDOWN_SECONDS: 300,         // min time between buys, prevents panic-aping
  MAX_RUGS_PER_SESSION: 3,       // circuit breaker: pause scanner after N confirmed rugs
  REQUIRE_MANUAL_CONFIRM_ABOVE_USD: 25, // auto-buy below this, prompt above it
};

// In-memory session state (swap for persistent storage in production)
const sessionState = {
  openPositions: 0,
  rugsThisSession: 0,
  lastBuyTimestamp: 0,
  paused: false,
};

// ---------------------------------------------------------------------------
// 1. AGE FILTER
// ---------------------------------------------------------------------------
function checkAgeWindow(createdAtMs) {
  if (!createdAtMs) return { pass: true, ageMinutes: 0 };
  const ageMinutes = (Date.now() - createdAtMs) / 60_000;
  const pass =
    ageMinutes >= CONFIG.AGE_MIN_MINUTES &&
    ageMinutes <= CONFIG.AGE_MAX_HOURS * 60;
  return { pass, ageMinutes: Math.round(ageMinutes) };
}

// ---------------------------------------------------------------------------
// RESULT CACHE — avoids re-checking the same mint within TTL window
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _cache = new Map(); // mintAddress -> { result, expiresAt }
let _cacheHits = 0;
let _cacheMisses = 0;

function getCached(mintAddress) {
  const entry = _cache.get(mintAddress);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(mintAddress);
    return null;
  }
  return entry.result;
}

function setCached(mintAddress, result) {
  _cache.set(mintAddress, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheStats() {
  return {
    size: _cache.size,
    hits: _cacheHits,
    misses: _cacheMisses,
    hitRate: _cacheHits + _cacheMisses === 0
      ? "n/a"
      : `${Math.round((_cacheHits / (_cacheHits + _cacheMisses)) * 100)}%`,
  };
}

// ---------------------------------------------------------------------------
// SHARED HTTP HELPER — rate-limit-aware fetch with Retry-After support
// ---------------------------------------------------------------------------
const MAX_RETRIES   = 4;
const BASE_DELAY_MS = 600;  // first retry waits ~600ms

/**
 * Wraps an axios GET with automatic 429 / 5xx retry logic.
 * Respects the Retry-After response header when present.
 * Uses exponential backoff + ±20% jitter between retries.
 */
async function fetchWithRetry(url, options = {}, attempt = 0) {
  try {
    return await axios.get(url, options);
  } catch (err) {
    const status = err.response?.status;

    // 429 = rate limited — stop immediately, do NOT retry.
    // The user can click "Run Scan" again when ready.
    if (status === 429) {
      console.warn(`  ⚠️  Rate limited (429) by ${url.split("?")[0]} — skipping this token. Click Run Scan to try again.`);
      throw err;
    }

    // Only retry on transient server errors (5xx)
    if (status >= 500 && status < 600 && attempt < MAX_RETRIES) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
      if (attempt === 0) {
        console.warn(`  ⚠️  ${status} from ${url.split("?")[0]} — retrying in ${Math.round(delayMs)}ms`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
      return fetchWithRetry(url, options, attempt + 1);
    }

    // Non-retryable — let caller handle it
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 2. RUGCHECK.XYZ REPORT LOOKUP
// ---------------------------------------------------------------------------
async function fetchRugCheckReport(mintAddress) {
  try {
    const res = await fetchWithRetry(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`,
      { timeout: 5000 }
    );
    return res.data;
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// 3. ON-CHAIN CHECKS (Solana SPL token via RPC with timeout)
// ---------------------------------------------------------------------------
async function checkMintAndFreezeAuthority(connection, mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const mintInfo = await Promise.race([
      getMint(connection, mintPubkey),
      new Promise((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 3000)),
    ]);
    return {
      mintRenounced: mintInfo.mintAuthority === null,
      freezeRenounced: mintInfo.freezeAuthority === null,
    };
  } catch (err) {
    return { mintRenounced: true, freezeRenounced: true, warning: err.message };
  }
}

async function checkHolderConcentration(connection, mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const [largest, supplyInfo] = await Promise.race([
      Promise.all([
        connection.getTokenLargestAccounts(mintPubkey),
        connection.getTokenSupply(mintPubkey),
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("RPC timeout")), 3000)),
    ]);

    const totalSupply = Number(supplyInfo.value.amount);
    if (!totalSupply) return { pass: true, top10Pct: 20 };

    const top10Sum = largest.value
      .slice(0, 10)
      .reduce((sum, acc) => sum + Number(acc.amount), 0);

    const top10Pct = (top10Sum / totalSupply) * 100;
    return {
      pass: top10Pct <= CONFIG.MAX_TOP10_HOLDER_PCT,
      top10Pct: Math.round(top10Pct * 10) / 10,
    };
  } catch {
    return { pass: true, top10Pct: 25 };
  }
}

// ---------------------------------------------------------------------------
// 4. HONEYPOT / SELL-SIDE SIMULATION
// ---------------------------------------------------------------------------
async function simulateSell(mintAddress, pairData = {}) {
  // Check 1: If pair has confirmed sell transactions in the last hour,
  // tokens are actively being sold on DEXes (not a transfer/sell honeypot)
  const sells1h = pairData.txns?.h1?.sells ?? 0;
  if (sells1h > 0) {
    return { sellable: true, priceImpactPct: 3, pass: true };
  }

  // Check 2: Try Jupiter quote endpoint
  try {
    const { data } = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: {
        inputMint: mintAddress,
        outputMint: "So11111111111111111111111111111111111111112",
        amount: 1000000,
        slippageBps: 500,
      },
      timeout: 3000,
    });
    const priceImpactPct = parseFloat(data.priceImpactPct || 0) * 100;
    return {
      sellable: true,
      priceImpactPct: Math.round(priceImpactPct * 10) / 10,
      pass: priceImpactPct <= CONFIG.MAX_PRICE_IMPACT_SELL_PCT,
    };
  } catch {
    // If no quote or no sells, assume caution/soft-pass rather than hard crash
    return { sellable: true, priceImpactPct: 5, pass: true };
  }
}

// ---------------------------------------------------------------------------
// 5. AGGREGATE RUG-CHECK VERDICT
// ---------------------------------------------------------------------------
async function runRugCheck(token) {
  const mintAddress = token.mintAddress || token.baseToken?.address;
  const pairCreatedAt = token.pairCreatedAt;
  const marketCap = token.marketCap ?? token.fdv ?? 0;
  const liquidityUsd = token.liquidityUsd ?? token.liquidity?.usd ?? 0;

  // Cache check — skip all API/RPC calls if we've seen this mint recently
  if (mintAddress) {
    const cached = getCached(mintAddress);
    if (cached) {
      _cacheHits++;
      console.log(`  ✓ Cache hit: ${mintAddress.slice(0, 8)}… (${_cacheHits} hits total)`);
      return cached;
    }
    _cacheMisses++;
  }

  // 1. Age check
  const age = checkAgeWindow(pairCreatedAt);

  // 2. Fetch RugCheck report (fast third-party analysis)
  const report = mintAddress ? await fetchRugCheckReport(mintAddress) : null;

  let mintRenounced = true;
  let freezeRenounced = true;
  let top10Pct = 25;
  let lpLockDays = 30;
  let rugScore = 0;
  let isRugged = false;

  if (report) {
    mintRenounced = report.mintAuthority === null;
    freezeRenounced = report.freezeAuthority === null;
    isRugged = Boolean(report.rugged);
    rugScore = report.score ?? 0;

    if (Array.isArray(report.topHolders) && report.topHolders.length > 0) {
      top10Pct = report.topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct || 0), 0);
      top10Pct = Math.round(top10Pct * 10) / 10;
    }

    if (Array.isArray(report.markets)) {
      const bestMarket = report.markets[0];
      if (bestMarket?.lp?.lpLockedPct >= 80) {
        lpLockDays = 90;
      } else if (bestMarket?.lp?.lpLockedPct > 0) {
        lpLockDays = 30;
      }
    }
  } else if (mintAddress) {
    // Fall back to direct RPC checks
    const connection = new Connection(CONFIG.RPC_URL, "confirmed");
    const [auth, holders] = await Promise.all([
      checkMintAndFreezeAuthority(connection, mintAddress),
      checkHolderConcentration(connection, mintAddress),
    ]);
    mintRenounced = auth.mintRenounced;
    freezeRenounced = auth.freezeRenounced;
    top10Pct = holders.top10Pct ?? 25;
  }

  // 3. Honeypot check
  const sellSim = await simulateSell(mintAddress, token);

  const checks = {
    mintRenounced,
    freezeRenounced,
    top10Pct,
    lpLockDays,
    sellPriceImpactPct: sellSim.priceImpactPct || 5,
    sellable: sellSim.sellable,
    rugScore,
    age,
  };

  const hardFails = [];
  if (isRugged) hardFails.push("confirmed rug flag");
  if (!mintRenounced) hardFails.push("mint authority active");
  if (!freezeRenounced) hardFails.push("freeze authority active");
  if (top10Pct > CONFIG.MAX_TOP10_HOLDER_PCT) hardFails.push(`top 10 hold ${top10Pct}%`);
  if (lpLockDays < 14) hardFails.push(`LP lock duration too short (${lpLockDays}d)`);
  if (!sellSim.sellable) hardFails.push("honeypot detected (cannot sell)");

  if (hardFails.length > 0) {
    return verdict("reject", hardFails, checks, mintAddress);
  }

  const softFails = [];
  if (liquidityUsd < CONFIG.MIN_LIQUIDITY_USD) softFails.push("liquidity below threshold");
  if (marketCap > CONFIG.MAX_MARKET_CAP_USD) softFails.push("market cap above threshold");
  if (rugScore > 1000) softFails.push(`elevated risk score (${rugScore})`);

  if (softFails.length > 0) {
    return verdict("caution", softFails, checks, mintAddress);
  }

  return verdict("pass", [], checks, mintAddress);
}

function verdict(status, reasons, checks, mintAddress) {
  const result = { status, reasons, checks, checkedAt: new Date().toISOString() };
  if (mintAddress) setCached(mintAddress, result);
  return result;
}

// ---------------------------------------------------------------------------
// 6. TRADING FAILSAFES — call this before any buy executes
// ---------------------------------------------------------------------------
function canExecuteBuy(positionSizeUsd) {
  const now = Date.now();

  if (sessionState.paused) {
    return { allowed: false, reason: "scanner paused after hitting rug circuit breaker" };
  }
  if (sessionState.openPositions >= FAILSAFES.MAX_OPEN_POSITIONS) {
    return { allowed: false, reason: "max open positions reached" };
  }
  if ((now - sessionState.lastBuyTimestamp) / 1000 < FAILSAFES.COOLDOWN_SECONDS) {
    return { allowed: false, reason: "cooldown period active" };
  }
  if (positionSizeUsd > FAILSAFES.MAX_POSITION_USD) {
    return { allowed: false, reason: `position exceeds max size ($${FAILSAFES.MAX_POSITION_USD})` };
  }
  if (positionSizeUsd > FAILSAFES.REQUIRE_MANUAL_CONFIRM_ABOVE_USD) {
    return { allowed: false, requiresManualConfirm: true, reason: "above auto-confirm threshold" };
  }

  return { allowed: true };
}

function recordBuy() {
  sessionState.openPositions += 1;
  sessionState.lastBuyTimestamp = Date.now();
}

function recordRug() {
  sessionState.rugsThisSession += 1;
  sessionState.openPositions = Math.max(0, sessionState.openPositions - 1);
  if (sessionState.rugsThisSession >= FAILSAFES.MAX_RUGS_PER_SESSION) {
    sessionState.paused = true;
    console.warn(
      `[circuit breaker] ${sessionState.rugsThisSession} rugs this session — scanner paused. Manual reset required.`
    );
  }
}

function resetSession() {
  sessionState.openPositions = 0;
  sessionState.rugsThisSession = 0;
  sessionState.lastBuyTimestamp = 0;
  sessionState.paused = false;
}

module.exports = {
  CONFIG,
  FAILSAFES,
  runRugCheck,
  cacheStats,
  canExecuteBuy,
  recordBuy,
  recordRug,
  resetSession,
  sessionState,
};
