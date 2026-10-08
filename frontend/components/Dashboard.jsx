// src/pages/Dashboard.jsx
import Header from "../components/Header";
import FilterBar from "../components/FilterBar";
import StatsCards from "../components/StatsCards";
import TokenCard from "../components/TokenCard";

export default function Dashboard() {
  const tokens = [
    { name: "BananaCoin (BAN)", verdict: "Safe", marketCap: "$2.5M", liquidity: "$1.2M" },
    { name: "ScamToken (SCM)", verdict: "Rug Pull", marketCap: "$500K", liquidity: "$120K" },
    { name: "ApeSwap (APE)", verdict: "Caution", marketCap: "$8.3M", liquidity: "$3.5M" },
    { name: "SolMoon (SLM)", verdict: "Safe", marketCap: "$4.1M", liquidity: "$2.1M" },
  ];

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <Header />
      <FilterBar />
      <StatsCards />
      <div className="grid grid-cols-2 gap-4 mt-6">
        {tokens.map((t) => (
          <TokenCard key={t.name} {...t} />
        ))}
      </div>
    </div>
  );
}
