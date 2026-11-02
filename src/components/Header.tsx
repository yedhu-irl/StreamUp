import React from 'react';
import { Film, Search, FolderPlus, Bookmark, User } from 'lucide-react';
import type { TelegramUserProfile } from '../types';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onOpenSearch: () => void;
  onOpenProfile: () => void;
  onOpenChannelManager: () => void;
  isLoggedIn: boolean;
  userProfile?: TelegramUserProfile | null;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  onOpenSearch,
  onOpenProfile,
  onOpenChannelManager,
  isLoggedIn,
  userProfile,
}) => {
  const tabs = [
    { id: 'all', label: 'Home' },
    { id: 'movies', label: 'Movies' },
    { id: 'series', label: 'TV Shows' },
    { id: 'activity', label: 'My Activity', icon: Bookmark },
  ];

  const userInitial = userProfile?.firstName
    ? userProfile.firstName.charAt(0).toUpperCase()
    : 'U';

  return (
    <header className="fixed top-0 left-0 right-0 z-40 h-20 px-6 md:px-10 flex items-center justify-between backdrop-blur-3xl bg-black/60 border-b border-white/10 transition-all duration-300">
      {/* Brand Logo - Apple TV Style */}
      <div className="flex items-center space-x-8">
        <div 
          onClick={() => setActiveTab('all')} 
          className="flex items-center space-x-2.5 cursor-pointer group active:scale-97 transition-transform"
        >
          <div className="w-10 h-10 rounded-2xl bg-white text-black flex items-center justify-center shadow-[0_0_20px_rgba(255,255,255,0.25)] group-hover:scale-105 transition-transform duration-200">
            <Film className="w-5 h-5 fill-black" />
          </div>
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-xl tracking-tight text-white">
              StreamUp
            </span>
          </div>
        </div>

        {/* Apple TV Segmented Nav Capsule */}
        <nav className="hidden md:flex items-center space-x-1 bg-white/10 backdrop-blur-2xl p-1 rounded-full border border-white/10 shadow-inner">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id || (tab.id === 'activity' && activeTab === 'mylist');
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-5 py-1.5 rounded-full text-xs font-semibold tracking-tight transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-white active:scale-95 ${
                  isActive
                    ? 'bg-white text-black shadow-md'
                    : 'text-white/70 hover:text-white hover:bg-white/10'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Right Action Icons - Apple Glass Circles */}
      <div className="flex items-center space-x-3">
        {/* Manage Channels Button */}
        <button
          onClick={onOpenChannelManager}
          className="flex items-center space-x-2 px-3.5 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 text-xs font-semibold text-white/90 hover:text-white transition-all focus:outline-none focus:ring-2 focus:ring-white"
          title="Manage Telegram Channels"
        >
          <FolderPlus className="w-4 h-4" />
          <span className="hidden sm:inline">Channels</span>
        </button>

        {/* Search Button */}
        <button
          onClick={onOpenSearch}
          className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 text-white/90 hover:text-white flex items-center justify-center transition-all focus:outline-none focus:ring-2 focus:ring-white"
          title="Search"
        >
          <Search className="w-4 h-4" />
        </button>

        {/* Telegram Profile Avatar Button */}
        <button
          onClick={onOpenProfile}
          className="relative flex items-center space-x-2 h-10 pl-1 pr-3 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/15 text-white transition-all focus:outline-none focus:ring-2 focus:ring-white"
          title="Telegram Profile & Settings"
        >
          {userProfile?.photoUrl ? (
            <img
              src={userProfile.photoUrl}
              alt={userProfile.firstName}
              className="w-8 h-8 rounded-full object-cover border border-white/20"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold text-white border border-white/20 shadow-inner">
              {isLoggedIn ? userInitial : <User className="w-4 h-4 text-white/70" />}
            </div>
          )}

          <div className="hidden sm:flex flex-col text-left text-xs leading-none">
            <span className="font-semibold text-white/90 truncate max-w-[90px]">
              {userProfile?.firstName || (isLoggedIn ? 'Account' : 'Sign In')}
            </span>
            <span className="text-[10px] text-white/50 mt-0.5">
              {isLoggedIn ? 'Connected' : 'Offline'}
            </span>
          </div>

          {/* MTProto Status indicator */}
          <span
            className={`w-2 h-2 rounded-full flex-none ${
              isLoggedIn
                ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                : 'bg-rose-500'
            }`}
          />
        </button>
      </div>
    </header>
  );
};
