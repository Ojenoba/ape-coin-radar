/**
 * server.js
 * ---------
 * Express server that:
 * 1. Fetches live pairs from Dexscreener API
 * 2. Applies on-chain & off-chain rug checks
 * 3. Serves live data to the Ape Radar frontend
 * 4. Auto-scans every 3 minutes & on user app open
 * 
 * Usage: node server.js
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const cron = require("node-cron");
const pLimitModule = require("p-limit");
const pLimit = pLimitModule.default || pLimitModule;
const scanner = require("./scanner.js");
const rugCheck = require("./rugcheck.js");
const database = require("./database.js");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Auto-scan configuration: 3 minutes delay between automatic scans
const AUTO_SCAN_INTERVAL_MS = 3 * 60 * 1000;

// In-memory cache of the latest live scan results
let latestPairs = [];
let lastScanTime = null;
let isScanning = false;

/** Max simultaneous rug-check requests to external APIs */
const RUG_CHECK_CONCURRENCY = 3;
/** Milliseconds to wait between starting each slot (spread load further) */
const RUG_CHECK_SLOT_DELAY_MS = 200;

// Using p-limit library for concurrency
const limit = pLimit(RUG_CHECK_CONCURRENCY);

/**
 * Run the full Dexscreener scanner + rug-check pipeline
 */
async function runFullScan(force = false) {
  if (isScanning) {
    console.log("⏳ Scan already in progress, skipping...");
    return latestPairs;
  }

  const now = Date.now();
  if (!force && lastScanTime && (now - new Date(lastScanTime).getTime() < AUTO_SCAN_INTERVAL_MS)) {
    const remainingSecs = Math.round((AUTO_SCAN_INTERVAL_MS - (now - new Date(lastScanTime).getTime())) / 1000);
    console.log(`⏳ Auto-scan delay active: next scan allowed in ${remainingSecs}s. Serving cached live pairs.`);
    return latestPairs;
  }

  isScanning = true;
  console.log("\n🔍 Starting live scan from Dexscreener API...");
  io.emit("scanStarted", { startTime: new Date() });
  io.emit("scanStatus", { isScanning: true, message: "Querying Dexscreener API for trending Solana pairs..." });

  try {
    // Step 1: Get live candidates from Dexscreener (multi-source: boosts, profiles, search)
    console.log("  → Fetching pairs from Dexscreener...");
    const rawPairs = await scanner.fetchSolanaPairs("solana");
    console.log(`  → Discovered ${rawPairs.length} Solana pairs from Dexscreener`);
    
    io.emit("scanStatus", { 
      isScanning: true, 
      message: `Discovered ${rawPairs.length} live pairs. Analyzing liquidity and contracts...` 
    });

    // Step 2: Filter to valid trading candidates (minimum liquidity > $2k, age < 72h)
    const candidates = rawPairs
      .filter((pair) => {
        if (!pair.baseToken?.address) return false;
        const liquidity = pair.liquidity?.usd ?? 0;
        const marketCap = pair.fdv ?? pair.marketCap ?? 0;
        return liquidity >= 2000 && marketCap <= 10_000_000;
      })
      .slice(0, 30);

    console.log(`  → Pre-filtering ${candidates.length} candidates against strategy rules...`);

    // Step 3: Split candidates into priority (pass strategy filters) and rest
    const priority = [];
    const rest     = [];

    for (const pair of candidates) {
      const { pass } = scanner.applyFilters(pair);
      if (pass) priority.push(pair);
      else      rest.push(pair);
    }

    console.log(`  → ${priority.length} pass strategy filters → running contract safety checks`);
    console.log(`  → ${rest.length} other pairs → marked caution`);

    // Helper to build a result object from a raw pair + a pre-computed verdict
    function buildResult(pair, verdictObj) {
      const ageHours = pair.pairCreatedAt
        ? Math.max(0, (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60))
        : 0;
      return {
        symbol:       pair.baseToken.symbol || "UNKNOWN",
        quote:        pair.quoteToken?.symbol || "SOL",
        name:         pair.baseToken.name || pair.baseToken.symbol || "Unknown",
        marketCap:    pair.fdv ?? pair.marketCap ?? 0,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        change1h:     pair.priceChange?.h1 || 0,
        ageHours:     Number(ageHours.toFixed(1)),
        url:          pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
        mintAddress:  pair.baseToken.address,
        pairAddress:  pair.pairAddress,
        checks:       verdictObj.checks || {},
        verdict: {
          status:  verdictObj.status,
          reasons: verdictObj.reasons,
        },
      };
    }

    // Step 4: Safety checks on priority tokens (concurrency capped)
    const checkedResults = await Promise.all(priority.map(pair => limit(async () => {
      const tokenCandidate = {
        mintAddress:  pair.baseToken.address,
        pairAddress:  pair.pairAddress,
        pairCreatedAt: pair.pairCreatedAt,
        marketCap:    pair.fdv ?? pair.marketCap ?? 0,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        txns:         pair.txns,
        priceChange:  pair.priceChange,
      };
      const v = await rugCheck.runRugCheck(tokenCandidate);
      await new Promise(r => setTimeout(r, RUG_CHECK_SLOT_DELAY_MS));
      return buildResult(pair, v);
    })));

    // Step 5: Build caution results for remaining pairs
    const cautionResults = rest.map((pair) =>
      buildResult(pair, {
        status:  "caution",
        reasons: ["did not meet current volume/liquidity spike filter"],
        checks:  {},
      })
    );

    const cache = rugCheck.cacheStats();
    latestPairs  = [...checkedResults, ...cautionResults];
    lastScanTime = new Date();
    
    // Save to SQLite
    try {
      await database.saveScan(latestPairs);
    } catch (dbErr) {
      console.warn("⚠️ Failed to record scan to database:", dbErr.message);
    }
    
    // Emit results via WebSocket
    io.emit("newScanResults", {
      pairs: latestPairs,
      lastScan: lastScanTime,
      nextScanIn: AUTO_SCAN_INTERVAL_MS,
      intervalMs: AUTO_SCAN_INTERVAL_MS
    });

    io.emit("scanStatus", { 
      isScanning: false, 
      lastScan: lastScanTime,
      count: latestPairs.length,
      nextScanIn: AUTO_SCAN_INTERVAL_MS,
      intervalMs: AUTO_SCAN_INTERVAL_MS
    });

    console.log(
      `✅ Scan complete! ${checkedResults.length} verified, ${cautionResults.length} standard candidates. ` +
      `Cache: ${cache.hits} hits / ${cache.misses} misses (${cache.hitRate})`
    );
  } catch (err) {
    console.error("❌ Scan failed:", err.message);
    io.emit("scanStatus", { isScanning: false, error: err.message });
  } finally {
    isScanning = false;
  }
  return latestPairs;
}

