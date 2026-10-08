// src/components/Header.jsx
export default function Header() {
  return (
    <header className="flex justify-between items-center bg-gray-900 text-white px-6 py-4 shadow-lg">
      <div className="flex items-center space-x-3">
        <img src="/logo.png" alt="Ape Radar" className="w-8 h-8" />
        <h1 className="text-xl font-bold text-green-400">Ape Radar</h1>
      </div>
      <div className="flex items-center space-x-4">
        <button className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-md">
          Connect Wallet
        </button>
      </div>
    </header>
  );
}
