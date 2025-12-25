import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Edit2, Calendar, Key } from 'lucide-react';
import { useAppStore } from '../store';
import { AGENTS } from '../constants/agents';
import { 
  getUserProfile, 
  getAllPersonaProfiles,
  updatePersonaProfileName,
  setActivePersonaProfile as setActivePersonaProfileBackend,
  finalizeConversation,
} from '../hooks/useTauri';
import { ApiKeyModal } from './ApiKeyModal';
import governorTransparent from '../assets/governor-transparent.png';
// Direct imports for radar chart images
import instinctProfile from '../assets/agents/instinct.png';
import logicProfile from '../assets/agents/logic.png';
import psycheProfile from '../assets/agents/psyche.png';

const PROFILE_IMAGES = {
  instinct: instinctProfile,
  logic: logicProfile,
  psyche: psycheProfile,
} as const;

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

// Types for profile data in radar chart
interface ProfileForChart {
  id: string;
  name: string;
  dominantTrait: string;
  isActive: boolean;
  isDefault: boolean;
}

interface RadarChartProps {
  weights: { instinct: number; logic: number; psyche: number };
  targetWeights?: { instinct: number; logic: number; psyche: number };
  profiles?: ProfileForChart[];
  onSwitchProfile?: (profileId: string) => void;
  editingProfileName?: string | null;
  tempProfileName?: string;
  onStartEdit?: (profileId: string, currentName: string) => void;
  onSaveEdit?: (profileId: string) => void;
  onCancelEdit?: () => void;
  onTempNameChange?: (name: string) => void;
}