/**
 * Socket.IO connection handling
 */
io.on("connection", (socket) => {
  const now = Date.now();
  const nextScanIn = lastScanTime 
    ? Math.max(0, AUTO_SCAN_INTERVAL_MS - (now - new Date(lastScanTime).getTime())) 
    : 0;

  // Send current state to newly connected client immediately
  socket.emit("scanStatus", {
    isScanning,
    lastScan: lastScanTime,
    count: latestPairs.length,
    nextScanIn,
    intervalMs: AUTO_SCAN_INTERVAL_MS
  });

  if (latestPairs.length > 0) {
    socket.emit("newScanResults", {
      pairs: latestPairs,
      lastScan: lastScanTime,
      nextScanIn,
      intervalMs: AUTO_SCAN_INTERVAL_MS
    });
  }

  // Auto scan when user opens the app if no data or if last scan was > 3 mins ago
  const isStale = !lastScanTime || (now - new Date(lastScanTime).getTime() >= AUTO_SCAN_INTERVAL_MS);
  if ((latestPairs.length === 0 || isStale) && !isScanning) {
    console.log("⚡ Auto-scan triggered on user app open (initial or > 3 min delay elapsed)");
    runFullScan(true);
  }
});

/**
 * API: Get latest scan results
 * Automatically triggers a live Dexscreener scan if no data exists or if 3 minutes have elapsed
 */
app.get("/api/pairs", async (req, res) => {
  const now = Date.now();
  const isStale = !lastScanTime || (now - new Date(lastScanTime).getTime() >= AUTO_SCAN_INTERVAL_MS);

  if ((latestPairs.length === 0 || isStale) && !isScanning) {
    console.log("⚡ Auto-scan triggered on GET /api/pairs");
    runFullScan(true);
  }

  const nextScanIn = lastScanTime 
    ? Math.max(0, AUTO_SCAN_INTERVAL_MS - (now - new Date(lastScanTime).getTime())) 
    : 0;

  res.json({
    pairs: latestPairs,
    lastScan: lastScanTime,
    count: latestPairs.length,
    isScanning,
    nextScanIn,
    intervalMs: AUTO_SCAN_INTERVAL_MS
  });
});

/**
 * API: Trigger a manual scan
 */
app.post("/api/scan", async (req, res) => {
  console.log("🚀 Manual scan triggered from frontend");
  if (!isScanning) {
    runFullScan(true);
  }
  res.json({
    status: isScanning ? "scan already in progress" : "scan initiated",
    pairs: latestPairs.length,
    lastScan: lastScanTime,
    isScanning: true,
  });
});

/**
 * API: Health check
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    lastScan: lastScanTime,
    pairsInCache: latestPairs.length,
    intervalMs: AUTO_SCAN_INTERVAL_MS,
    rugCheckCache: rugCheck.cacheStats(),
  });
});

// Initialize Database and Start Server
const PORT = process.env.PORT || 3001;
database.initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀 Ape Radar API Server running on http://localhost:${PORT}`);
    console.log(`   Live API Feed:     http://localhost:${PORT}/api/pairs`);
    console.log(`   Health check:      http://localhost:${PORT}/api/health`);
    console.log(`   WebSocket:         ws://localhost:${PORT}`);
    console.log(`\n   ⏳ Auto-scanner configured: runs every 3 minutes & on user app open.`);
    
    // Scheduled cron job: every 3 minutes
    cron.schedule('*/3 * * * *', () => {
      console.log("⏰ 3-minute interval elapsed: executing scheduled auto-scan...");
      runFullScan();
    });
    
    // Kick off first live scan immediately
    runFullScan(true);
  });
}).catch(err => {
  console.error("Failed to initialize database:", err);
});
