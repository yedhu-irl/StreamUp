import React, { useState, useEffect } from 'react';
import { 
  ArrowLeft, 
  LogOut, 
  User, 
  Radio, 
  FolderPlus, 
  Check, 
  RefreshCw, 
  Loader2, 
  Trash2, 
  Eye, 
  EyeOff, 
  Film, 
  Tv, 
  Settings, 
  Database, 
  Key, 
  CheckCircle2,
  Sparkles
} from 'lucide-react';
import type { ChannelCategory, TelegramUserProfile } from '../types';
import { 
  fetchJoinedChannels, 
  scanChannelVideos, 
  autoSyncAllChannels, 
  getTelegramUserProfile 
} from '../services/telegram';
import { 
  db, 
  toggleChannelCategory, 
  getStoredCredentials, 
  saveStoredCredentials, 
  clearStoredSession 
} from '../services/db';

interface ProfileScreenProps {
  onClose: () => void;
  onLogout: () => void;
  onChannelsUpdated: () => void;
}

export const ProfileScreen: React.FC<ProfileScreenProps> = ({
  onClose,
  onLogout,
  onChannelsUpdated,
}) => {
  // Profile State
  const [userProfile, setUserProfile] = useState<TelegramUserProfile | null>(null);

  // Channels State
  const [joinedChannels, setJoinedChannels] = useState<ChannelCategory[]>([]);
  const [savedChannels, setSavedChannels] = useState<ChannelCategory[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState<boolean>(true);
  const [scanningChannelId, setScanningChannelId] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [isSyncingAll, setIsSyncingAll] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  // Filter State
  const [channelFilter, setChannelFilter] = useState<'all' | 'movies' | 'series' | 'available'>('all');

  // Channel Category Pick Modal / Selector state
  const [channelPendingAdd, setChannelPendingAdd] = useState<ChannelCategory | null>(null);

  // Settings State
  const [apiId, setApiId] = useState<string>('');
  const [apiHash, setApiHash] = useState<string>('');
  const [tmdbKey, setTmdbKey] = useState<string>('');
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  // Esc key for back
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Back') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Load User, Channels, and Settings
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoadingChannels(true);
    try {
      // 1. User Profile
      const prof = await getTelegramUserProfile();
      setUserProfile(prof);

      // 2. Saved Channels in DB
      const stored = await db.channels.toArray();
      setSavedChannels(stored);

      // 3. Telegram Joined Channels (archived & groups filtered out)
      const telegramChannels = await fetchJoinedChannels();
      setJoinedChannels(telegramChannels);

      // 4. Settings Credentials
      const creds = await getStoredCredentials();
      if (creds) {
        setApiId(creds.apiId.toString());
        setApiHash(creds.apiHash);
      }
      const customTmdb = localStorage.getItem('streamup_tmdb_key') || '';
      setTmdbKey(customTmdb);
    } catch (e) {
      console.warn('Profile screen data load error:', e);
    } finally {
      setIsLoadingChannels(false);
    }
  };

  // Channel Addition with Category (Movies vs Series)
  const handleConfirmAddChannel = async (contentType: 'movies' | 'series' | 'all') => {
    if (!channelPendingAdd) return;

    const newChan: ChannelCategory = {
      ...channelPendingAdd,
      enabled: true,
      contentType,
    };

    await db.channels.put(newChan);
    setSavedChannels((prev) => [...prev.filter((c) => c.id !== newChan.id), newChan]);
    setChannelPendingAdd(null);
    onChannelsUpdated();

    // Trigger video scan
    handleScanChannel(newChan.id);
  };

  const handleUpdateChannelContentType = async (
    channelId: string,
    newType: 'movies' | 'series' | 'all'
  ) => {
    const ch = await db.channels.get(channelId);
    if (ch) {
      ch.contentType = newType;
      await db.channels.put(ch);
      setSavedChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, contentType: newType } : c))
      );
      onChannelsUpdated();
    }
  };

  const handleToggleChannelEnabled = async (channelId: string, currentEnabled: boolean) => {
    const nextState = !currentEnabled;
    await toggleChannelCategory(channelId, nextState);
    setSavedChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, enabled: nextState } : c))
    );
    onChannelsUpdated();
  };

  const handleRemoveChannel = async (channelId: string) => {
    if (confirm('Remove this channel from StreamUp?')) {
      await db.channels.delete(channelId);
      await db.videos.where('channelId').equals(channelId).delete();
      setSavedChannels((prev) => prev.filter((c) => c.id !== channelId));
      onChannelsUpdated();
    }
  };

  const handleScanChannel = async (channelId: string) => {
    setScanningChannelId(channelId);
    setScanProgress(0);

    try {
      const videos = await scanChannelVideos(channelId, (count) => {
        setScanProgress(count);
      });

      await db.videos.bulkPut(videos);

      const ch = await db.channels.get(channelId);
      if (ch) {
        ch.lastScanned = Date.now();
        ch.videoCount = videos.length;
        await db.channels.put(ch);
      }

      onChannelsUpdated();
    } catch (err) {
      console.error('Failed to scan videos in channel:', err);
    } finally {
      setScanningChannelId(null);
    }
  };

  const handleSyncAll = async () => {
    setIsSyncingAll(true);
    setSyncStatus('Auto-syncing media across all channels...');
    try {
      const total = await autoSyncAllChannels((title, count) => {
        setSyncStatus(`Synced ${title}: ${count} videos`);
      });
      setSyncStatus(`Sync complete! ${total} total videos indexed.`);
      const updated = await db.channels.toArray();
      setSavedChannels(updated);
      onChannelsUpdated();
      setTimeout(() => setSyncStatus(null), 3000);
    } catch (e: any) {
      setSyncStatus(`Sync error: ${e.message}`);
    } finally {
      setIsSyncingAll(false);
    }
  };

  // Settings Save
  const handleSaveSettings = async (e: React.FormEvent) => {
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
    if (confirm('Clear local video metadata and TMDB posters cache? Your connected Telegram channels remain saved.')) {
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

  const userInitial = userProfile?.firstName
    ? userProfile.firstName.charAt(0).toUpperCase()
    : 'U';

  // Category counts
  const moviesCount = savedChannels.filter((c) => c.contentType === 'movies').length;
  const seriesCount = savedChannels.filter((c) => c.contentType === 'series').length;
  const availableCount = joinedChannels.filter((c) => !savedChannels.some((s) => s.id === c.id)).length;

  // Filtered channel list
  const filteredChannels = joinedChannels.filter((ch) => {
    const saved = savedChannels.find((s) => s.id === ch.id);
    if (channelFilter === 'movies') return saved?.contentType === 'movies';
    if (channelFilter === 'series') return saved?.contentType === 'series';
    if (channelFilter === 'available') return !saved;
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black text-white overflow-y-auto animate-fade-in select-none no-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
      {/* Apple-style Top Navigation Bar */}
      <div className="sticky top-0 left-0 right-0 z-50 h-20 px-6 md:px-12 flex items-center justify-between backdrop-blur-3xl bg-black/80 border-b border-white/10 transition-all">
        <button
          onClick={onClose}
          className="flex items-center space-x-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 text-white font-medium text-xs backdrop-blur-2xl transition-all focus:outline-none focus:ring-2 focus:ring-white"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>

        <span className="font-semibold text-sm text-white/90 tracking-tight">
          Account &amp; Settings
        </span>

        <button
          onClick={handleLogout}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-full bg-rose-500/10 hover:bg-rose-500/20 active:scale-95 border border-rose-500/20 text-rose-300 font-semibold text-xs transition-all"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sign Out</span>
        </button>
      </div>

      {/* Main Container */}
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-10">
        {/* 1. Telegram Account Profile Card (Apple Inset Style) */}
        <div className="relative overflow-hidden rounded-[32px] bg-gradient-to-b from-[#1c1c1f]/90 to-[#121214]/90 border border-white/10 p-8 shadow-2xl backdrop-blur-3xl">
          <div className="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-6">
            <div className="flex flex-col sm:flex-row items-center space-y-4 sm:space-y-0 sm:space-x-6 text-center sm:text-left">
              {/* Avatar with Glow and Badge */}
              <div className="relative flex-none">
                <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-white/20 to-white/5 border border-white/20 flex items-center justify-center text-2xl font-bold text-white shadow-2xl overflow-hidden ring-4 ring-white/5">
                  {userProfile?.photoUrl ? (
                    <img
                      src={userProfile.photoUrl}
                      alt={userProfile.firstName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    userInitial
                  )}
                </div>
                <span className="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-emerald-500 border-2 border-black ring-2 ring-emerald-500/20 flex items-center justify-center">
                  <Check className="w-3 h-3 text-black stroke-[3]" />
                </span>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-center sm:justify-start space-x-2.5">
                  <h2 className="text-2xl font-bold text-white tracking-tight">
                    {userProfile?.firstName} {userProfile?.lastName || ''}
                  </h2>
                </div>

                <div className="flex items-center justify-center sm:justify-start space-x-2 text-xs text-white/60">
                  {userProfile?.username && (
                    <span className="font-mono text-white/70">@{userProfile.username}</span>
                  )}
                  {userProfile?.phone && (
                    <>
                      <span className="text-white/30">&bull;</span>
                      <span className="font-mono text-white/50">+{userProfile.phone}</span>
                    </>
                  )}
                </div>

                <p className="text-[11px] text-emerald-400 font-medium pt-0.5">
                  Connected via Telegram MTProto Protocol
                </p>
              </div>
            </div>

            <button
              onClick={handleLogout}
              className="flex items-center space-x-2 px-4 py-2 rounded-full bg-white/[0.08] hover:bg-rose-500/20 active:scale-95 border border-white/10 hover:border-rose-500/30 text-white/80 hover:text-rose-300 font-medium text-xs transition-all self-center sm:self-auto"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>

        {/* 2. Channels & Shelves Management Pod (Apple macOS Settings Table Style) */}
        <div className="rounded-[32px] bg-[#161618]/80 border border-white/10 p-8 shadow-2xl backdrop-blur-3xl space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-4 pb-4 border-b border-white/[0.08]">
            <div className="flex items-center space-x-3">
              <div className="w-9 h-9 rounded-xl bg-white/[0.08] border border-white/10 flex items-center justify-center text-white">
                <FolderPlus className="w-5 h-5 text-white/90" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white tracking-tight">Channel Shelves &amp; Categories</h3>
                <p className="text-xs text-white/45">Organize broadcast channels into Movies or TV Series</p>
              </div>
            </div>

            <button
              onClick={handleSyncAll}
              disabled={isSyncingAll || savedChannels.length === 0}
              className="flex items-center space-x-1.5 px-4 py-2 rounded-full bg-white hover:bg-white/90 active:scale-95 disabled:opacity-40 text-black text-xs font-semibold shadow-md transition-all"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingAll ? 'animate-spin' : ''}`} />
              <span>{isSyncingAll ? 'Syncing...' : 'Sync All Channels'}</span>
            </button>
          </div>

          {syncStatus && (
            <div className="flex items-center space-x-2 p-3.5 rounded-2xl bg-white/[0.05] border border-white/10 text-xs text-white/90">
              <Sparkles className="w-4 h-4 text-amber-400 flex-none" />
              <span>{syncStatus}</span>
            </div>
          )}

          {/* Apple Segmented Filter Control */}
          <div className="flex items-center space-x-1 bg-white/[0.06] p-1 rounded-full border border-white/10 text-xs overflow-x-auto no-scrollbar">
            <button
              onClick={() => setChannelFilter('all')}
              className={`px-4 py-1.5 rounded-full font-medium transition-all ${
                channelFilter === 'all'
                  ? 'bg-white text-black font-semibold shadow-sm'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              All ({joinedChannels.length})
            </button>
            <button
              onClick={() => setChannelFilter('movies')}
              className={`px-4 py-1.5 rounded-full font-medium transition-all ${
                channelFilter === 'movies'
                  ? 'bg-white text-black font-semibold shadow-sm'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              Movies ({moviesCount})
            </button>
            <button
              onClick={() => setChannelFilter('series')}
              className={`px-4 py-1.5 rounded-full font-medium transition-all ${
                channelFilter === 'series'
                  ? 'bg-white text-black font-semibold shadow-sm'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              Series ({seriesCount})
            </button>
            <button
              onClick={() => setChannelFilter('available')}
              className={`px-4 py-1.5 rounded-full font-medium transition-all ${
                channelFilter === 'available'
                  ? 'bg-white text-black font-semibold shadow-sm'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              Available ({availableCount})
            </button>
          </div>

          {/* Inset Grouped Channel Rows */}
          <div className="rounded-2xl bg-white/[0.03] border border-white/[0.08] divide-y divide-white/[0.06] overflow-hidden shadow-inner">
            {isLoadingChannels ? (
              <div className="flex flex-col items-center justify-center py-16 text-white/50 space-y-3">
                <Loader2 className="w-7 h-7 text-white animate-spin" />
                <span className="text-xs font-medium">Loading joined Telegram channels...</span>
              </div>
            ) : filteredChannels.length === 0 ? (
              <div className="text-center py-14 text-white/40 text-xs">
                No channels found in this category view.
              </div>
            ) : (
              filteredChannels.map((ch) => {
                const savedItem = savedChannels.find((s) => s.id === ch.id);
                const isAdded = !!savedItem;
                const isEnabled = savedItem?.enabled !== false;
                const isScanning = scanningChannelId === ch.id;
                const currentType = savedItem?.contentType || 'all';

                return (
                  <div
                    key={ch.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between p-4 sm:p-5 hover:bg-white/[0.03] transition-colors gap-4"
                  >
                    {/* Left: Icon & Channel Meta */}
                    <div className="flex items-center space-x-3.5 min-w-0">
                      <div className="w-11 h-11 rounded-2xl bg-white/[0.08] border border-white/10 flex items-center justify-center flex-none text-white/80 shadow-inner">
                        <Radio className="w-5 h-5 text-white/90" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center space-x-2">
                          <h4 className="font-semibold text-sm text-white tracking-tight truncate">
                            {ch.title}
                          </h4>
                          {isAdded && (
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                              isEnabled 
                                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' 
                                : 'bg-white/10 border-white/10 text-white/40'
                            }`}>
                              <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${isEnabled ? 'bg-emerald-400' : 'bg-white/40'}`} />
                              {isEnabled ? 'Active Shelf' : 'Hidden'}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-white/45 truncate mt-0.5 font-mono">
                          {ch.username ? `@${ch.username}` : `ID: ${ch.id}`}
                          {savedItem?.videoCount !== undefined && (
                            <span className="font-sans text-white/50"> &bull; {savedItem.videoCount} media indexed</span>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* Right: Actions and Apple Segmented Category Switcher */}
                    <div className="flex items-center flex-wrap gap-2.5 justify-end flex-none">
                      {isAdded ? (
                        <>
                          {/* Segmented Category Pill [ Movies | Series ] */}
                          <div className="flex items-center p-1 bg-white/[0.06] rounded-full border border-white/10">
                            <button
                              onClick={() => handleUpdateChannelContentType(ch.id, 'movies')}
                              className={`flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                                currentType === 'movies'
                                  ? 'bg-white text-black font-semibold shadow-sm'
                                  : 'text-white/60 hover:text-white'
                              }`}
                              title="Set as Movies shelf"
                            >
                              <Film className="w-3 h-3" />
                              <span>Movies</span>
                            </button>
                            <button
                              onClick={() => handleUpdateChannelContentType(ch.id, 'series')}
                              className={`flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                                currentType === 'series'
                                  ? 'bg-white text-black font-semibold shadow-sm'
                                  : 'text-white/60 hover:text-white'
                              }`}
                              title="Set as TV Series shelf"
                            >
                              <Tv className="w-3 h-3" />
                              <span>Series</span>
                            </button>
                          </div>

                          {/* Toggle Active / Hidden */}
                          <button
                            onClick={() => handleToggleChannelEnabled(ch.id, isEnabled)}
                            className={`w-8 h-8 rounded-full border flex items-center justify-center transition-all active:scale-95 ${
                              isEnabled 
                                ? 'bg-white/[0.08] border-white/15 text-white hover:bg-white/[0.14]' 
                                : 'bg-white/[0.04] border-white/10 text-white/40 hover:text-white'
                            }`}
                            title={isEnabled ? 'Hide channel shelf' : 'Show channel shelf'}
                          >
                            {isEnabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                          </button>

                          {/* Scan Channel */}
                          <button
                            onClick={() => handleScanChannel(ch.id)}
                            disabled={isScanning}
                            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-white/[0.08] hover:bg-white/[0.14] border border-white/10 text-xs font-medium text-white transition-all active:scale-95"
                            title="Rescan Telegram videos"
                          >
                            <RefreshCw className={`w-3 h-3 ${isScanning ? 'animate-spin' : ''}`} />
                            <span>{isScanning ? `${scanProgress}` : 'Scan'}</span>
                          </button>

                          {/* Remove Channel */}
                          <button
                            onClick={() => handleRemoveChannel(ch.id)}
                            className="w-8 h-8 rounded-full bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 flex items-center justify-center transition-all active:scale-95"
                            title="Remove from StreamUp"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setChannelPendingAdd(ch)}
                          className="flex items-center space-x-1.5 px-4 py-2 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black text-xs font-semibold shadow-md transition-all"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Add Channel</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 3. Settings & API Configuration Pod (Apple Inset Style) */}
        <div className="rounded-[32px] bg-[#161618]/80 border border-white/10 p-8 shadow-2xl backdrop-blur-3xl space-y-6">
          <div className="flex items-center space-x-3 pb-4 border-b border-white/[0.08]">
            <div className="w-9 h-9 rounded-xl bg-white/[0.08] border border-white/10 flex items-center justify-center text-white">
              <Settings className="w-5 h-5 text-white/90" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">System Settings &amp; API Keys</h3>
              <p className="text-xs text-white/45">Configure Telegram MTProto client credentials and TMDB metadata</p>
            </div>
          </div>

          <form onSubmit={handleSaveSettings} className="space-y-6">
            {/* Inset Grouped Form Container */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.08] divide-y divide-white/[0.06] overflow-hidden">
              <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="text-xs font-semibold text-white/80 sm:w-1/3">
                  Telegram API ID
                </label>
                <input
                  type="text"
                  value={apiId}
                  onChange={(e) => setApiId(e.target.value)}
                  placeholder="e.g. 12345678"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-xs sm:text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white transition-all font-mono"
                />
              </div>

              <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="text-xs font-semibold text-white/80 sm:w-1/3">
                  Telegram API Hash
                </label>
                <input
                  type="text"
                  value={apiHash}
                  onChange={(e) => setApiHash(e.target.value)}
                  placeholder="e.g. 0123456789abcdef0123456789abcdef"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-xs sm:text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white transition-all font-mono"
                />
              </div>

              <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="text-xs font-semibold text-white/80 sm:w-1/3">
                  TMDB API Key (Optional)
                </label>
                <input
                  type="text"
                  value={tmdbKey}
                  onChange={(e) => setTmdbKey(e.target.value)}
                  placeholder="Leave empty for built-in community key"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-xs sm:text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white transition-all font-mono"
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
              <button
                type="submit"
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-6 py-3 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-xs shadow-lg transition-all"
              >
                {savedSuccess ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Settings Saved!</span>
                  </>
                ) : (
                  <span>Save Configuration</span>
                )}
              </button>

              <button
                type="button"
                onClick={handleClearCache}
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-4 py-2.5 rounded-full bg-white/[0.06] hover:bg-white/[0.12] active:scale-95 border border-white/10 text-white/70 hover:text-white text-xs font-medium transition-all"
              >
                <Database className="w-3.5 h-3.5" />
                <span>Clear Local Media Cache</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Apple Sheet Style Category Selection Modal */}
      {channelPendingAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-3xl animate-fade-in">
          <div className="max-w-md w-full p-8 rounded-[32px] bg-[#1a1a1c]/95 border border-white/15 shadow-2xl space-y-6 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white text-black flex items-center justify-center mx-auto shadow-xl">
              <Radio className="w-7 h-7" />
            </div>

            <div className="space-y-1.5">
              <h3 className="text-xl font-bold text-white tracking-tight">
                Add Channel
              </h3>
              <p className="text-sm font-medium text-white/90 truncate">
                {channelPendingAdd.title}
              </p>
              <p className="text-xs text-white/50 leading-relaxed pt-1">
                Assign this channel to organize content into Movies or TV Series:
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 pt-2">
              <button
                onClick={() => handleConfirmAddChannel('movies')}
                className="flex items-center justify-between p-4 rounded-2xl bg-white/[0.06] hover:bg-white hover:text-black border border-white/10 transition-all text-left group"
              >
                <div className="flex items-center space-x-3.5">
                  <div className="w-10 h-10 rounded-xl bg-white/10 group-hover:bg-black/10 flex items-center justify-center flex-none">
                    <Film className="w-5 h-5 text-white group-hover:text-black" />
                  </div>
                  <div>
                    <span className="font-bold text-sm block">Movies Channel</span>
                    <span className="text-[11px] text-white/50 group-hover:text-black/70">
                      Feature films, standalone releases
                    </span>
                  </div>
                </div>
                <Check className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button
                onClick={() => handleConfirmAddChannel('series')}
                className="flex items-center justify-between p-4 rounded-2xl bg-white/[0.06] hover:bg-white hover:text-black border border-white/10 transition-all text-left group"
              >
                <div className="flex items-center space-x-3.5">
                  <div className="w-10 h-10 rounded-xl bg-white/10 group-hover:bg-black/10 flex items-center justify-center flex-none">
                    <Tv className="w-5 h-5 text-white group-hover:text-black" />
                  </div>
                  <div>
                    <span className="font-bold text-sm block">TV Series Channel</span>
                    <span className="text-[11px] text-white/50 group-hover:text-black/70">
                      Shows, seasons, episodic releases
                    </span>
                  </div>
                </div>
                <Check className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button
                onClick={() => handleConfirmAddChannel('all')}
                className="flex items-center justify-between p-3.5 rounded-2xl bg-white/[0.02] hover:bg-white/[0.08] border border-white/[0.06] text-white/60 hover:text-white transition-all text-left text-xs"
              >
                <span>Mixed Content (Both Movies &amp; Series)</span>
              </button>
            </div>

            <button
              onClick={() => setChannelPendingAdd(null)}
              className="text-xs font-semibold text-white/40 hover:text-white pt-2 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
