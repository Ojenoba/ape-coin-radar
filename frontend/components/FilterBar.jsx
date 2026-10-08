// src/components/FilterBar.jsx
export default function FilterBar() {
  return (
    <div className="flex space-x-3 bg-gray-800 p-4 rounded-md">
      <select className="bg-gray-700 text-white px-3 py-2 rounded-md">
        <option>All Verdicts</option>
        <option>Safe</option>
        <option>Caution</option>
        <option>Rug Pull</option>
      </select>
      <input
        type="text"
        placeholder="Search tokens..."
        className="flex-1 bg-gray-700 text-white px-3 py-2 rounded-md"
      />
      <button className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-md">
        Scan
      </button>
    </div>
  );
}
