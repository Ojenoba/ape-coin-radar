/**
 * scanner.js
 * ----------
 * Phase 1 of Ape Coin Radar: fetch new Solana pairs from Dexscreener
 * and print the ones that pass your strategy filters.
 *
 * Run with: node scanner.js
 */

const axios = require("axios");

// ---------------------------------------------------------------------------
// YOUR STRATEGY RULES
// ---------------------------------------------------------------------------
const FILTERS = {
  MAX_MARKET_CAP_USD: 1_000_000,
  MIN_LIQUIDITY_USD: 200_000,
  MIN_VOLUME_SPIKE_PCT: 50,   // % price/volume change in the last hour
  AGE_MIN_HOURS: 0,
  AGE_MAX_HOURS: 24,
};

// Dexscreener endpoints
const DEXSCREENER_SEARCH_URL = "https://api.dexscreener.com/latest/dex/search";
const DEXSCREENER_PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
const DEXSCREENER_BOOSTS_URL = "https://api.dexscreener.com/token-boosts/latest/v1";
const DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens";

/**
 * Fetches recent and trending Solana pairs from Dexscreener using
 * multi-source discovery:
 * 1. Latest token profiles
 * 2. Latest token boosts
 * 3. Search query
 */
async function fetchSolanaPairs(query = "solana") {
  const allPairs = [];
  const seenPairAddresses = new Set();

  try {
    // Parallel fetch from profiles, boosts, and search
    const [profilesRes, boostsRes, searchRes] = await Promise.allSettled([
      axios.get(DEXSCREENER_PROFILES_URL, { timeout: 6000 }),
      axios.get(DEXSCREENER_BOOSTS_URL, { timeout: 6000 }),
      axios.get(DEXSCREENER_SEARCH_URL, { params: { q: query }, timeout: 6000 }),
    ]);

    const solanaMints = new Set();

    if (profilesRes.status === "fulfilled" && Array.isArray(profilesRes.value.data)) {
      profilesRes.value.data
        .filter((item) => item.chainId === "solana" && item.tokenAddress)
        .forEach((item) => solanaMints.add(item.tokenAddress));
    }

    if (boostsRes.status === "fulfilled" && Array.isArray(boostsRes.value.data)) {
      boostsRes.value.data
        .filter((item) => item.chainId === "solana" && item.tokenAddress)
        .forEach((item) => solanaMints.add(item.tokenAddress));
    }

    // Add search result pairs directly
    if (searchRes.status === "fulfilled" && Array.isArray(searchRes.value.data?.pairs)) {
      searchRes.value.data.pairs
        .filter((p) => p.chainId === "solana")
        .forEach((p) => {
          if (!seenPairAddresses.has(p.pairAddress)) {
            seenPairAddresses.add(p.pairAddress);
            allPairs.push(p);
          }
        });
    }

    // Batch query pair data for discovered mints (up to 30 mints at a time)
    const mintList = Array.from(solanaMints).slice(0, 30);
    if (mintList.length > 0) {
      try {
        const tokensRes = await axios.get(
          `${DEXSCREENER_TOKENS_URL}/${mintList.join(",")}`,
          { timeout: 8000 }
        );
        if (tokensRes.data?.pairs && Array.isArray(tokensRes.data.pairs)) {
          tokensRes.data.pairs
            .filter((p) => p.chainId === "solana")
            .forEach((p) => {
              if (!seenPairAddresses.has(p.pairAddress)) {
                seenPairAddresses.add(p.pairAddress);
                allPairs.push(p);
              }
            });
        }
      } catch (err) {
        console.warn("⚠️ Tokens lookup error:", err.message);
      }
    }

    return allPairs;
  } catch (err) {
    console.error("Failed to fetch from Dexscreener:", err.message);
    return [];
  }
}

/**
 * Applies your strategy filters to a single pair.
 * Returns { pass, reasons } so you can see why something failed.
 */
function applyFilters(pair) {
  const reasons = [];

  const marketCap = pair.fdv ?? pair.marketCap ?? null;
  const liquidityUsd = pair.liquidity?.usd ?? null;
  const volumeChangePct = pair.priceChange?.h1 ?? null; // 1h % change as a proxy for spike
  const createdAtMs = pair.pairCreatedAt ?? null;

  if (marketCap === null || marketCap > FILTERS.MAX_MARKET_CAP_USD) {
    reasons.push(`market cap ${marketCap ?? "unknown"} exceeds max`);
  }
  if (liquidityUsd === null || liquidityUsd < FILTERS.MIN_LIQUIDITY_USD) {
    reasons.push(`liquidity ${liquidityUsd ?? "unknown"} below min`);
  }
  if (volumeChangePct === null || volumeChangePct < FILTERS.MIN_VOLUME_SPIKE_PCT) {
    reasons.push(`1h change ${volumeChangePct ?? "unknown"}% below spike threshold`);
  }
  if (createdAtMs === null) {
    reasons.push("no creation timestamp available");
  } else {
    const ageHours = (Date.now() - createdAtMs) / (1000 * 60 * 60);
    if (ageHours < FILTERS.AGE_MIN_HOURS || ageHours > FILTERS.AGE_MAX_HOURS) {
      reasons.push(`age ${ageHours.toFixed(1)}h outside 0-24h window`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Main entry point: fetch, filter, print.
 */
async function run() {
  console.log("Fetching Solana pairs from Dexscreener...\n");
  const pairs = await fetchSolanaPairs("solana");
  console.log(`Fetched ${pairs.length} Solana pairs. Applying filters...\n`);

  const matches = [];

  for (const pair of pairs) {
    const { pass, reasons } = applyFilters(pair);
    if (pass) {
      matches.push(pair);
    }
  }

  if (matches.length === 0) {
    console.log("No pairs matched your filters this run.");
    return;
  }

  console.log(`${matches.length} pair(s) matched your filters:\n`);
  for (const pair of matches) {
    const ageHours = (
      (Date.now() - pair.pairCreatedAt) /
      (1000 * 60 * 60)
    ).toFixed(1);

    console.log(`• ${pair.baseToken.symbol} / ${pair.quoteToken.symbol}`);
    console.log(`  Market cap: $${(pair.fdv ?? pair.marketCap ?? 0).toLocaleString()}`);
    console.log(`  Liquidity:  $${(pair.liquidity?.usd ?? 0).toLocaleString()}`);
    console.log(`  1h change:  ${pair.priceChange?.h1 ?? "n/a"}%`);
    console.log(`  Age:        ${ageHours}h`);
    console.log(`  URL:        ${pair.url}`);
    console.log("");
  }
}

if (require.main === module) {
  run();
}

// Export for use as a module
module.exports = {
  fetchSolanaPairs,
  applyFilters,
  run,
};
