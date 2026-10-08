import React, { useState, useEffect, useMemo, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  XCircle,
  ExternalLink,
  ChevronDown,
  SlidersHorizontal,
  Zap,
  Shield,
  TrendingUp,
  Radio,
  ArrowUpDown,
  Filter,
  Search,
  Copy,
  Check,
  Clock,
  Menu,
  X,
  Compass,
  Sparkles
} from "lucide-react";

// Utility for class merging
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Types & Defaults
// ---------------------------------------------------------------------------
interface StrategyFilters {
  maxMarketCap: number;
  minLiquidity: number;
  minSpike: number;
  hideFiltered: boolean;
}

const DEFAULT_FILTERS: StrategyFilters = {
  maxMarketCap: 1_000_000,
  minLiquidity:   200_000,
  minSpike:            50,
  hideFiltered:     false,
};

type SortKey = "marketCap" | "liquidityUsd" | "change1h" | "ageHours" | "default";
type TabFilter = "all" | "pass" | "caution" | "reject";

// 3 minutes auto-scan interval
const AUTO_SCAN_SECONDS = 180;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getVerdict(pair: any, filters: StrategyFilters): { status: "pass" | "caution" | "reject"; reasons: string[] } {
  const checks = pair.checks || {};
  const hardFails: string[] = [];

  if (checks.mintRenounced === false) hardFails.push("Mint authority active");
  if (checks.freezeRenounced === false) hardFails.push("Freeze authority active");
  if (typeof checks.top10Pct === "number" && checks.top10Pct > 40) hardFails.push(`Top 10 hold ${checks.top10Pct}%`);
  if (typeof checks.lpLockDays === "number" && checks.lpLockDays < 14) hardFails.push(`LP locked ${checks.lpLockDays}d`);
  if (typeof checks.sellPriceImpactPct === "number" && checks.sellPriceImpactPct > 15) hardFails.push(`Sell impact ${checks.sellPriceImpactPct}%`);
  if (checks.sellable === false) hardFails.push("Honeypot detected");

  if (hardFails.length > 0) return { status: "reject", reasons: hardFails };

  const softFails: string[] = [];
  if ((pair.marketCap || 0) > filters.maxMarketCap) softFails.push("Market cap above filter");
  if ((pair.liquidityUsd || 0) < filters.minLiquidity) softFails.push("Liquidity below filter");
  if ((pair.change1h || 0) < filters.minSpike) softFails.push("1h change below spike filter");

  if (softFails.length > 0) return { status: "caution", reasons: softFails };
  return { status: "pass", reasons: [] };
}

const VERDICT_STYLE = {
  pass: {
    icon: CheckCircle2,
    label: "PASS",
    dot: "bg-emerald-400",
    text: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    rowGlow: "hover:border-emerald-500/40",
    statBorder: "border-emerald-500/30",
    statBg: "bg-emerald-950/20"
  },
  caution: {
    icon: AlertCircle,
    label: "CAUTION",
    dot: "bg-amber-400",
    text: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    rowGlow: "hover:border-amber-500/40",
    statBorder: "border-amber-500/30",
    statBg: "bg-amber-950/20"
  },
  reject: {
    icon: XCircle,
    label: "REJECT",
    dot: "bg-rose-400",
    text: "text-rose-400",
    bg: "bg-rose-500/10",
    border: "border-rose-500/30",
    rowGlow: "hover:border-rose-500/40",
    statBorder: "border-rose-500/30",
    statBg: "bg-rose-950/20"
  },
};

const AVATAR_GRADIENTS = [
  "from-cyan-500 to-blue-600",
  "from-violet-500 to-indigo-600",
  "from-rose-500 to-pink-600",
  "from-amber-500 to-orange-600",
  "from-emerald-500 to-teal-600",
  "from-fuchsia-500 to-purple-600",
];

