import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, ChevronRight, ExternalLink } from 'lucide-react';
import { useAppStore } from '../store';
import { getMemoryStats, MemoryStats, getAllPersonaProfiles, generateGovernorReport, generateUserSummary } from '../hooks/useTauri';
import { PersonaProfile } from '../types';
import governorImage from '../assets/governor-transparent.png';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenApiModal?: () => void;
}

interface ExpandedItem {
  type: 'pattern' | 'theme';
  key: string;
}

type TabType = 'overview' | 'profiles' | 'patterns' | 'vibe';

export function ReportModal({ isOpen, onClose, onOpenApiModal }: ReportModalProps) {
  const { userProfile, agentModes } = useAppStore();
  const activeAgentCount = Object.values(agentModes).filter(m => m !== 'off').length;
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  const [overallReport, setOverallReport] = useState<string>('');
  const [profileReports, setProfileReports] = useState<{id: string; name: string; report: string; dominantTrait: string}[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expandedItem, setExpandedItem] = useState<ExpandedItem | null>(null);
  const [itemSummary, setItemSummary] = useState<string>('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [allProfiles, setAllProfiles] = useState<PersonaProfile[]>([]);
  const [lastKnownMessageCount, setLastKnownMessageCount] = useState<number>(0);
  const [lastKnownFactCount, setLastKnownFactCount] = useState<number>(0);
  const [userSummary, setUserSummary] = useState<string>('');

  // Fetch profiles and generate report when modal opens (only if data changed)
  useEffect(() => {
    if (isOpen) {
      checkAndRefreshReport();
    } else {
      // Reset expanded state when closing, but keep report cached
      setExpandedItem(null);
      setItemSummary('');
    }
  }, [isOpen]);

  // Keyboard shortcuts for tabs (⌘1-4)
  useEffect(() => {
    if (!isOpen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey) {
        const tabs: TabType[] = ['overview', 'profiles', 'patterns', 'vibe'];
        const keyNum = parseInt(e.key);
        if (keyNum >= 1 && keyNum <= 4) {
          e.preventDefault();
          setActiveTab(tabs[keyNum - 1]);
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const checkAndRefreshReport = async () => {
    try {
      // First, fetch current stats to check if we need to regenerate
      const currentStats = await getMemoryStats();
      const profiles = await getAllPersonaProfiles();
      setAllProfiles(profiles);
      
      const currentTotalMessages = profiles.reduce((sum, p) => sum + p.messageCount, 0);
      const currentFactCount = currentStats.factCount;
      
      // Check if data has changed since last report
      const hasNewData = currentTotalMessages !== lastKnownMessageCount || 
                         currentFactCount !== lastKnownFactCount ||
                         !overallReport; // Also regenerate if we don't have a report yet
      
      if (hasNewData) {
        // Data changed, regenerate report
        setLastKnownMessageCount(currentTotalMessages);
        setLastKnownFactCount(currentFactCount);
        generateAllReports(profiles, currentStats);
      } else {
        // No changes, just update the profiles list without regenerating
        setMemoryStats(currentStats);
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
      // On error, try to generate anyway
      fetchProfilesAndGenerateReport();
    }
  };

  const fetchProfilesAndGenerateReport = async () => {
    try {
      const profiles = await getAllPersonaProfiles();
      setAllProfiles(profiles);
      const stats = await getMemoryStats();
      generateAllReports(profiles, stats);
    } catch (err) {
      console.error('Failed to fetch profiles:', err);
      generateAllReports([], null);
    }
  };

  const generateAllReports = async (profiles: PersonaProfile[], stats: MemoryStats | null) => {
    setIsGenerating(true);
    setOverallReport('');
    setProfileReports([]);
    setUserSummary('');

    try {
      if (stats) {
        setMemoryStats(stats);
      } else {
        const fetchedStats = await getMemoryStats();
        setMemoryStats(fetchedStats);
      }
      setLastUpdated(new Date());

      // Generate overall report using LLM (Sonnet, non-thinking)
      const overall = await generateGovernorReport();
      
      // Generate individual profile reports using LLM
      const individual = await Promise.all(profiles.map(async (profile) => ({
        id: profile.id,
        name: profile.name,
        report: await generateGovernorReport(profile.id),
        dominantTrait: profile.dominantTrait,
      })));
      
      // Generate 3-sentence user summary
      const summary = await generateUserSummary();
      
      setOverallReport(overall);
      setProfileReports(individual);
      setUserSummary(summary);
    } catch (err) {
      console.error('Failed to generate reports:', err);
      setOverallReport("Something went wrong generating the report. Try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  // Generate summary for a pattern or theme
  const handleItemClick = async (type: 'pattern' | 'theme', key: string, content: string) => {
    const itemKey = `${type}-${key}`;
    
    if (expandedItem?.key === itemKey) {
      setExpandedItem(null);
      setItemSummary('');
      return;
    }

    setExpandedItem({ type, key: itemKey });
    setIsSummarizing(true);
    setItemSummary('');

    // Generate a contextual summary
    await new Promise(resolve => setTimeout(resolve, 800));

    let summary = '';
    if (type === 'pattern') {
      // Pattern summaries
      const patternLower = content.toLowerCase();
      if (patternLower.includes('anxiety') || patternLower.includes('stress')) {
        summary = `This pattern has surfaced multiple times. It suggests this is something you're actively working through, not just a passing topic. The agents can help you explore it from different angles — Puff for the emotional depth, Dot for practical strategies, Snap for cutting through overthinking.`;
      } else if (patternLower.includes('decision') || patternLower.includes('choice')) {
        summary = `You seem to be navigating decisions actively. This pattern indicates you're not just thinking about choices abstractly — you're facing real ones. Consider which agent's perspective helps you most when the stakes feel high.`;
      } else {
        summary = `This pattern emerged from repeated signals in our conversations. It's not something I assigned — it's something you showed me through consistent behavior or focus.`;
      }
    } else {
      // Theme summaries
      summary = `"${content}" keeps coming up in our conversations. This isn't random — recurring themes usually reflect what's actively on your mind, whether you're aware of it or not. It might be worth asking yourself why this topic pulls your attention.`;
    }

    setItemSummary(summary);
    setIsSummarizing(false);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
      // ⌘K to open API key modal
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && isOpen && onOpenApiModal) {
        e.preventDefault();
        onOpenApiModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onOpenApiModal]);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', { 
      day: 'numeric', 
      month: 'short', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const showDetails = !isGenerating && overallReport.length > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop - with rounded corners to match window */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-void/80 backdrop-blur-sm z-50 rounded-xl overflow-hidden"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none p-8"
          >
            <div className="w-[75vw] h-[75vh] min-w-[400px] min-h-[400px] bg-obsidian/98 backdrop-blur-xl border border-smoke/40 rounded-2xl shadow-2xl pointer-events-auto overflow-hidden flex flex-col">
              {/* Header */}
              <div className="px-5 py-4 border-b border-smoke/20 flex-shrink-0">
                <div className="flex items-center">
                  {/* Left: Governor image - transparent, no border */}
                  <img src={governorImage} alt="Governor" className="w-10 h-10 flex-shrink-0" />
                  
                  {/* Center: Title and subtitle */}
                  <div className="flex-1 flex flex-col items-center justify-center">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-sans font-medium text-pearl">The Governor</h2>
                      {/* Routing pill with hover tooltip */}
                      <div className="relative group/routing">
                        {activeAgentCount > 1 ? (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/20 cursor-default">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            <span className="text-[9px] font-mono text-amber-400">Routing</span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-ash/10 cursor-default">
                            <span className="w-1.5 h-1.5 rounded-full bg-ash/40" />
                            <span className="text-[9px] font-mono text-ash/60">Direct</span>
                          </span>
                        )}
                        {/* Hover tooltip - stays open when mouse moves into it */}
                        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 w-64 p-3 bg-obsidian border border-smoke/40 rounded-xl shadow-xl opacity-0 invisible group-hover/routing:opacity-100 group-hover/routing:visible transition-all duration-200 z-50">
                          <p className="text-[11px] text-ash/70 font-mono leading-relaxed mb-2">
                            {activeAgentCount > 1 
                              ? 'Governor is routing — orchestrates agent turn-taking and prevents cognitive overload for both human and machine.'
                              : 'Governor not routing — in single-agent mode, the Governor has no need to orchestrate.'
                            }
                          </p>
                          <p className="text-[10px] text-ash/50 font-mono mb-2">
                            Also manages your personalized knowledge-base.
                          </p>
                          <a 
                            href="https://chuck-nbc.fandom.com/wiki/The_Governor"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[10px] text-aurora/60 hover:text-aurora font-mono transition-colors cursor-pointer"
                          >
                            <ExternalLink className="w-2.5 h-2.5" strokeWidth={1.5} />
                            Reference: The Governor in Chuck
                          </a>
                        </div>
                      </div>
                    </div>
                    <p className="text-[10px] text-ash/50 font-mono mt-0.5">
                      {activeAgentCount > 1 ? 'Multi-agent orchestration active' : 'Single-agent mode'}
                    </p>
                  </div>
                  
                  {/* Right: ESC button */}
                  <button
                    onClick={onClose}
                    className="px-1.5 py-1 rounded text-[10px] font-mono text-ash bg-smoke/30 hover:bg-smoke/50 border border-smoke/50 transition-colors cursor-pointer flex-shrink-0"
                  >
                    ESC
                  </button>
                </div>
              </div>

              {/* Sticky Tab Bar */}
              <div className="px-5 py-2 border-b border-smoke/20 flex-shrink-0 bg-obsidian/98 sticky top-0 z-10">
                <div className="flex items-center gap-1">
                  {[
                    { id: 'overview' as TabType, label: 'Overview', hotkey: '1' },
                    { id: 'profiles' as TabType, label: 'Profiles', hotkey: '2' },
                    { id: 'patterns' as TabType, label: 'Patterns & Themes', hotkey: '3' },
                    { id: 'vibe' as TabType, label: 'Vibe Check', hotkey: '4' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono transition-all cursor-pointer ${
                        activeTab === tab.id
                          ? 'bg-smoke/40 text-pearl'
                          : 'text-ash/60 hover:text-ash hover:bg-smoke/20'
                      }`}
                    >
                      {tab.label}
                      <kbd className={`px-1 py-0.5 rounded text-[9px] font-mono leading-none border ${
                        activeTab === tab.id
                          ? 'bg-smoke/30 text-ash/80 border-smoke/50'
                          : 'bg-smoke/20 text-ash/40 border-smoke/30'
                      }`}>⌘{tab.hotkey}</kbd>
                    </button>
                  ))}
                </div>
              </div>

              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto">
                {/* Overview Tab */}
                {activeTab === 'overview' && (
                <div className="px-6 py-5">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs font-mono text-ash/50 uppercase tracking-wide">Overview</span>
                    {lastUpdated && (
                      <span className="text-[10px] text-ash/40 font-mono">
                        Updated on {formatDate(lastUpdated)}
                      </span>
                    )}
                  </div>
                  {isGenerating ? (
                    <div className="flex items-center gap-3 py-10 justify-center">
                      <Loader2 className="w-5 h-5 text-aurora animate-spin" strokeWidth={1.5} />
                      <span className="text-sm text-ash/60 font-mono">Compiling observations...</span>
                    </div>
                  ) : (
                    <p className="text-[13px] text-pearl/80 font-mono leading-relaxed">
                      {overallReport}
                    </p>
                  )}
                </div>
                )}

                {/* Profiles Tab */}
                {activeTab === 'profiles' && (
                  <div className="px-6 py-5">
                    <span className="text-xs font-mono text-ash/50 uppercase tracking-wide block mb-3">Profile Insights</span>
                    {isGenerating ? (
                      <div className="flex items-center gap-3 py-10 justify-center">
                        <Loader2 className="w-5 h-5 text-aurora animate-spin" strokeWidth={1.5} />
                        <span className="text-sm text-ash/60 font-mono">Loading profiles...</span>
                      </div>
                    ) : profileReports.length === 0 ? (
                      <p className="text-[12px] text-ash/60 font-mono italic py-4">
                        No profile insights yet. Chat with different agents to build up their understanding of you.
                      </p>
                    ) : (
                    <div className="space-y-4">
                    {profileReports.map((pr, index) => {
                      const traitColor = pr.dominantTrait === 'logic' ? '#00D4FF' 
                        : pr.dominantTrait === 'instinct' ? '#EF4444' 
                        : '#E040FB';
                      const profile = allProfiles.find(p => p.id === pr.id);
                      
                      return (
                        <motion.div
                          key={pr.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.1 }}
                          className="p-5 rounded-xl border border-smoke/30 bg-charcoal/20"
                          style={{ borderLeftColor: traitColor, borderLeftWidth: '3px' }}
                        >
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <span 
                                className="text-sm font-mono font-medium"
                                style={{ color: traitColor }}
                              >
                                {pr.name}
                              </span>
                              <span className="text-[9px] font-mono text-ash/40 uppercase">
                                {pr.dominantTrait}
                              </span>
                            </div>
                            <span className="text-[10px] font-mono text-ash/50">
                              {profile?.messageCount || 0} messages
                            </span>
                          </div>
                          <p className="text-[12px] text-pearl/70 font-mono leading-relaxed">
                            {pr.report}
                          </p>
                        </motion.div>
                      );
                    })}
                    </div>
                    )}
                  </div>
                )}

                {/* Patterns & Themes Tab */}
                {activeTab === 'patterns' && (
                  <div className="px-6 py-5">
                    {/* Patterns section */}
                    <div className="mb-8">
                    <div className="flex items-center gap-1.5 mb-4">
                      <div className="w-1 h-3 rounded-full" style={{ backgroundColor: '#00D4FF' }} />
                      <span className="text-[10px] text-ash/60 font-mono uppercase tracking-wide">Patterns observed</span>
                    </div>
                    <div className="space-y-3">
                      {!memoryStats || memoryStats.topPatterns.length === 0 ? (
                        <p className="text-[11px] text-ash/50 font-mono italic px-4 py-3">
                          No patterns detected yet — keep chatting and I'll start picking up on your tendencies.
                        </p>
                      ) : memoryStats.topPatterns.slice(0, 3).map((pattern, i) => {
                        const isExpanded = expandedItem?.key === `pattern-${i}`;
                        return (
                          <div key={i}>
                            <button
                              onClick={() => handleItemClick('pattern', String(i), pattern.description)}
                              className="w-full text-left px-4 py-3 rounded-lg bg-charcoal/40 hover:bg-charcoal/60 border border-smoke/20 transition-all cursor-pointer group"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1">
                                  <span 
                                    className="inline-block px-1.5 py-0.5 rounded text-[8px] font-mono font-medium uppercase mb-2"
                                    style={{ backgroundColor: '#00D4FF20', color: '#00D4FF' }}
                                  >
                                    {pattern.patternType.replace(/_/g, ' ')}
                                  </span>
                                  <p className="text-[11px] text-pearl/70 font-mono leading-relaxed">{pattern.description}</p>
                                </div>
                                <ChevronRight 
                                  className={`w-4 h-4 text-ash/40 group-hover:text-pearl/60 transition-transform ml-3 ${isExpanded ? 'rotate-90' : ''}`} 
                                  strokeWidth={1.5} 
                                />
                              </div>
                            </button>
                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="px-3 py-2 mt-1 bg-charcoal/20 rounded-lg border-l-2" style={{ borderColor: '#00D4FF' }}>
                                    {isSummarizing ? (
                                      <div className="flex items-center gap-2">
                                        <Loader2 className="w-3 h-3 text-psyche animate-spin" />
                                        <span className="text-[10px] text-ash/50 font-mono">Governor is thinking...</span>
                                      </div>
                                    ) : (
                                      <p className="text-[11px] text-ash/70 font-mono leading-relaxed">{itemSummary}</p>
                                    )}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>
                    </div>

                    {/* Themes section */}
                    <div>
                    <div className="flex items-center gap-1.5 mb-4">
                      <div className="w-1 h-3 rounded-full" style={{ backgroundColor: '#E040FB' }} />
                      <span className="text-[10px] text-ash/60 font-mono uppercase tracking-wide">Recurring themes</span>
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      {!memoryStats || memoryStats.topThemes.length === 0 ? (
                        <p className="text-[11px] text-ash/50 font-mono italic">
                          No recurring themes yet — the more we talk, the more I'll notice what keeps coming up.
                        </p>
                      ) : memoryStats.topThemes.slice(0, 6).map((theme, i) => {
                        const isExpanded = expandedItem?.key === `theme-${i}`;
                        return (
                          <div key={i} className="relative">
                            <button
                              onClick={() => handleItemClick('theme', String(i), theme)}
                              className={`px-4 py-2 rounded-full text-[11px] font-mono transition-all cursor-pointer ${
                                isExpanded 
                                  ? 'bg-instinct/20 border-instinct/40' 
                                  : 'hover:bg-charcoal/60'
                              }`}
                              style={{ 
                                background: isExpanded ? undefined : `linear-gradient(135deg, #E040FB15 0%, #E040FB15 100%)`,
                                border: `1px solid ${isExpanded ? '#E040FB' : '#E040FB30'}`,
                                color: '#e5e7eb',
                              }}
                            >
                              {theme}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    {/* Theme summary - shows below all themes */}
                    <AnimatePresence>
                      {expandedItem?.type === 'theme' && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden mt-2"
                        >
                          <div className="px-3 py-2 bg-charcoal/20 rounded-lg border-l-2" style={{ borderColor: '#E040FB' }}>
                            {isSummarizing ? (
                              <div className="flex items-center gap-2">
                                <Loader2 className="w-3 h-3 text-instinct animate-spin" />
                                <span className="text-[10px] text-ash/50 font-mono">Governor is thinking...</span>
                              </div>
                            ) : (
                              <p className="text-[11px] text-ash/70 font-mono leading-relaxed">{itemSummary}</p>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    </div>
                  </div>
                )}

                {/* Vibe Check Tab */}
                {activeTab === 'vibe' && (
                  <div className="px-6 py-5">
                    <div className="flex items-center gap-1.5 mb-4">
                      <div className="w-1 h-3 rounded-full" style={{ backgroundColor: '#EF4444' }} />
                      <span className="text-[10px] text-ash/60 font-mono uppercase tracking-wide">Vibe Check</span>
                    </div>
                    {isGenerating ? (
                      <div className="flex items-center gap-3 py-10 justify-center">
                        <Loader2 className="w-5 h-5 text-aurora animate-spin" strokeWidth={1.5} />
                        <span className="text-sm text-ash/60 font-mono">Compiling vibe...</span>
                      </div>
                    ) : userSummary ? (
                      <div 
                        className="p-4 rounded-xl border-l-2"
                        style={{ 
                          backgroundColor: '#EF444410',
                          borderColor: '#EF4444',
                        }}
                      >
                        <p className="text-[13px] text-pearl/90 font-mono leading-relaxed italic">
                          "{userSummary}"
                        </p>
                      </div>
                    ) : (
                      <p className="text-[12px] text-ash/60 font-mono italic py-4">
                        Not enough to vibe check yet — keep chatting and I'll get a read on you.
                      </p>
                    )}
                  </div>
                )}

              </div>

              {/* Stats footer */}
              {showDetails && memoryStats && (
                <div className="px-5 py-3 border-t border-smoke/20 flex-shrink-0">
                  <div className="flex items-center justify-between text-[10px] font-mono text-ash/50">
                    <div className="flex items-center gap-3">
                      <span>{memoryStats.factCount} facts learned</span>
                      <span className="text-ash/30">|</span>
                      <span>{memoryStats.patternCount} patterns</span>
                      <span className="text-ash/30">|</span>
                      <span>{memoryStats.topThemes.length} themes</span>
                    </div>
                    {userProfile && (
                      <span>{userProfile.totalMessages} total messages</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
