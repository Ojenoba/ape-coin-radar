// src/components/TokenCard.jsx
export default function TokenCard({ name, verdict, marketCap, liquidity }) {
  const verdictColors = {
    Safe: "bg-green-500",
    Caution: "bg-yellow-500",
    "Rug Pull": "bg-red-500",
  };

  return (
    <div className="bg-gray-800 p-4 rounded-lg shadow-md hover:scale-105 transition">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-white font-semibold">{name}</h3>
        <span className={`text-white text-sm px-2 py-1 rounded ${verdictColors[verdict]}`}>
          {verdict}
        </span>
      </div>
      <p className="text-gray-400">Market Cap: {marketCap}</p>
      <p className="text-gray-400">Liquidity: {liquidity}</p>
    </div>
  );
}
