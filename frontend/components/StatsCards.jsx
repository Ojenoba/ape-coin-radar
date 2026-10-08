// src/components/StatsCards.jsx
const stats = [
  { label: "Total Tokens Scanned", value: "12,450", color: "text-blue-400" },
  { label: "Rug Pull Alerts", value: "320", color: "text-red-400" },
  { label: "Safe Tokens", value: "5,890", color: "text-green-400" },
];

export default function StatsCards() {
  return (
    <div className="grid grid-cols-3 gap-4 mt-6">
      {stats.map((s) => (
        <div key={s.label} className="bg-gray-800 p-4 rounded-lg text-center">
          <h2 className={`text-2xl font-bold ${s.color}`}>{s.value}</h2>
          <p className="text-gray-400">{s.label}</p>
        </div>
      ))}
    </div>
  );
}
