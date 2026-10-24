const { DatabaseSync } = require('node:sqlite');
const path = require('path');

let db;

async function initDB() {
  db = new DatabaseSync(path.join(__dirname, 'aperadar.sqlite'));

  db.exec(`
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
  
  const insertScanStmt = db.prepare('INSERT INTO scans (pair_count) VALUES (?)');
  const result = insertScanStmt.run(pairs.length);
  const scanId = result.lastInsertRowid;
  
  const stmt = db.prepare(`
    INSERT INTO tokens (
      scan_id, symbol, quote, name, marketCap, liquidityUsd, 
      change1h, ageHours, url, mintAddress, pairAddress, 
      checks, verdictStatus, verdictReasons
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const pair of pairs) {
    stmt.run(
      scanId ?? null,
      pair.symbol ?? null,
      pair.quote ?? null,
      pair.name ?? null,
      pair.marketCap ?? null,
      pair.liquidityUsd ?? null,
      pair.change1h ?? null,
      pair.ageHours ?? null,
      pair.url ?? null,
      pair.mintAddress ?? null,
      pair.pairAddress ?? null,
      JSON.stringify(pair.checks || {}),
      pair.verdict?.status ?? null,
      JSON.stringify(pair.verdict?.reasons || [])
    );
  }
  
  return scanId;
}

module.exports = {
  initDB,
  saveScan
};
