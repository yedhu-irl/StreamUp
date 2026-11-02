import React, { useState, useEffect } from 'react';
import { 
  ArrowLeft,
  FolderPlus, 
  Radio, 
  Check, 
  RefreshCw, 
  Loader2, 
  Trash2,
  Eye,
  EyeOff,
  Sparkles,
  Film,
  Tv
} from 'lucide-react';
import type { ChannelCategory } from '../types';
import { fetchJoinedChannels, scanChannelVideos, autoSyncAllChannels } from '../services/telegram';
import { db, toggleChannelCategory } from '../services/db';

interface ChannelManagerModalProps {
  onClose: () => void;
  onChannelsUpdated: () => void;
}

export const ChannelManagerModal: React.FC<ChannelManagerModalProps> = ({
  onClose,
  onChannelsUpdated,
}) => {
  const [joinedChannels, setJoinedChannels] = useState<ChannelCategory[]>([]);
  const [savedChannels, setSavedChannels] = useState<ChannelCategory[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [scanningChannelId, setScanningChannelId] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [isSyncingAll, setIsSyncingAll] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [channelPendingAdd, setChannelPendingAdd] = useState<ChannelCategory | null>(null);

  // Filter State
  const [channelFilter, setChannelFilter] = useState<'all' | 'movies' | 'series' | 'available'>('all');

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

  useEffect(() => {
    loadChannels();
  }, []);

  const loadChannels = async () => {
    setIsLoading(true);
    try {
      const stored = await db.channels.toArray();
      setSavedChannels(stored);

      // fetchJoinedChannels excludes archived dialogs, normal groups, and user chats
      const telegramChannels = await fetchJoinedChannels();
      setJoinedChannels(telegramChannels);
    } catch (err) {
      console.error('Error fetching channels:', err);
    } finally {
      setIsLoading(false);
    }
  };

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
    setSyncStatus('Auto-syncing media across channels...');
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

  // Category counts
  const handlePurgeAllGroups = async () => {
    const joinedIds = new Set(joinedChannels.map((c) => c.id));
    const nonChannels = savedChannels.filter((s) => !joinedIds.has(s.id));
    if (nonChannels.length === 0) return;
    if (confirm(`Remove ${nonChannels.length} saved group(s) from StreamUp?`)) {
      for (const nc of nonChannels) {
        await db.channels.delete(nc.id);
        await db.videos.where('channelId').equals(nc.id).delete();
      }
      setSavedChannels((prev) => prev.filter((s) => joinedIds.has(s.id)));
      onChannelsUpdated();
    }
  };

  // Merge joined broadcast channels with any saved channels/groups in DB so nothing is ever trapped
  const allChannelsMap = new Map<string, ChannelCategory>();
  for (const ch of joinedChannels) {
    allChannelsMap.set(ch.id, ch);
  }
  for (const s of savedChannels) {
    if (!allChannelsMap.has(s.id)) {
      allChannelsMap.set(s.id, s);
    }
  }
  const combinedChannels = Array.from(allChannelsMap.values());
  const joinedIdsSet = new Set(joinedChannels.map((c) => c.id));
  const orphanedGroupsCount = savedChannels.filter((s) => !joinedIdsSet.has(s.id)).length;

  const moviesCount = savedChannels.filter((c) => c.contentType === 'movies').length;
  const seriesCount = savedChannels.filter((c) => c.contentType === 'series').length;
  const availableCount = combinedChannels.filter((c) => !savedChannels.some((s) => s.id === c.id)).length;

  // Filtered channel list
  const filteredChannels = combinedChannels.filter((ch) => {
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
          Manage Channels &amp; Shelves
        </span>

        <button
          onClick={handleSyncAll}
          disabled={isSyncingAll || savedChannels.length === 0}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-full bg-white hover:bg-white/90 active:scale-95 disabled:opacity-40 text-black text-xs font-semibold shadow-md transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncingAll ? 'animate-spin' : ''}`} />
          <span>{isSyncingAll ? 'Syncing...' : 'Sync All'}</span>
        </button>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-10 space-y-6">
        {/* Apple Grouped Header Container */}
        <div className="rounded-[32px] bg-[#161618]/80 border border-white/10 p-8 shadow-2xl backdrop-blur-3xl space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-4 pb-4 border-b border-white/[0.08]">
            <div className="flex items-center space-x-3">
              <div className="w-9 h-9 rounded-xl bg-white/[0.08] border border-white/10 flex items-center justify-center text-white">
                <FolderPlus className="w-5 h-5 text-white/90" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white tracking-tight">Active Telegram Channels</h3>
                <p className="text-xs text-white/45">Excludes archived chats, private groups, and person-to-person chats</p>
              </div>
            </div>
          </div>

          {orphanedGroupsCount > 0 && (
            <div className="flex items-center justify-between p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 gap-3">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-4 h-4 text-amber-400 flex-none" />
                <span>Found {orphanedGroupsCount} saved group(s) or legacy chats that cannot be auto-synced.</span>
              </div>
              <button
                onClick={handlePurgeAllGroups}
                className="px-3 py-1.5 rounded-full bg-amber-400 hover:bg-amber-300 text-black font-semibold text-xs transition-all active:scale-95 flex-none"
              >
                Remove All Groups
              </button>
            </div>
          )}

          {syncStatus && (
            <div className="flex items-center space-x-2 p-3.5 rounded-2xl bg-white/[0.05] border border-white/10 text-xs text-white/90">
              <Sparkles className="w-4 h-4 text-amber-400 flex-none" />
              <span>{syncStatus}</span>
            </div>
          )}

          {/* Apple Segmented Filter Tabs */}
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
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-16 text-white/50 space-y-3">
                <Loader2 className="w-7 h-7 text-white animate-spin" />
                <span className="text-xs font-medium">Fetching channels from Telegram MTProto...</span>
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
                    {/* Left: Broadcast Icon & Meta */}
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
                              !joinedIdsSet.has(ch.id)
                                ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                                : isEnabled 
                                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' 
                                : 'bg-white/10 border-white/10 text-white/40'
                            }`}>
                              <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                                !joinedIdsSet.has(ch.id)
                                  ? 'bg-amber-400'
                                  : isEnabled ? 'bg-emerald-400' : 'bg-white/40'
                              }`} />
                              {!joinedIdsSet.has(ch.id) ? 'Legacy Group' : isEnabled ? 'Active Shelf' : 'Hidden'}
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
