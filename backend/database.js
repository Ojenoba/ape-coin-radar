const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let db;

async function initDB() {
  db = await open({
    filename: path.join(__dirname, 'aperadar.sqlite'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      pair_count INTEGER NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER,
      symbol TEXT,
      quote TEXT,
      name TEXT,
      marketCap REAL,
      liquidityUsd REAL,
      change1h REAL,
      ageHours REAL,
      url TEXT,
      mintAddress TEXT,
      pairAddress TEXT,
      checks JSON,
      verdictStatus TEXT,
      verdictReasons JSON,
      FOREIGN KEY(scan_id) REFERENCES scans(id)
    );
  `);
  
  console.log("Database initialized");
}

async function saveScan(pairs) {
  if (!db) return;
  
  const result = await db.run('INSERT INTO scans (pair_count) VALUES (?)', [pairs.length]);
  const scanId = result.lastID;
  
  const stmt = await db.prepare(`
    INSERT INTO tokens (
      scan_id, symbol, quote, name, marketCap, liquidityUsd, 
      change1h, ageHours, url, mintAddress, pairAddress, 
      checks, verdictStatus, verdictReasons
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const pair of pairs) {
    await stmt.run([
      scanId,
      pair.symbol,
      pair.quote,
      pair.name,
      pair.marketCap,
      pair.liquidityUsd,
      pair.change1h,
      pair.ageHours,
      pair.url,
      pair.mintAddress,
      pair.pairAddress,
      JSON.stringify(pair.checks || {}),
      pair.verdict.status,
      JSON.stringify(pair.verdict.reasons || [])
    ]);
  }
  
  await stmt.finalize();
  return scanId;
}

module.exports = {
  initDB,
  saveScan
};