// Radar chart component for agent weights with profile pictures
function RadarChart({ 
  weights, 
  targetWeights: _targetWeights,
  profiles = [],
  onSwitchProfile,
  editingProfileName,
  tempProfileName,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onTempNameChange,
}: RadarChartProps) {
  const size = 280;
  const center = size / 2;
  const radius = 85; // Slightly larger for better visual impact
  
  // Weight range: 20% minimum, 60% maximum
  const MIN_WEIGHT = 0.20;
  const MAX_WEIGHT = 0.60;
  
  // Normalize weight from [0.20, 0.60] to [0.25, 1.0] for chart display
  // This exaggerates differences: 20% -> 25% of radius, 60% -> 100% of radius
  const normalizeWeight = (weight: number) => {
    const clamped = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weight));
    const normalized = (clamped - MIN_WEIGHT) / (MAX_WEIGHT - MIN_WEIGHT); // 0 to 1
    return 0.25 + normalized * 0.75; // Map to 0.25-1.0 range
  };
  
  // Image sizes scale with weight
  const minImageSize = 52;
  const maxImageSize = 72;
  
  const getImageSize = (weight: number) => {
    const clamped = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weight));
    const normalized = (clamped - MIN_WEIGHT) / (MAX_WEIGHT - MIN_WEIGHT);
    return minImageSize + normalized * (maxImageSize - minImageSize);
  };
  
  // Calculate points for each agent (3 points, 120 degrees apart)
  // Order matches AGENT_ORDER for hotkeys: ⌘1 Psyche, ⌘2 Logic, ⌘3 Instinct
  const angles = {
    psyche: -90,     // Top (⌘1)
    logic: 150,      // Bottom left (⌘2)
    instinct: 30,    // Bottom right (⌘3)
  };
  
  const getPoint = (agent: 'instinct' | 'logic' | 'psyche', scale: number) => {
    const angle = (angles[agent] * Math.PI) / 180;
    const r = radius * scale;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };
  
  // Label positions (outside the chart) - more space for larger images
  const getLabelPoint = (agent: 'instinct' | 'logic' | 'psyche') => {
    const angle = (angles[agent] * Math.PI) / 180;
    const r = radius + 60;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };
  
  // Background rings at 33%, 66%, 100%
  const rings = [0.33, 0.66, 1];
  
  // Normalize weights for chart display
  const normalizedWeights = {
    instinct: normalizeWeight(weights.instinct),
    logic: normalizeWeight(weights.logic),
    psyche: normalizeWeight(weights.psyche),
  };
  
  // Data points using normalized weights
  const instinctPoint = getPoint('instinct', normalizedWeights.instinct);
  const logicPoint = getPoint('logic', normalizedWeights.logic);
  const psychePoint = getPoint('psyche', normalizedWeights.psyche);
  
  const dataPath = `M ${logicPoint.x} ${logicPoint.y} L ${psychePoint.x} ${psychePoint.y} L ${instinctPoint.x} ${instinctPoint.y} Z`;
  
  // Agents ordered by hotkey (⌘1, ⌘2, ⌘3) matching AGENT_ORDER
  const agents = [
    { id: 'psyche' as const, point: psychePoint, label: getLabelPoint('psyche'), weight: weights.psyche, hotkey: 1 },
    { id: 'logic' as const, point: logicPoint, label: getLabelPoint('logic'), weight: weights.logic, hotkey: 2 },
    { id: 'instinct' as const, point: instinctPoint, label: getLabelPoint('instinct'), weight: weights.instinct, hotkey: 3 },
  ];
  
  return (
    <div className="relative" style={{ width: size, height: size, margin: '0 auto' }}>
      <svg width={size} height={size} className="absolute inset-0">
        {/* Background rings */}
        {rings.map((ring, i) => {
          const points = ['instinct', 'logic', 'psyche'].map(agent => 
            getPoint(agent as 'instinct' | 'logic' | 'psyche', ring)
          );
          return (
            <polygon
              key={i}
              points={points.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke="var(--color-smoke)"
              strokeWidth={0.5}
              opacity={0.4}
            />
          );
        })}
        
        {/* Axis lines */}
        {(['instinct', 'logic', 'psyche'] as const).map(agent => {
          const point = getPoint(agent, 1);
          return (
            <line
              key={agent}
              x1={center}
              y1={center}
              x2={point.x}
              y2={point.y}
              stroke="var(--color-smoke)"
              strokeWidth={0.5}
              opacity={0.25}
            />
          );
        })}
        
        {/* Data area */}
        <motion.path
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          d={dataPath}
          fill="url(#radarGradient)"
          stroke="url(#radarStroke)"
          strokeWidth={2}
          opacity={0.85}
        />
        
        {/* Gradient definitions */}
        <defs>
          <linearGradient id="radarGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={AGENTS.instinct.color} stopOpacity={0.15} />
            <stop offset="50%" stopColor={AGENTS.logic.color} stopOpacity={0.15} />
            <stop offset="100%" stopColor={AGENTS.psyche.color} stopOpacity={0.15} />
          </linearGradient>
          <linearGradient id="radarStroke" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={AGENTS.instinct.color} />
            <stop offset="50%" stopColor={AGENTS.logic.color} />
            <stop offset="100%" stopColor={AGENTS.psyche.color} />
          </linearGradient>
        </defs>
        
        {/* Data point dots */}
        {agents.map(({ id, point }, i) => (
          <motion.circle
            key={id}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: i * 0.1 }}
            cx={point.x}
            cy={point.y}
            r={3}
            fill={AGENTS[id].color}
            stroke="var(--color-obsidian)"
            strokeWidth={1.5}
          />
        ))}
      </svg>
      
      {/* Profile pictures at corners - size scales with weight, clickable for profile switching */}
      {agents.map(({ id, label, weight, hotkey }) => {
        const typeLabels = { instinct: 'Instinct', logic: 'Logic', psyche: 'Psyche' };
        const imgSize = getImageSize(weight);
        // Find profile with this dominant trait
        const profileForAgent = profiles.find(p => p.dominantTrait === id);
        const isActiveProfile = profileForAgent?.isActive ?? false;
        const hasProfile = !!profileForAgent;
        
        return (
          <div
            key={id}
            className={`absolute flex flex-col items-center transition-all duration-300 group ${hasProfile && !isActiveProfile ? 'cursor-pointer hover:opacity-90' : ''}`}
            style={{
              left: label.x - imgSize / 2,
              top: label.y - imgSize / 2 - 8,
            }}
            onClick={() => {
              if (profileForAgent && !isActiveProfile && onSwitchProfile) {
                onSwitchProfile(profileForAgent.id);
              }
            }}
          >
            {/* Profile name pill - above the image */}
            {profileForAgent && (
              <div 
                className={`absolute -top-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-obsidian/90 ${editingProfileName === profileForAgent.id ? '' : 'border border-smoke/50'}`}
              >
                {editingProfileName === profileForAgent.id ? (
                  <input
                    type="text"
                    value={tempProfileName}
                    onChange={(e) => onTempNameChange?.(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') onSaveEdit?.(profileForAgent.id);
                      if (e.key === 'Escape') onCancelEdit?.();
                    }}
                    onBlur={() => onSaveEdit?.(profileForAgent.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="bg-transparent border-none px-0 py-0 text-[11px] font-mono outline-none w-20 caret-current"
                    style={{ color: AGENTS[id].color, caretColor: AGENTS[id].color }}
                    autoFocus
                  />
                ) : (
                  <span 
                    className="text-[11px] font-mono whitespace-nowrap"
                    style={{ color: AGENTS[id].color }}
                  >
                    {profileForAgent.name}
                  </span>
                )}
                {editingProfileName !== profileForAgent.id && isActiveProfile && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartEdit?.(profileForAgent.id, profileForAgent.name);
                    }}
                    className="p-0.5 rounded hover:bg-smoke/30 text-ash/40 hover:text-ash transition-colors cursor-pointer flex-shrink-0"
                    title="Edit name"
                  >
                    <Edit2 className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            )}
            
            <div className="relative">
              {/* Pulsing amber border for active profile - matches chat user avatar */}
              {isActiveProfile && (
                <motion.div
                  className="absolute inset-0 rounded-full"
                  style={{ 
                    boxShadow: '0 0 0 2px #EAB308',
                  }}
                  animate={{ 
                    opacity: [0.65, 0.9, 0.65],
                  }}
                  transition={{ 
                    duration: 3,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                />
              )}
              <div
                className={`rounded-full overflow-hidden transition-all duration-300 relative ${!hasProfile ? 'opacity-40' : isActiveProfile ? '' : 'opacity-50 hover:opacity-70 border-2'}`}
                style={{
                  width: imgSize,
                  height: imgSize,
                  borderColor: !isActiveProfile ? `${AGENTS[id].color}40` : undefined,
                }}
              >
                <img
                  src={PROFILE_IMAGES[id]}
                  alt={AGENTS[id].name}
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span 
                className="text-[9px] font-mono px-1.5 py-0.5 rounded-full"
                style={{ 
                  backgroundColor: `${AGENTS[id].color}20`,
                  color: AGENTS[id].color,
                }}
              >
                {typeLabels[id]}
              </span>
              <span 
                className="text-[10px] font-mono opacity-70"
                style={{ color: AGENTS[id].color }}
              >
                {Math.round(weight * 100)}%
              </span>
              <kbd 
                className="text-[8px] font-mono px-1 py-0.5 rounded bg-smoke/30 text-ash/50"
              >
                ⌘{hotkey}
              </kbd>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Format date like "18 December 2025"
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

// 16 Personality Types mapped to Logic/Instinct/Psyche combinations
// Based on 16personalities.com framework:
// - Analysts (Logic-dominant): INTJ, INTP, ENTJ, ENTP
// - Diplomats (Instinct-dominant): INFJ, INFP, ENFJ, ENFP  
// - Sentinels (Psyche-dominant): ISTJ, ISFJ, ESTJ, ESFJ
// - Explorers (Mixed): ISTP, ISFP, ESTP, ESFP
const PERSONALITY_TYPES = {
  // Logic dominant (Analysts)
  'logic-pure': { code: 'INTP', name: 'The Logician', desc: 'Innovative inventor with an unquenchable thirst for knowledge.' },
  'logic-instinct': { code: 'ENTP', name: 'The Debater', desc: 'Smart and curious thinker who thrives on intellectual challenges.' },
  'logic-psyche': { code: 'INTJ', name: 'The Architect', desc: 'Imaginative strategist with a plan for everything.' },
  'logic-balanced': { code: 'ENTJ', name: 'The Commander', desc: 'Bold leader who finds or makes a way.' },
  
  // Instinct dominant (Diplomats)
  'instinct-pure': { code: 'INFP', name: 'The Mediator', desc: 'Poetic and idealistic, seeking good in all situations.' },
  'instinct-logic': { code: 'ENFJ', name: 'The Protagonist', desc: 'Charismatic leader who inspires others.' },
  'instinct-psyche': { code: 'INFJ', name: 'The Advocate', desc: 'Quiet visionary with an inner fire.' },
  'instinct-balanced': { code: 'ENFP', name: 'The Campaigner', desc: 'Enthusiastic free spirit who finds joy in connections.' },
  
  // Psyche dominant (Sentinels)
  'psyche-pure': { code: 'ISFJ', name: 'The Defender', desc: 'Dedicated protector, warm and caring.' },
  'psyche-logic': { code: 'ISTJ', name: 'The Logistician', desc: 'Practical and reliable, devoted to tradition.' },
  'psyche-instinct': { code: 'ESFJ', name: 'The Consul', desc: 'Caring and social, eager to help.' },
  'psyche-balanced': { code: 'ESTJ', name: 'The Executive', desc: 'Excellent administrator who manages things and people.' },
  
  // Mixed/Explorer types
  'mixed-logic-instinct': { code: 'ESTP', name: 'The Entrepreneur', desc: 'Smart, energetic, perceptive, and action-oriented.' },
  'mixed-instinct-psyche': { code: 'ESFP', name: 'The Entertainer', desc: 'Spontaneous and energetic, life is never dull around you.' },
  'mixed-logic-psyche': { code: 'ISTP', name: 'The Virtuoso', desc: 'Bold experimenter, master of tools.' },
  'balanced': { code: 'ISFP', name: 'The Adventurer', desc: 'Flexible artist, ready to explore and experience.' },
};

function getPersonalityType(weights: { instinct: number; logic: number; psyche: number }): { code: string; name: string; desc: string; key: string } {
  const { instinct, logic, psyche } = weights;
  
  const sorted = [
    { id: 'logic', weight: logic },
    { id: 'instinct', weight: instinct },
    { id: 'psyche', weight: psyche },
  ].sort((a, b) => b.weight - a.weight);
  
  const dominant = sorted[0];
  const secondary = sorted[1];
  const tertiary = sorted[2];
  
  const dominantWeight = dominant.weight;
  const secondaryWeight = secondary.weight;
  const tertiaryWeight = tertiary.weight;
  
  // Check for balanced (all within 10% of each other)
  if (Math.abs(dominantWeight - tertiaryWeight) < 0.10) {
    return { ...PERSONALITY_TYPES['balanced'], key: 'balanced' };
  }
  
  // Check for mixed (top two are close, third is clearly lower)
  if (Math.abs(dominantWeight - secondaryWeight) < 0.08 && (secondaryWeight - tertiaryWeight) > 0.10) {
    const mixKey = `mixed-${[dominant.id, secondary.id].sort().join('-')}` as keyof typeof PERSONALITY_TYPES;
    if (PERSONALITY_TYPES[mixKey]) {
      return { ...PERSONALITY_TYPES[mixKey], key: mixKey };
    }
  }
  
  // Dominant with secondary influence
  if ((dominantWeight - secondaryWeight) < 0.12) {
    const key = `${dominant.id}-${secondary.id}` as keyof typeof PERSONALITY_TYPES;
    if (PERSONALITY_TYPES[key]) {
      return { ...PERSONALITY_TYPES[key], key };
    }
  }
  
  // Dominant with balanced others
  if ((secondaryWeight - tertiaryWeight) < 0.08) {
    const key = `${dominant.id}-balanced` as keyof typeof PERSONALITY_TYPES;
    if (PERSONALITY_TYPES[key]) {
      return { ...PERSONALITY_TYPES[key], key };
    }
  }
  
  // Pure dominant
  const pureKey = `${dominant.id}-pure` as keyof typeof PERSONALITY_TYPES;
  return { ...PERSONALITY_TYPES[pureKey], key: pureKey };
}

// Generate user profile description based on weights
function getProfileDescription(weights: { instinct: number; logic: number; psyche: number }, totalMessages: number): { 
  title: string; 
  code: string;
  description: string; 
  forming: string;
  confidence: number;
} {
  const personality = getPersonalityType(weights);
  
  // De-exponential confidence: fast learning early, rigid at 10k messages
  // Formula: sqrt(messages/10000) * 100, matches backend calculate_variability
  const confidence = Math.min(100, Math.round(Math.sqrt(totalMessages / 10000) * 100));
  
  // How weights are forming
  let forming = '';
  if (confidence < 10) {
    forming = `${confidence}% confident · Still learning your patterns...`;
  } else if (confidence < 50) {
    forming = `${confidence}% confident · Your profile is taking shape.`;
  } else if (confidence < 100) {
    forming = `${confidence}% confident · Becoming more certain about you.`;
  } else {
    forming = `100% confident · Profile is fully established.`;
  }
  
  return { 
    title: personality.name, 
    code: personality.code,
    description: personality.desc, 
    forming,
    confidence,
  };
}

export function Settings({ isOpen, onClose }: SettingsProps) {
  const { 
    userProfile, 
    clearMessages, 
    currentConversation,
    setCurrentConversation, 
    setUserProfile, 
    allPersonaProfiles,
    setAllPersonaProfiles,
    setActivePersonaProfile,
    messages,
  } = useAppStore();
  const [showApiModal, setShowApiModal] = useState(false);
  const [editingProfileName, setEditingProfileName] = useState<string | null>(null);
  const [tempProfileName, setTempProfileName] = useState('');
  
  // Animated weights for smooth transitions
  const [animatedWeights, setAnimatedWeights] = useState({
    logic: userProfile?.logicWeight ?? 0.4,
    instinct: userProfile?.instinctWeight ?? 0.3,
    psyche: userProfile?.psycheWeight ?? 0.3,
  });
  
  // Animate weight transitions when profile changes
  useEffect(() => {
    if (!userProfile) return;
    
    const targetWeights = {
      logic: userProfile.logicWeight,
      instinct: userProfile.instinctWeight,
      psyche: userProfile.psycheWeight,
    };
    
    const startWeights = { ...animatedWeights };
    const duration = 150; // ms - fast transition
    const startTime = performance.now();
    
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Ease-out cubic for smooth deceleration
      const eased = 1 - Math.pow(1 - progress, 3);
      
      setAnimatedWeights({
        logic: startWeights.logic + (targetWeights.logic - startWeights.logic) * eased,
        instinct: startWeights.instinct + (targetWeights.instinct - startWeights.instinct) * eased,
        psyche: startWeights.psyche + (targetWeights.psyche - startWeights.psyche) * eased,
      });
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    
    requestAnimationFrame(animate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile?.logicWeight, userProfile?.instinctWeight, userProfile?.psycheWeight]);
  
  // Load profiles when opened
  useEffect(() => {
    if (isOpen) {
      getAllPersonaProfiles().then(setAllPersonaProfiles).catch(console.error);
    }
  }, [isOpen, setAllPersonaProfiles]);
  
  const handleSaveProfileName = async (profileId: string) => {
    if (!tempProfileName.trim()) return;
    try {
      await updatePersonaProfileName(profileId, tempProfileName.trim());
      const profiles = await getAllPersonaProfiles();
      setAllPersonaProfiles(profiles);
      const activeProfile = profiles.find(p => p.isActive);
      if (activeProfile) setActivePersonaProfile(activeProfile);
      setEditingProfileName(null);
    } catch (err) {
      console.error('Failed to update profile name:', err);
    }
  };
  
  const handleSwitchProfile = useCallback(async (profileId: string) => {
    const currentActive = allPersonaProfiles.find(p => p.isActive);
    if (currentActive?.id === profileId) return;
    
    try {
      // Finalize the current conversation before switching profiles
      if (currentConversation && messages.length > 1) {
        finalizeConversation(currentConversation.id).catch(err => 
          console.error('Failed to finalize conversation:', err)
        );
      }
      
      await setActivePersonaProfileBackend(profileId);
      const profiles = await getAllPersonaProfiles();
      setAllPersonaProfiles(profiles);
      const activeProfile = profiles.find(p => p.isActive);
      if (activeProfile) {
        setActivePersonaProfile(activeProfile);
        // Refresh user profile to get updated weights for the star chart
        const updatedUserProfile = await getUserProfile();
        setUserProfile(updatedUserProfile);
        // Clear messages and start fresh with new profile
        clearMessages();
        setCurrentConversation(null);
      }
    } catch (err) {
      console.error('Failed to switch profile:', err);
    }
  }, [allPersonaProfiles, currentConversation, messages.length, setAllPersonaProfiles, setActivePersonaProfile, setUserProfile, clearMessages, setCurrentConversation]);
  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't close Settings if API modal is open - let it close first
      if (e.key === 'Escape' && isOpen && !showApiModal) {
        onClose();
      }
      // ⌘K to open API key modal
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && isOpen) {
        e.preventDefault();
        setShowApiModal(true);
      }
      // ⌘1, ⌘2, ⌘3 to switch profiles (matches AGENT_ORDER: psyche, logic, instinct)
      if ((e.metaKey || e.ctrlKey) && isOpen && !showApiModal && !editingProfileName) {
        const hotkeyMap: Record<string, string> = { '1': 'psyche', '2': 'logic', '3': 'instinct' };
        const trait = hotkeyMap[e.key];
        if (trait) {
          e.preventDefault();
          const profileForTrait = allPersonaProfiles.find(p => p.dominantTrait === trait);
          if (profileForTrait && !profileForTrait.isActive) {
            handleSwitchProfile(profileForTrait.id);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, showApiModal, editingProfileName, allPersonaProfiles, handleSwitchProfile]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-void/80 backdrop-blur-sm z-40"
          />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed right-2 top-2 w-[480px] max-h-[calc(100vh-16px)] bg-obsidian/98 backdrop-blur-xl border border-smoke/40 rounded-2xl z-50 flex flex-col shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-smoke/30 flex-shrink-0">
              <h2 className="font-sans text-base text-ivory font-medium">Profile</h2>
              {/* ESC button */}
              <button
                onClick={onClose}
                className="p-1 rounded text-[10px] font-mono text-ash bg-smoke/30 hover:bg-smoke/50 border border-smoke/50 transition-colors cursor-pointer aspect-square flex items-center justify-center"
              >
                ESC
              </button>
            </div>

            <div className="p-4 space-y-5 flex-1 overflow-y-auto">

              {/* Agent weights - Radar chart */}
              {userProfile && (
                <section>
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs text-ash font-mono flex items-center gap-1.5">
                      <Calendar className="w-3 h-3 text-ash/60" strokeWidth={1.5} />
                      Created on {formatDate(userProfile.createdAt)}
                    </span>
                    <span className="text-xs text-ash font-mono">{userProfile.totalMessages} messages</span>
                  </div>
                  
                  <div 
                    className="rounded-xl pt-4 pb-4 px-4 border border-smoke/30 relative overflow-hidden"
                    style={{
                      // Dynamic gradient based on INVERTED weights (lower = more dominant)
                      // Colors: Logic #00D4FF, Psyche #E040FB, Instinct #EF4444
                      background: (() => {
                        const logicInv = 1 - userProfile.logicWeight;
                        const psycheInv = 1 - userProfile.psycheWeight;
                        const instinctInv = 1 - userProfile.instinctWeight;
                        const total = logicInv + psycheInv + instinctInv;
                        const l = (logicInv / total) * 0.12;
                        const p = (psycheInv / total) * 0.12;
                        const i = (instinctInv / total) * 0.12;
                        return `linear-gradient(135deg, 
                          rgba(0, 212, 255, ${l.toFixed(3)}) 0%,
                          rgba(224, 64, 251, ${p.toFixed(3)}) 50%,
                          rgba(239, 68, 68, ${i.toFixed(3)}) 100%
                        )`;
                      })(),
                    }}
                  >
                    {/* Subtle radial overlay for depth */}
                    <div 
                      className="absolute inset-0 opacity-20"
                      style={{
                        background: (() => {
                          const logicInv = 1 - userProfile.logicWeight;
                          const psycheInv = 1 - userProfile.psycheWeight;
                          const instinctInv = 1 - userProfile.instinctWeight;
                          const total = logicInv + psycheInv + instinctInv;
                          const l = (logicInv / total) * 0.15;
                          const p = (psycheInv / total) * 0.15;
                          const i = (instinctInv / total) * 0.15;
                          return `
                            radial-gradient(circle at 50% 10%, rgba(0, 212, 255, ${l.toFixed(3)}) 0%, transparent 50%),
                            radial-gradient(circle at 20% 80%, rgba(224, 64, 251, ${p.toFixed(3)}) 0%, transparent 50%),
                            radial-gradient(circle at 80% 80%, rgba(239, 68, 68, ${i.toFixed(3)}) 0%, transparent 50%)
                          `;
                        })(),
                      }}
                    />
                    
                    <div className="relative z-10 pt-[84px]">
                      <RadarChart 
                        weights={{
                          instinct: animatedWeights.instinct,
                          logic: animatedWeights.logic,
                          psyche: animatedWeights.psyche,
                        }}
                        targetWeights={{
                          instinct: userProfile.instinctWeight,
                          logic: userProfile.logicWeight,
                          psyche: userProfile.psycheWeight,
                        }}
                        profiles={allPersonaProfiles.map(p => ({
                          id: p.id,
                          name: p.name,
                          dominantTrait: p.dominantTrait,
                          isActive: p.isActive,
                          isDefault: p.isDefault,
                        }))}
                        onSwitchProfile={handleSwitchProfile}
                        editingProfileName={editingProfileName}
                        tempProfileName={tempProfileName}
                        onStartEdit={(id, name) => {
                          setEditingProfileName(id);
                          setTempProfileName(name);
                        }}
                        onSaveEdit={handleSaveProfileName}
                        onCancelEdit={() => setEditingProfileName(null)}
                        onTempNameChange={setTempProfileName}
                      />
                    </div>
                    
                    {/* Profile description */}
                    {(() => {
                      const profile = getProfileDescription(
                        { instinct: userProfile.instinctWeight, logic: userProfile.logicWeight, psyche: userProfile.psycheWeight },
                        userProfile.totalMessages
                      );
                      return (
                        <div className="relative z-10 mt-4 pt-3 border-t border-smoke/20">
                          {/* Personality type header */}
                          <div className="text-center mb-2">
                            <div className="flex items-center justify-center gap-2 mb-1">
                              <span 
                                className="text-sm font-sans font-medium"
                                style={{
                                  background: 'linear-gradient(90deg, #00D4FF, #E040FB)',
                                  backgroundClip: 'text',
                                  WebkitBackgroundClip: 'text',
                                  WebkitTextFillColor: 'transparent',
                                }}
                              >
                                {profile.title}
                              </span>
                            </div>
                          </div>
                          <p className="text-xs text-silver font-mono text-center leading-relaxed mb-2">
                            {profile.description}
                          </p>
                          
                          {/* Confidence bar */}
                          <div className="mb-3">
                            <div className="h-1 bg-smoke/30 rounded-full overflow-hidden">
                              <div 
                                className="h-full rounded-full transition-all duration-500"
                                style={{ 
                                  width: `${profile.confidence}%`,
                                  background: profile.confidence >= 100 
                                    ? 'linear-gradient(90deg, #00D4FF, #E040FB)'
                                    : 'rgba(148, 163, 184, 0.5)',
                                }}
                              />
                            </div>
                            <p className="text-[10px] text-ash/60 font-mono text-center mt-1">
                              {profile.forming}
                            </p>
                          </div>
                          
                          {/* 16personalities credit */}
                          <a 
                            href="https://www.16personalities.com" 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-1 text-[9px] text-ash/40 hover:text-ash/70 font-mono transition-colors"
                          >
                            <ExternalLink className="w-2.5 h-2.5" strokeWidth={1.5} />
                            Inspired by 16personalities.com
                          </a>
                          
                        </div>
                      );
                    })()}
                  </div>
                  
                  {/* Tip explaining profile switching - below the box */}
                  <p className="text-[10px] text-ash/40 font-mono text-center mt-3">
                    Click to switch profiles. Switching profiles changes how often a given agent will respond and what types of topics they focus on.
                  </p>
                </section>
              )}


            </div>



            {/* Footer - sticky at bottom */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-smoke/30 flex-shrink-0">
              <div className="flex items-center gap-1.5">
                <img src={governorTransparent} alt="" className="w-4 h-4 opacity-60" />
                <p className="text-xs text-ash/60 font-mono">Intersect v2.0.0</p>
              </div>
              <div className="flex items-center gap-2">
                {userProfile?.apiKey && (
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span className="text-[10px] text-emerald-500/80 font-mono">Connected</span>
                  </span>
                )}
                <button
                  onClick={() => setShowApiModal(true)}
                  className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-ash/60 hover:text-pearl hover:bg-smoke/30 transition-colors cursor-pointer"
                  title="Change API Key (⌘K)"
                >
                  <Key className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <kbd className="w-5 h-5 bg-smoke/30 rounded text-[9px] font-mono text-ash/50 border border-smoke/40 flex items-center justify-center">⌘K</kbd>
                </button>
              </div>
            </div>
          </motion.div>

          {/* API Key modal - use the full ApiKeyModal component */}
          <ApiKeyModal
            isOpen={showApiModal}
            onComplete={() => {
              setShowApiModal(false);
              // Refresh profile
              getUserProfile().then(setUserProfile);
            }}
            initialOpenAiKey={userProfile?.apiKey}
            initialAnthropicKey={userProfile?.anthropicKey}
          />
        </>
      )}
    </AnimatePresence>
  );
}