function avatarGradient(symbol: string) {
  const code = symbol ? symbol.charCodeAt(0) : 0;
  return AVATAR_GRADIENTS[code % AVATAR_GRADIENTS.length];
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function TokenAvatar({ symbol }: { symbol: string }) {
  const letter = (symbol && symbol[0]) ? symbol[0].toUpperCase() : "?";
  return (
    <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-md bg-gradient-to-br font-bold text-white text-sm", avatarGradient(symbol))}>
      {letter}
    </div>
  );
}

function VerdictBadge({ status }: { status: "pass" | "caution" | "reject" }) {
  const s = VERDICT_STYLE[status] || VERDICT_STYLE.caution;
  const Icon = s.icon;
  return (
    <div className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold border tracking-wide shadow-sm", s.text, s.bg, s.border)}>
      <span className={cn("w-1.5 h-1.5 rounded-full animate-pulse-glow", s.dot)} />
      <Icon size={13} className="shrink-0" />
      <span>{s.label}</span>
    </div>
  );
}

function StatCard({ 
  label, 
  value, 
  icon: Icon, 
  verdictKey,
  subtext 
}: { 
  label: string; 
  value: number; 
  icon: any; 
  verdictKey?: "pass" | "caution" | "reject";
  subtext?: string;
}) {
  const s = verdictKey ? VERDICT_STYLE[verdictKey] : null;
  return (
    <div className={cn(
      "glass-panel rounded-2xl p-4 sm:p-5 flex items-center gap-4 transition-all duration-200 hover:-translate-y-0.5",
      s ? `${s.statBorder} ${s.statBg}` : "border-white/[0.07]"
    )}>
      <div className={cn(
        "w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-inner",
        s ? s.bg : "bg-slate-800/60"
      )}>
        <Icon size={22} className={s ? s.text : "text-cyan-400"} />
      </div>
      <div className="min-w-0">
        <div className={cn("text-2xl sm:text-3xl font-extrabold font-mono tracking-tight", s ? s.text : "text-white")}>
          {value}
        </div>
        <div className="text-xs text-slate-400 font-semibold tracking-wider uppercase mt-0.5">
          {label}
        </div>
        {subtext && (
          <div className="text-[11px] text-slate-500 mt-0.5 font-medium">{subtext}</div>
        )}
      </div>
    </div>
  );
}

function SortHeader({ 
  label, 
  sortKey, 
  currentSort, 
  currentDesc, 
  onClick 
}: { 
  label: string; 
  sortKey: SortKey; 
  currentSort: SortKey; 
  currentDesc: boolean; 
  onClick: (k: SortKey) => void;
}) {
  const active = currentSort === sortKey;
  return (
    <th 
      className="text-right font-semibold px-4 sm:px-6 py-3.5 text-xs text-slate-400 tracking-wider uppercase cursor-pointer hover:text-cyan-300 transition-colors select-none"
      onClick={() => onClick(sortKey)}
    >
      <div className="flex items-center justify-end gap-1.5 group">
        <span>{label}</span>
        <ArrowUpDown 
          size={12} 
          className={cn(
            "transition-all duration-200", 
            active ? "text-cyan-400 opacity-100" : "opacity-30 group-hover:opacity-80", 
            active && !currentDesc && "rotate-180 text-cyan-300"
          )} 
        />
      </div>
    </th>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy Mint Address"
      className="p-1 rounded-md text-slate-400 hover:text-cyan-300 hover:bg-white/10 transition-colors inline-flex items-center gap-1 text-xs"
    >
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {copied && <span className="text-[10px] text-emerald-400">Copied</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Strategy Filter Component
// ---------------------------------------------------------------------------
function FilterControls({
  filters,
  setFilters,
}: {
  filters: StrategyFilters;
  setFilters: React.Dispatch<React.SetStateAction<StrategyFilters>>;
}) {
  const getProgress = (val: number, min: number, max: number, activeColor: string = "#22d3ee") => {
    const pct = Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100));
    return {
      background: `linear-gradient(to right, ${activeColor} 0%, ${activeColor} ${pct}%, rgba(30, 41, 59, 0.8) ${pct}%, rgba(30, 41, 59, 0.8) 100%)`
    };
  };

  return (
    <div className="space-y-6">
      {/* Max Market Cap Slider */}
      <div className="space-y-2">
        <div className="flex justify-between items-center text-xs">
          <span className="text-slate-300 font-medium">Max Market Cap</span>
          <span className="font-mono text-cyan-300 font-bold bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/40">
            {fmtUsd(filters.maxMarketCap)}
          </span>
        </div>
        <input
          type="range"
          min={50_000}
          max={2_000_000}
          step={10_000}
          value={filters.maxMarketCap}
          style={getProgress(filters.maxMarketCap, 50_000, 2_000_000, "#22d3ee")}
          onChange={(e) => setFilters(f => ({ ...f, maxMarketCap: Number(e.target.value) }))}
          className="w-full"
        />
        <div className="flex justify-between text-[10px] text-slate-500 font-mono">
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, maxMarketCap: 50_000 }))}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            $50K
          </button>
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, maxMarketCap: 1_000_000 }))}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            $1M
          </button>
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, maxMarketCap: 2_000_000 }))}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            $2M
          </button>
        </div>
      </div>

      {/* Min Liquidity Slider */}
      <div className="space-y-2">
        <div className="flex justify-between items-center text-xs">
          <span className="text-slate-300 font-medium">Min Liquidity</span>
          <span className="font-mono text-cyan-300 font-bold bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/40">
            {fmtUsd(filters.minLiquidity)}
          </span>
        </div>
        <input
          type="range"
          min={5_000}
          max={500_000}
          step={2_500}
          value={filters.minLiquidity}
          style={getProgress(filters.minLiquidity, 5_000, 500_000, "#22d3ee")}
          onChange={(e) => setFilters(f => ({ ...f, minLiquidity: Number(e.target.value) }))}
          className="w-full"
        />
        <div className="flex justify-between text-[10px] text-slate-500 font-mono">
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, minLiquidity: 5_000 }))}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            $5K
          </button>
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, minLiquidity: 200_000 }))}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            $200K
          </button>
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, minLiquidity: 500_000 }))}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            $500K
          </button>
        </div>
      </div>

      {/* Min 1h Spike Slider */}
      <div className="space-y-2">
        <div className="flex justify-between items-center text-xs">
          <span className="text-slate-300 font-medium">Min 1h Spike</span>
          <span className="font-mono text-emerald-300 font-bold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/40">
            +{filters.minSpike}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          value={filters.minSpike}
          style={getProgress(filters.minSpike, 0, 200, "#10b981")}
          onChange={(e) => setFilters(f => ({ ...f, minSpike: Number(e.target.value) }))}
          className="w-full"
        />
        <div className="flex justify-between text-[10px] text-slate-500 font-mono">
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, minSpike: 0 }))}
            className="hover:text-emerald-300 transition-colors cursor-pointer"
          >
            0%
          </button>
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, minSpike: 50 }))}
            className="hover:text-emerald-300 transition-colors cursor-pointer"
          >
            +50%
          </button>
          <button 
            type="button" 
            onClick={() => setFilters(f => ({ ...f, minSpike: 200 }))}
            className="hover:text-emerald-300 transition-colors cursor-pointer"
          >
            +200%
          </button>
        </div>
      </div>

      {/* Strict Mode Toggle */}
      <div className="pt-4 border-t border-white/[0.08]">
        <label className="flex items-center justify-between cursor-pointer group select-none">
          <div className="flex items-center gap-2">
            <Filter size={15} className="text-cyan-400" />
            <span className="text-sm font-semibold text-slate-200 group-hover:text-white transition-colors">
              Strict Mode
            </span>
          </div>
          <div 
            onClick={() => setFilters(f => ({ ...f, hideFiltered: !f.hideFiltered }))}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer",
              filters.hideFiltered ? "bg-cyan-500 shadow-[0_0_12px_rgba(6,182,212,0.5)]" : "bg-slate-700/80"
            )}
          >
            <span 
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 shadow-md",
                filters.hideFiltered ? "translate-x-6" : "translate-x-1"
              )} 
            />
          </div>
        </label>
        <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
          When active, tokens that fail safety or threshold criteria are hidden completely.
        </p>
      </div>

      {/* Reset button */}
      <button
        onClick={() => setFilters(DEFAULT_FILTERS)}
        className="w-full py-2 text-xs font-semibold text-slate-400 hover:text-white border border-white/[0.08] hover:border-white/20 rounded-xl transition-all cursor-pointer hover:bg-white/[0.04]"
      >
        Reset Strategy Defaults
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard Component
// ---------------------------------------------------------------------------
export default function ApeRadar() {
  const [filters, setFilters] = useState<StrategyFilters>(DEFAULT_FILTERS);
  const [pairs, setPairs] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [scanMessage, setScanMessage] = useState<string>("Connecting to Dexscreener API...");
  
  // Sorting & Filtering Controls
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedTab, setSelectedTab] = useState<TabFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("default");
  const [sortDesc, setSortDesc] = useState<boolean>(true);

  // Mobile / Tablet Drawer State
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState<boolean>(false);

  // 3-Minute Auto Scan Countdown Timer
  const [countdown, setCountdown] = useState<number>(AUTO_SCAN_SECONDS);
  const countdownRef = useRef<number>(AUTO_SCAN_SECONDS);

  // Keep ref synchronized
  useEffect(() => {
    countdownRef.current = countdown;
  }, [countdown]);

  // -------------------------------------------------------------------------
  // Fetch from Dexscreener via Backend API
  // -------------------------------------------------------------------------
  const fetchLivePairs = async (triggerScan = false) => {
    setLoading(true);
    if (triggerScan) {
      setScanMessage("Triggering fresh Dexscreener live scan...");
    }
    try {
      const apiBase = import.meta.env.VITE_API_URL !== undefined ? import.meta.env.VITE_API_URL : "";
      const endpoint = triggerScan ? `${apiBase}/api/scan` : `${apiBase}/api/pairs`;
      const res = await fetch(endpoint, {
        method: triggerScan ? "POST" : "GET",
        headers: { "Content-Type": "application/json" }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      if (Array.isArray(data.pairs) && data.pairs.length > 0) {
        setPairs(data.pairs);
        if (data.lastScan) setLastScan(new Date(data.lastScan));
        setCountdown(AUTO_SCAN_SECONDS);
      }
      setBackendOnline(true);
    } catch (err) {
      console.warn("Backend not reachable or still scanning:", err);
      setBackendOnline(false);
      setScanMessage("Waiting for backend API on port 3001...");
    } finally {
      setLoading(false);
    }
  };

  // -------------------------------------------------------------------------
  // Socket.IO Setup (Live Data Streaming & Auto-Scan Events)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const apiBase = import.meta.env.VITE_API_URL || undefined;
    const socket: Socket = io(apiBase, {
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    socket.on("connect", () => {
      setBackendOnline(true);
      setScanMessage("Connected to live Dexscreener feed.");
    });

    socket.on("disconnect", () => {
      setBackendOnline(false);
    });

    socket.on("scanStarted", () => {
      setLoading(true);
      setScanMessage("Fetching trending Solana pairs from Dexscreener...");
    });

    socket.on("scanStatus", (status: any) => {
      if (status.isScanning) {
        setLoading(true);
        if (status.message) setScanMessage(status.message);
      } else {
        setLoading(false);
      }
      if (status.nextScanIn) {
        setCountdown(Math.round(status.nextScanIn / 1000));
      }
    });

    socket.on("newScanResults", (data: any) => {
      if (data && Array.isArray(data.pairs)) {
        setPairs(data.pairs);
        if (data.lastScan) setLastScan(new Date(data.lastScan));
        setCountdown(AUTO_SCAN_SECONDS);
        setLoading(false);
      }
    });

    // Initial fetch when app opens
    fetchLivePairs(false);

    return () => {
      socket.disconnect();
    };
  }, []);

  // -------------------------------------------------------------------------
  // 3-Minute Auto Scan Countdown Interval
  // -------------------------------------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          // Timer reached 0: execute 3-minute scheduled scan
          console.log("⏰ 3-minute delay elapsed. Requesting latest Dexscreener pairs...");
          fetchLivePairs(false);
          return AUTO_SCAN_SECONDS;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // -------------------------------------------------------------------------
  // Sort Handler
  // -------------------------------------------------------------------------
  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      if (!sortDesc) {
        setSortBy("default");
        setSortDesc(true);
      } else {
        setSortDesc(false);
      }
    } else {
      setSortBy(key);
      setSortDesc(true);
    }
  };

  // -------------------------------------------------------------------------
  // Filtered & Sorted Rows
  // -------------------------------------------------------------------------
  const rows = useMemo(() => {
    let processed = pairs.map((p: any) => ({
      ...p,
      verdict: getVerdict(p, filters)
    }));

    // Search query filter (symbol, name, mint address)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      processed = processed.filter((p: any) => 
        (p.symbol && p.symbol.toLowerCase().includes(q)) ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.mintAddress && p.mintAddress.toLowerCase().includes(q))
      );
    }

    // Quick Tab filter (All / Pass / Caution / Reject)
    if (selectedTab !== "all") {
      processed = processed.filter((r: any) => r.verdict.status === selectedTab);
    }

    // Strict mode filter (only clean pass)
    if (filters.hideFiltered) {
      processed = processed.filter((r: any) => r.verdict.status === "pass");
    }

    // Sorting
    processed.sort((a: any, b: any) => {
      if (sortBy === "default") {
        const order = { pass: 0, caution: 1, reject: 2 };
        return (order[a.verdict.status as keyof typeof order] ?? 1) - (order[b.verdict.status as keyof typeof order] ?? 1);
      }
      const valA = Number(a[sortBy] || 0);
      const valB = Number(b[sortBy] || 0);
      return sortDesc ? valB - valA : valA - valB;
    });

    return processed;
  }, [pairs, filters, searchQuery, selectedTab, sortBy, sortDesc]);

  // Statistics
  const stats = useMemo(() => {
    const list = pairs.map((p: any) => ({ ...p, verdict: getVerdict(p, filters) }));
    return {
      total: list.length,
      pass: list.filter((r: any) => r.verdict.status === "pass").length,
      caution: list.filter((r: any) => r.verdict.status === "caution").length,
      reject: list.filter((r: any) => r.verdict.status === "reject").length,
    };
  }, [pairs, filters]);



  return (
    <div className="min-h-screen bg-ambient text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30">
      
      {/* ── Top Navigation Bar ────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 glass-panel border-b border-white/[0.08] px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
        {/* Logo & Status */}
        <div className="flex items-center gap-3">
          {/* Mobile Drawer Hamburger Button */}
          <button
            onClick={() => setMobileDrawerOpen(!mobileDrawerOpen)}
            className="lg:hidden p-2 rounded-xl text-slate-300 hover:text-white hover:bg-white/5 border border-white/[0.08]"
            title="Toggle Filter Panel"
          >
            {mobileDrawerOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 via-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/25 shrink-0">
            <Activity size={22} className="text-white" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg sm:text-xl font-black tracking-tight gradient-text-cyan">
                Ape Radar
              </h1>
              <span className="text-[10px] font-bold tracking-widest uppercase bg-cyan-950/80 text-cyan-300 border border-cyan-800/40 px-2 py-0.5 rounded-full">
                Solana Live
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
              <span className={cn(
                "inline-block w-2 h-2 rounded-full",
                backendOnline ? "bg-emerald-400 animate-pulse-glow" : "bg-rose-400"
              )} />
              <span>{backendOnline ? "Dexscreener Feed Online" : "Connecting to Dexscreener"}</span>
            </div>
          </div>
        </div>

        {/* Center / Right controls */}
        <div className="flex items-center gap-2 sm:gap-4">
          {/* 3-Minute Auto Scan Countdown Badge */}
          <div className="hidden sm:flex items-center gap-2 bg-slate-900/80 border border-white/[0.08] px-3 py-1.5 rounded-xl text-xs font-mono">
            <Clock size={14} className="text-cyan-400 animate-spin" style={{ animationDuration: '8s' }} />
            <span className="text-slate-400 font-sans text-[11px] font-medium">Auto-scan in:</span>
            <span className="text-cyan-300 font-bold">{formatCountdown(countdown)}</span>
          </div>

          {/* Force Scan Button */}
          <button
            onClick={() => fetchLivePairs(true)}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 via-blue-600 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white px-4 sm:px-5 py-2 text-xs sm:text-sm font-bold tracking-wide transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={15} className={cn("transition-transform duration-500", loading && "animate-spin")} />
            <span>{loading ? "Scanning..." : "Force Scan"}</span>
          </button>
        </div>
      </header>

      {/* ── Main Layout Body ──────────────────────────────────────────────── */}
      <div className="flex-1 flex w-full relative">

        {/* ── Desktop Left Sidebar (Strategy Filters) ────────────────────── */}
        <aside className="w-80 shrink-0 hidden lg:flex flex-col glass-panel border-r border-white/[0.08] p-6 space-y-6">
          <div className="flex items-center gap-2 text-white font-bold text-sm tracking-wide pb-4 border-b border-white/[0.08]">
            <SlidersHorizontal size={18} className="text-cyan-400" />
            <span>Strategy Filters</span>
          </div>

          <FilterControls filters={filters} setFilters={setFilters} />

          {/* Live Feed Status Box */}
          <div className="mt-auto pt-6 border-t border-white/[0.08]">
            <div className="bg-slate-900/60 rounded-xl p-3 border border-white/[0.06] space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Data Source:</span>
                <span className="text-cyan-300 font-bold flex items-center gap-1">
                  <Radio size={12} className="text-cyan-400 animate-pulse" />
                  Dexscreener API
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Auto Scan Interval:</span>
                <span className="text-slate-200 font-mono font-medium">3 Minutes</span>
              </div>
              {lastScan && (
                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-white/[0.04]">
                  <span>Last Scanned:</span>
                  <span>{lastScan.toLocaleTimeString()}</span>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* ── Mobile / Tablet Sliding Drawer ─────────────────────────────── */}
        {mobileDrawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden flex">
            {/* Backdrop */}
            <div 
              onClick={() => setMobileDrawerOpen(false)}
              className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity" 
            />
            {/* Drawer */}
            <div className="relative w-80 max-w-full bg-[#0a0e1a] border-r border-white/10 p-6 flex flex-col z-50 overflow-y-auto">
              <div className="flex items-center justify-between pb-4 mb-4 border-b border-white/10">
                <div className="flex items-center gap-2 font-bold text-white">
                  <SlidersHorizontal size={18} className="text-cyan-400" />
                  <span>Strategy Filters</span>
                </div>
                <button 
                  onClick={() => setMobileDrawerOpen(false)}
                  className="p-1 rounded-lg text-slate-400 hover:text-white"
                >
                  <X size={20} />
                </button>
              </div>

              <FilterControls filters={filters} setFilters={setFilters} />
            </div>
          </div>
        )}

        {/* ── Main Dashboard Workspace ────────────────────────────────────── */}
        <main className="flex-1 flex flex-col min-w-0 px-4 sm:px-8 py-6 max-w-7xl mx-auto w-full space-y-6">

          {/* Banner / Status Bar */}
          {loading && (
            <div className="glass-panel border-cyan-500/30 bg-cyan-950/30 rounded-2xl p-4 flex items-center gap-3 animate-fade-in shadow-lg shadow-cyan-500/10">
              <RefreshCw size={18} className="text-cyan-400 animate-spin shrink-0" />
              <div className="text-xs sm:text-sm text-cyan-200 font-medium">
                {scanMessage}
              </div>
            </div>
          )}

          {/* ── Stat Metric Cards ────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-5">
            <StatCard 
              label="Dex Pairs Scanned" 
              value={stats.total} 
              icon={Compass} 
              subtext="Solana trending"
            />
            <StatCard 
              label="Clean Pass" 
              value={stats.pass} 
              icon={Shield} 
              verdictKey="pass" 
              subtext="Passed safety & filters"
            />
            <StatCard 
              label="Caution" 
              value={stats.caution} 
              icon={AlertCircle} 
              verdictKey="caution" 
              subtext="Threshold warning"
            />
            <StatCard 
              label="Rejected" 
              value={stats.reject} 
              icon={Zap} 
              verdictKey="reject" 
              subtext="Contract risk / rug"
            />
          </div>

          {/* ── Search Bar & Quick Tab Filters ───────────────────────────── */}
          <div className="glass-panel rounded-2xl p-3 sm:p-4 flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between border-white/[0.08]">
            
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                placeholder="Search token symbol, name, or address..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full glass-input rounded-xl pl-10 pr-4 py-2 text-xs sm:text-sm text-white placeholder-slate-500 outline-none transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Quick Segmented Tabs */}
            <div className="flex items-center gap-1.5 overflow-x-auto bg-slate-900/60 p-1 rounded-xl border border-white/[0.06] select-none">
              {(["all", "pass", "caution", "reject"] as TabFilter[]).map((tab) => {
                const count = tab === "all" ? stats.total : stats[tab];
                const active = selectedTab === tab;
                return (
                  <button
                    key={tab}
                    onClick={() => setSelectedTab(tab)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all whitespace-nowrap flex items-center gap-1.5",
                      active
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm"
                        : "text-slate-400 hover:text-slate-200 border border-transparent"
                    )}
                  >
                    <span className="capitalize">{tab}</span>
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.2 rounded-full font-mono",
                      active ? "bg-cyan-400/20 text-cyan-200" : "bg-slate-800 text-slate-400"
                    )}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Token Table Card ─────────────────────────────────────────── */}
          <div className="glass-panel rounded-2xl border border-white/[0.08] shadow-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="border-b border-white/[0.08] bg-slate-900/80">
                    <th className="font-semibold px-4 sm:px-6 py-3.5 text-xs text-slate-400 tracking-wider uppercase">
                      Token / Pair
                    </th>
                    <SortHeader label="Mkt Cap" sortKey="marketCap" currentSort={sortBy} currentDesc={sortDesc} onClick={handleSort} />
                    <SortHeader label="Liquidity" sortKey="liquidityUsd" currentSort={sortBy} currentDesc={sortDesc} onClick={handleSort} />
                    <SortHeader label="1h Change" sortKey="change1h" currentSort={sortBy} currentDesc={sortDesc} onClick={handleSort} />
                    <SortHeader label="Age" sortKey="ageHours" currentSort={sortBy} currentDesc={sortDesc} onClick={handleSort} />
                    <th className="font-semibold px-4 sm:px-6 py-3.5 text-xs text-slate-400 tracking-wider uppercase text-center">
                      Safety Verdict
                    </th>
                    <th className="px-4 sm:px-6 py-3.5 w-12" />
                  </tr>
                </thead>

                <tbody className="divide-y divide-white/[0.04]">
                  {/* Empty or Loading State */}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-16 text-center">
                        <div className="max-w-md mx-auto space-y-3">
                          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mx-auto text-cyan-400">
                            <Sparkles size={24} className="animate-pulse" />
                          </div>
                          <div className="font-bold text-white text-base">
                            {loading ? "Scanning Dexscreener API..." : "No Tokens Match Criteria"}
                          </div>
                          <p className="text-xs text-slate-400 leading-relaxed">
                            {loading 
                              ? "Querying live Solana pairs, analyzing liquidity, and performing contract safety checks." 
                              : "Try adjusting your Strategy Filters or search query to view more live tokens."}
                          </p>
                          {!loading && (
                            <button
                              onClick={() => { setFilters(DEFAULT_FILTERS); setSearchQuery(""); setSelectedTab("all"); }}
                              className="mt-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-semibold text-cyan-300 border border-cyan-500/30 transition-all"
                            >
                              Reset All Filters
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    rows.map((pair: any, idx: number) => {
                      const rowKey = pair.pairAddress || (pair.mintAddress ? `${pair.mintAddress}-${pair.quote || 'SOL'}-${idx}` : `${pair.symbol}-${idx}`);
                      const isExpanded = expanded === rowKey;
                      const checks = pair.checks || {};
                      const vs = VERDICT_STYLE[pair.verdict.status as keyof typeof VERDICT_STYLE] || VERDICT_STYLE.caution;

                      return (
                        <React.Fragment key={rowKey}>
                          <tr
                            onClick={() => setExpanded(isExpanded ? null : rowKey)}
                            className={cn(
                              "cursor-pointer transition-colors duration-150 hover:bg-white/[0.02] group select-none",
                              isExpanded && "bg-white/[0.03]"
                            )}
                          >
                            {/* Token / Pair */}
                            <td className="px-4 sm:px-6 py-4">
                              <div className="flex items-center gap-3">
                                <TokenAvatar symbol={pair.symbol} />
                                <div>
                                  <div className="font-bold text-white text-sm sm:text-base flex items-baseline gap-1.5">
                                    <span>{pair.symbol}</span>
                                    <span className="text-slate-500 font-medium text-xs">
                                      /{pair.quote || "SOL"}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-xs text-slate-400 font-medium truncate max-w-[140px] block">
                                      {pair.name || pair.symbol}
                                    </span>
                                    {pair.mintAddress && (
                                      <CopyButton text={pair.mintAddress} />
                                    )}
                                  </div>
                                </div>
                              </div>
                            </td>

                            {/* Market Cap */}
                            <td className="px-4 sm:px-6 py-4 text-right font-mono text-slate-200 text-sm sm:text-base font-semibold">
                              {fmtUsd(pair.marketCap || 0)}
                            </td>

                            {/* Liquidity */}
                            <td className="px-4 sm:px-6 py-4 text-right font-mono text-slate-200 text-sm sm:text-base font-semibold">
                              {fmtUsd(pair.liquidityUsd || 0)}
                            </td>

                            {/* 1h Change */}
                            <td className={cn(
                              "px-4 sm:px-6 py-4 text-right font-mono text-sm sm:text-base font-bold",
                              (pair.change1h || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                            )}>
                              <span className="inline-flex items-center justify-end gap-1">
                                <TrendingUp 
                                  size={13} 
                                  className={(pair.change1h || 0) < 0 ? "rotate-180" : ""} 
                                />
                                {(pair.change1h || 0) >= 0 ? "+" : ""}{pair.change1h || 0}%
                              </span>
                            </td>

                            {/* Age */}
                            <td className="px-4 sm:px-6 py-4 text-right font-mono text-slate-400 text-xs sm:text-sm">
                              {(pair.ageHours || 0).toFixed(1)}h
                            </td>

                            {/* Verdict */}
                            <td className="px-4 sm:px-6 py-4 text-center">
                              <VerdictBadge status={pair.verdict.status} />
                            </td>

                            {/* Chevron */}
                            <td className="px-4 sm:px-6 py-4 text-right">
                              <div className={cn(
                                "inline-flex p-1.5 rounded-lg transition-colors",
                                isExpanded ? "bg-cyan-500/10 text-cyan-400" : "text-slate-500 group-hover:text-white"
                              )}>
                                <ChevronDown 
                                  size={16} 
                                  className={cn("transition-transform duration-200", isExpanded && "rotate-180")} 
                                />
                              </div>
                            </td>
                          </tr>

                          {/* ── Expanded Detail Drawer ─────────────────────── */}
                          {isExpanded && (
                            <tr className="bg-slate-950/60 border-y border-white/[0.06]">
                              <td colSpan={7} className="px-4 sm:px-8 py-5">
                                <div className="space-y-4 animate-slide-down max-w-4xl">
                                  
                                  {/* Title & Quick Info */}
                                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/[0.06]">
                                    <div className="flex items-center gap-2">
                                      <Shield size={16} className="text-cyan-400" />
                                      <h4 className="text-xs font-bold tracking-widest text-slate-300 uppercase">
                                        Contract & Safety Audit
                                      </h4>
                                    </div>
                                    {pair.mintAddress && (
                                      <div className="flex items-center gap-2 text-xs font-mono text-slate-400 bg-black/40 px-3 py-1 rounded-lg border border-white/[0.06]">
                                        <span>Mint:</span>
                                        <span className="text-cyan-300">{pair.mintAddress.slice(0, 6)}...{pair.mintAddress.slice(-6)}</span>
                                        <CopyButton text={pair.mintAddress} />
                                      </div>
                                    )}
                                  </div>

                                  {/* Safety Checks Grid */}
                                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                    <div className="glass-card rounded-xl p-3 border border-white/[0.05]">
                                      <div className="text-[11px] text-slate-400 font-medium">Mint Authority</div>
                                      <div className={cn("text-xs font-bold mt-1 flex items-center gap-1.5", checks.mintRenounced ? "text-emerald-400" : "text-rose-400")}>
                                        <span className={cn("w-2 h-2 rounded-full", checks.mintRenounced ? "bg-emerald-400" : "bg-rose-400")} />
                                        {checks.mintRenounced ? "Renounced (Safe)" : "Active (Risk)"}
                                      </div>
                                    </div>

                                    <div className="glass-card rounded-xl p-3 border border-white/[0.05]">
                                      <div className="text-[11px] text-slate-400 font-medium">Freeze Authority</div>
                                      <div className={cn("text-xs font-bold mt-1 flex items-center gap-1.5", checks.freezeRenounced ? "text-emerald-400" : "text-rose-400")}>
                                        <span className={cn("w-2 h-2 rounded-full", checks.freezeRenounced ? "bg-emerald-400" : "bg-rose-400")} />
                                        {checks.freezeRenounced ? "Renounced (Safe)" : "Active (Risk)"}
                                      </div>
                                    </div>

                                    <div className="glass-card rounded-xl p-3 border border-white/[0.05]">
                                      <div className="text-[11px] text-slate-400 font-medium">Top 10 Holders</div>
                                      <div className={cn("text-xs font-bold mt-1", (checks.top10Pct ?? 0) <= 40 ? "text-emerald-400" : "text-rose-400")}>
                                        {checks.top10Pct ? `${checks.top10Pct}%` : "Normal"}
                                      </div>
                                    </div>

                                    <div className="glass-card rounded-xl p-3 border border-white/[0.05]">
                                      <div className="text-[11px] text-slate-400 font-medium">LP Lock Duration</div>
                                      <div className={cn("text-xs font-bold mt-1", (checks.lpLockDays ?? 0) >= 14 ? "text-emerald-400" : "text-rose-400")}>
                                        {checks.lpLockDays ? `${checks.lpLockDays} Days` : "Standard"}
                                      </div>
                                    </div>

                                    <div className="glass-card rounded-xl p-3 border border-white/[0.05]">
                                      <div className="text-[11px] text-slate-400 font-medium">Sell Price Impact</div>
                                      <div className={cn("text-xs font-bold mt-1", (checks.sellPriceImpactPct ?? 0) <= 15 ? "text-emerald-400" : "text-rose-400")}>
                                        {checks.sellPriceImpactPct ? `${checks.sellPriceImpactPct}%` : "Low"}
                                      </div>
                                    </div>

                                    <div className="glass-card rounded-xl p-3 border border-white/[0.05]">
                                      <div className="text-[11px] text-slate-400 font-medium">Honeypot Check</div>
                                      <div className={cn("text-xs font-bold mt-1", checks.sellable !== false ? "text-emerald-400" : "text-rose-400")}>
                                        {checks.sellable !== false ? "Sellable (Pass)" : "Honeypot (Fail)"}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Verdict Reasons Alert */}
                                  {pair.verdict?.reasons?.length > 0 && (
                                    <div className={cn("p-3 rounded-xl border flex items-start gap-2.5 text-xs", vs.bg, vs.border)}>
                                      <AlertCircle size={15} className={cn("shrink-0 mt-0.5", vs.text)} />
                                      <div>
                                        <span className={cn("font-bold uppercase tracking-wider", vs.text)}>
                                          {pair.verdict.status === "reject" ? "Hard Rejection:" : "Caution Triggered:"}
                                        </span>{" "}
                                        <span className="text-slate-300">
                                          {pair.verdict.reasons.join(" • ")}
                                        </span>
                                      </div>
                                    </div>
                                  )}

                                  {/* External Action Links */}
                                  <div className="flex flex-wrap items-center gap-2 pt-1">
                                    {pair.url && (
                                      <a
                                        href={pair.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold transition-all hover:scale-105 active:scale-95"
                                      >
                                        <span>Dexscreener</span>
                                        <ExternalLink size={12} />
                                      </a>
                                    )}

                                    {pair.mintAddress && (
                                      <>
                                        <a
                                          href={`https://rugcheck.xyz/tokens/${pair.mintAddress}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 text-xs font-semibold transition-all hover:scale-105 active:scale-95"
                                        >
                                          <span>RugCheck.xyz</span>
                                          <ExternalLink size={12} />
                                        </a>

                                        <a
                                          href={`https://solscan.io/token/${pair.mintAddress}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 text-xs font-semibold transition-all hover:scale-105 active:scale-95"
                                        >
                                          <span>Solscan</span>
                                          <ExternalLink size={12} />
                                        </a>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}