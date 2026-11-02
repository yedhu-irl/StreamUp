import React, { useState, useEffect } from 'react';
import { X, Settings, Key, Database, LogOut, CheckCircle2 } from 'lucide-react';
import { getStoredCredentials, saveStoredCredentials, clearStoredSession, db } from '../services/db';

interface SettingsModalProps {
  onClose: () => void;
  onLogout: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, onLogout }) => {
  const [apiId, setApiId] = useState<string>('');
  const [apiHash, setApiHash] = useState<string>('');
  const [tmdbKey, setTmdbKey] = useState<string>('');
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  useEffect(() => {
    async function load() {
      const creds = await getStoredCredentials();
      if (creds) {
        setApiId(creds.apiId.toString());
        setApiHash(creds.apiHash);
      }
      const customTmdb = localStorage.getItem('streamup_tmdb_key') || '';
      setTmdbKey(customTmdb);
    }
    load();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const idNum = parseInt(apiId.trim(), 10);
    const hash = apiHash.trim();

    if (!isNaN(idNum) && hash) {
      await saveStoredCredentials({ apiId: idNum, apiHash: hash });
    }

    if (tmdbKey.trim()) {
      localStorage.setItem('streamup_tmdb_key', tmdbKey.trim());
    } else {
      localStorage.removeItem('streamup_tmdb_key');
    }

    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const handleClearCache = async () => {
    if (confirm('Clear local video metadata and cache? Your connected Telegram channels will remain saved.')) {
      await db.videos.clear();
      await db.tmdbCache.clear();
      window.location.reload();
    }
  };

  const handleLogout = async () => {
    if (confirm('Sign out of your Telegram session on this device?')) {
      await clearStoredSession();
      onLogout();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/80 backdrop-blur-3xl animate-fade-in">
      <div className="relative w-full max-w-xl bg-[#121214]/95 border border-white/15 rounded-[32px] p-6 md:p-8 shadow-[0_25px_80px_rgba(0,0,0,0.9)] space-y-6">
        {/* Apple TV Close Button */}
        <button
          onClick={onClose}
          className="absolute top-6 right-6 w-11 h-11 rounded-full bg-black/60 hover:bg-white/20 active:scale-95 border border-white/15 text-white flex items-center justify-center transition-all focus:outline-none focus:ring-2 focus:ring-white"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-2xl bg-white text-black flex items-center justify-center shadow-md">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">Settings</h2>
            <p className="text-xs text-white/50">Manage credentials, TMDB metadata, and storage</p>
          </div>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-white/70 block">
              Telegram API ID
            </label>
            <input
              type="text"
              value={apiId}
              onChange={(e) => setApiId(e.target.value)}
              placeholder="e.g. 12345678"
              className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 text-sm text-white focus:outline-none focus:border-white transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-white/70 block">
              Telegram API Hash
            </label>
            <input
              type="password"
              value={apiHash}
              onChange={(e) => setApiHash(e.target.value)}
              placeholder="e.g. 0123456789abcdef..."
              className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 text-sm text-white focus:outline-none focus:border-white transition-all font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-white/70 block">
              Custom TMDB API Key (Optional)
            </label>
            <input
              type="password"
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.target.value)}
              placeholder="Leave blank to use default cinema key"
              className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 text-sm text-white focus:outline-none focus:border-white transition-all font-mono"
            />
          </div>

          <div className="pt-2 flex items-center space-x-3">
            <button
              type="submit"
              className="flex-1 py-3.5 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-sm shadow-xl transition-all"
            >
              Save Configuration
            </button>
            {savedSuccess && (
              <div className="flex items-center space-x-1.5 text-xs font-semibold text-emerald-400 animate-fade-in">
                <CheckCircle2 className="w-4 h-4" />
                <span>Saved</span>
              </div>
            )}
          </div>
        </form>

        {/* Storage & Session Section */}
        <div className="pt-4 border-t border-white/10 space-y-3">
          <button
            onClick={handleClearCache}
            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-white transition-all active:scale-98"
          >
            <div className="flex items-center space-x-3">
              <Database className="w-4 h-4 text-white/60" />
              <span>Purge Metadata &amp; Video Cache</span>
            </div>
            <span className="text-[11px] text-white/40">Free Storage</span>
          </button>

          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-xs font-semibold text-rose-400 transition-all active:scale-98"
          >
            <div className="flex items-center space-x-3">
              <LogOut className="w-4 h-4" />
              <span>Sign Out of Telegram MTProto</span>
            </div>
            <span className="text-[11px] text-rose-400/70">Disconnect</span>
          </button>
        </div>
      </div>
    </div>
  );
};
