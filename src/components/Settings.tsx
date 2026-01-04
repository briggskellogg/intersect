import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, Info, ExternalLink, ApiKeyIcon, RefreshCw } from './icons';
import { useAppStore } from '../store';
import { AGENTS } from '../constants/agents';
import { 
  getUserProfile, 
  updatePoints,
  updateDominantTrait,
  getActivePersonaProfile,
  resetPersonalization,
  createConversation,
  getConversationOpener,
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

// Archetype images
import thinkerImage from '../assets/archetypes/thinker.jpg';
import sensitiveImage from '../assets/archetypes/sensitive.jpg';
import bruteImage from '../assets/archetypes/brute.jpg';

// Archetypes with preset point allocations
const ARCHETYPES = {
  thinker: {
    name: 'Thinker',
    dominant: 'logic' as const,
    points: { logic: 6, instinct: 4, psyche: 2 },
    image: thinkerImage,
    imagePosition: 'center 20%',
    description: 'Logic-driven analysis',
  },
  sensitive: {
    name: 'Sensitive',
    dominant: 'psyche' as const,
    points: { logic: 3, instinct: 4, psyche: 5 },
    image: sensitiveImage,
    imagePosition: 'center 15%',
    description: 'Emotionally attuned',
  },
  brute: {
    name: 'Brute',
    dominant: 'instinct' as const,
    points: { logic: 2, instinct: 7, psyche: 3 },
    image: bruteImage,
    imagePosition: 'center 17%',
    description: 'Gut-driven action',
  },
} as const;

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

interface RadarChartProps {
  weights: { instinct: number; logic: number; psyche: number }; // Points-based (what user sets)
  learnedWeights?: { instinct: number; logic: number; psyche: number }; // What Intersect learned
  localPoints?: { instinct: number; logic: number; psyche: number };
  onPointChange?: (trait: 'instinct' | 'logic' | 'psyche', delta: number) => void;
  selectedDominantTrait?: 'instinct' | 'logic' | 'psyche' | null;
  onDominantTraitSelect?: (trait: 'instinct' | 'logic' | 'psyche') => void;
}

// Radar chart component for agent weights with profile pictures
function RadarChart({ 
  weights, 
  learnedWeights,
  localPoints,
  onPointChange,
  selectedDominantTrait,
  onDominantTraitSelect,
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
  
  // Fixed image size for all agents
  const imageSize = 64;
  
  // Calculate points for each agent (3 points, 120 degrees apart)
  // Reoriented: Logic at top, Psyche bottom-left, Instinct bottom-right
  const angles = {
    logic: -90,      // Top
    psyche: 150,     // Bottom left
    instinct: 30,    // Bottom right
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
    const r = radius + 80; // Increased from 60 to 80 for more spacing
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
  
  // Data points using normalized weights (points-based - what user sets)
  const instinctPoint = getPoint('instinct', normalizedWeights.instinct);
  const logicPoint = getPoint('logic', normalizedWeights.logic);
  const psychePoint = getPoint('psyche', normalizedWeights.psyche);
  
  const dataPath = `M ${logicPoint.x} ${logicPoint.y} L ${psychePoint.x} ${psychePoint.y} L ${instinctPoint.x} ${instinctPoint.y} Z`;
  
  // Learned weights triangle (what Intersect learned - dotted)
  const learnedPath = learnedWeights ? (() => {
    const normalizedLearned = {
      instinct: normalizeWeight(learnedWeights.instinct),
      logic: normalizeWeight(learnedWeights.logic),
      psyche: normalizeWeight(learnedWeights.psyche),
    };
    const lInstinct = getPoint('instinct', normalizedLearned.instinct);
    const lLogic = getPoint('logic', normalizedLearned.logic);
    const lPsyche = getPoint('psyche', normalizedLearned.psyche);
    return `M ${lLogic.x} ${lLogic.y} L ${lPsyche.x} ${lPsyche.y} L ${lInstinct.x} ${lInstinct.y} Z`;
  })() : null;
  
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
        
        {/* Learned weights area (dotted) - what Intersect learned */}
        {learnedPath && (
          <motion.path
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            d={learnedPath}
            fill="none"
            stroke="var(--color-ash)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            opacity={0.4}
          />
        )}
        
        {/* Points area (solid) - what user sets */}
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
      
      {/* Profile pictures at corners - size scales with weight, full colored */}
      {agents.map(({ id, label, hotkey }) => {
        const typeLabels = { instinct: 'Instinct', logic: 'Logic', psyche: 'Psyche' };
        
        // Offset profile pictures upward from label point to avoid overlapping chart
        // Logic is at top (-90°), so needs more upward offset
        const verticalOffset = id === 'logic' ? -imageSize * 0.8 : (id === 'psyche' || id === 'instinct' ? -imageSize * 0.3 : 0);
        
        return (
          <div
            key={id}
            className="absolute flex flex-col items-center transition-all duration-300"
            style={{
              left: `${label.x - imageSize / 2}px`,
              top: `${label.y - imageSize / 2 + verticalOffset}px`,
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDominantTraitSelect?.(id);
              }}
              className="relative cursor-pointer group/profile"
            >
              <div
                className="rounded-full overflow-visible transition-all duration-300 relative"
                style={{
                  width: imageSize,
                  height: imageSize,
                }}
              >
                <img
                  src={PROFILE_IMAGES[id]}
                  alt={AGENTS[id].name}
                  className="w-full h-full object-cover rounded-full"
                />
                {/* Selected indicator ring - outer border with padding */}
                {selectedDominantTrait === id && (
                  <div
                    className="absolute rounded-full border-2 pointer-events-none"
                    style={{
                      borderColor: AGENTS[id].color,
                      left: '-3px',
                      top: '-3px',
                      width: `calc(100% + 6px)`,
                      height: `calc(100% + 6px)`,
                      boxShadow: `0 0 0 2px var(--color-obsidian), 0 0 8px ${AGENTS[id].color}, 0 0 12px ${AGENTS[id].color}60`,
                    }}
                  />
                )}
                {/* Hover ring */}
                {selectedDominantTrait !== id && (
                  <div
                    className="absolute rounded-full border-2 opacity-0 group-hover/profile:opacity-100 transition-opacity pointer-events-none"
                    style={{
                      borderColor: AGENTS[id].color,
                      left: '-2px',
                      top: '-2px',
                      width: `calc(100% + 4px)`,
                      height: `calc(100% + 4px)`,
                    }}
                  />
                )}
              </div>
            </button>
            <div className="flex flex-col items-center gap-1.5 mt-2">
              <div className="flex items-center gap-1.5">
                <span 
                  className="text-[9px] font-sans px-1.5 py-0.5 rounded-full"
                  style={{ 
                    backgroundColor: `${AGENTS[id].color}20`,
                    color: AGENTS[id].color,
                  }}
                >
                  {typeLabels[id]}
                </span>
                <kbd 
                  className="text-[8px] font-sans px-1 py-0.5 rounded bg-smoke/30 text-ash/50"
                >
                  ⌘{hotkey}
                </kbd>
              </div>
              
              {/* Point selector controls */}
              {localPoints && onPointChange && (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPointChange(id, -1);
                    }}
                    disabled={localPoints[id] <= 2}
                    className={`w-5 h-5 rounded border flex items-center justify-center transition-all font-sans text-[10px] ${
                      localPoints[id] > 2
                        ? 'border-ash/50 hover:border-ash/70 hover:bg-smoke/30 cursor-pointer active:scale-95'
                        : 'border-ash/20 opacity-30 cursor-not-allowed'
                    }`}
                    style={{
                      borderColor: localPoints[id] > 2 ? `${AGENTS[id].color}50` : undefined,
                    }}
                  >
                    <span className="text-ash/80">−</span>
                  </button>
                  
                  <div 
                    className="px-2 py-0.5 rounded border tabular-nums min-w-[24px] text-center"
                    style={{
                      backgroundColor: `${AGENTS[id].color}15`,
                      borderColor: `${AGENTS[id].color}40`,
                      color: AGENTS[id].color,
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    <span className="text-xs font-bold">{localPoints[id]}</span>
                  </div>
                  
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPointChange(id, +1);
                    }}
                    disabled={
                      localPoints[id] >= 6 || 
                      ((localPoints.instinct + localPoints.logic + localPoints.psyche) >= 12 &&
                      !(['instinct', 'logic', 'psyche'] as const).some(t => t !== id && localPoints[t] > 2))
                    }
                    className={`w-5 h-5 rounded border flex items-center justify-center transition-all font-sans text-[10px] ${
                      localPoints[id] < 6 && (
                        (localPoints.instinct + localPoints.logic + localPoints.psyche) < 12 ||
                        (['instinct', 'logic', 'psyche'] as const).some(t => t !== id && localPoints[t] > 2)
                      )
                        ? 'border-ash/50 hover:border-ash/70 hover:bg-smoke/30 cursor-pointer active:scale-95'
                        : 'border-ash/20 opacity-30 cursor-not-allowed'
                    }`}
                    style={{
                      borderColor: (
                        localPoints[id] < 6 && (
                          (localPoints.instinct + localPoints.logic + localPoints.psyche) < 12 ||
                          (['instinct', 'logic', 'psyche'] as const).some(t => t !== id && localPoints[t] > 2)
                        )
                      ) ? `${AGENTS[id].color}50` : undefined,
                    }}
                  >
                    <span className="text-ash/80">+</span>
                  </button>
                </div>
              )}
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

export function Settings({ isOpen, onClose }: SettingsProps) {
  const { 
    userProfile, 
    setUserProfile,
    activePersonaProfile,
    setActivePersonaProfile,
    clearMessages,
    addMessage,
    setCurrentConversation,
  } = useAppStore();
  const [showApiModal, setShowApiModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [includeConversations, setIncludeConversations] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  // Convert weights to points (12 total, each 2-7)
  const weightsToPoints = (weight: number) => Math.round(weight * 12);
  const pointsToWeight = (points: number) => points / 12;
  
  const [localPoints, setLocalPoints] = useState({
    instinct: weightsToPoints(userProfile?.instinctWeight ?? 0.3),
    logic: weightsToPoints(userProfile?.logicWeight ?? 0.4),
    psyche: weightsToPoints(userProfile?.psycheWeight ?? 0.3),
  });
  
  // Manually selected dominant trait (independent of points)
  const [selectedDominantTrait, setSelectedDominantTrait] = useState<'instinct' | 'logic' | 'psyche' | null>(null);
  
  // Initialize selected dominant trait from active persona profile
  useEffect(() => {
    if (activePersonaProfile && selectedDominantTrait === null) {
      setSelectedDominantTrait(activePersonaProfile.dominantTrait);
    }
  }, [activePersonaProfile, selectedDominantTrait]);
  
  // Animated weights for smooth transitions
  const [animatedWeights, setAnimatedWeights] = useState({
    logic: userProfile?.logicWeight ?? 0.4,
    instinct: userProfile?.instinctWeight ?? 0.3,
    psyche: userProfile?.psycheWeight ?? 0.3,
  });
  
  // Update local points when active persona profile changes
  useEffect(() => {
    if (!activePersonaProfile) return;
    setLocalPoints({
      instinct: activePersonaProfile.instinctPoints,
      logic: activePersonaProfile.logicPoints,
      psyche: activePersonaProfile.psychePoints,
    });
  }, [activePersonaProfile]);

  // Convert points to weights for animation
  const currentWeights = {
    instinct: pointsToWeight(localPoints.instinct),
    logic: pointsToWeight(localPoints.logic),
    psyche: pointsToWeight(localPoints.psyche),
  };

  // Animate weight transitions when local points change
  useEffect(() => {
    const targetWeights = currentWeights;
    const startWeights = { ...animatedWeights };
    const duration = 150;
    const startTime = performance.now();
    
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
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
  }, [localPoints]);
  
  // Handle point changes from skill selector
  const handlePointChange = useCallback(async (trait: 'instinct' | 'logic' | 'psyche', delta: number) => {
    const newPoints = { ...localPoints };
    const currentTotal = localPoints.instinct + localPoints.logic + localPoints.psyche;
    const newValue = newPoints[trait] + delta;
    
    // Enforce constraints: min 2, max 6
    if (newValue < 2 || newValue > 6) return;
    
    // Calculate new total
    const newTotal = currentTotal + delta;
    
    // Only prevent increases if total would exceed 12 (no automatic reallocation)
    // Allow decreases freely (no automatic reallocation)
    if (delta > 0 && newTotal > 12) {
      // Can't increase if it would exceed 12 total
      return;
    }
    
    // Allow the change (either increase within limit, or any decrease)
    newPoints[trait] = newValue;
    
    setLocalPoints(newPoints);
    
    // Save points separately (not converted to weights)
    try {
      await updatePoints(newPoints.instinct, newPoints.logic, newPoints.psyche);
      // Refresh active persona profile to get updated points
      const updatedPersona = await getActivePersonaProfile();
      if (updatedPersona) {
        setActivePersonaProfile(updatedPersona);
      }
      // Also refresh user profile for weights (which may have changed from background analysis)
      const updatedProfile = await getUserProfile();
      setUserProfile(updatedProfile);
    } catch (err) {
      console.error('Failed to update points:', err);
    }
  }, [localPoints, setUserProfile, setActivePersonaProfile]);

  // Handle reset personalization
  const handleReset = useCallback(async () => {
    if (!activePersonaProfile) return;
    
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/b1642af4-d9a7-4f6d-adc2-21b0e5a3bf37',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Settings.tsx:handleReset:entry',message:'Reset initiated',data:{profileId:activePersonaProfile.id,includeConversations,beforeWeights:{i:userProfile?.instinctWeight,l:userProfile?.logicWeight,p:userProfile?.psycheWeight},beforeMsgCount:activePersonaProfile.messageCount},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2,H3,H5'})}).catch(()=>{});
    // #endregion
    
    setIsResetting(true);
    try {
      await resetPersonalization(activePersonaProfile.id, includeConversations);
      
      // #region agent log
      fetch('http://127.0.0.1:7246/ingest/b1642af4-d9a7-4f6d-adc2-21b0e5a3bf37',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Settings.tsx:handleReset:afterCall',message:'resetPersonalization returned',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2'})}).catch(()=>{});
      // #endregion
      
      // Refresh data
      const updatedPersona = await getActivePersonaProfile();
      
      // #region agent log
      fetch('http://127.0.0.1:7246/ingest/b1642af4-d9a7-4f6d-adc2-21b0e5a3bf37',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Settings.tsx:handleReset:afterPersonaRefresh',message:'Got updated persona',data:{afterWeights:{i:updatedPersona?.instinctWeight,l:updatedPersona?.logicWeight,p:updatedPersona?.psycheWeight},afterMsgCount:updatedPersona?.messageCount,afterPoints:{i:updatedPersona?.instinctPoints,l:updatedPersona?.logicPoints,p:updatedPersona?.psychePoints}},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H3,H5'})}).catch(()=>{});
      // #endregion
      
      if (updatedPersona) {
        setActivePersonaProfile(updatedPersona);
        // Reset local points to match (should now be 4, 4, 4)
        setLocalPoints({
          instinct: updatedPersona.instinctPoints,
          logic: updatedPersona.logicPoints,
          psyche: updatedPersona.psychePoints,
        });
        // Also reset selected dominant trait
        setSelectedDominantTrait(null);
      }
      const updatedProfile = await getUserProfile();
      
      // #region agent log
      fetch('http://127.0.0.1:7246/ingest/b1642af4-d9a7-4f6d-adc2-21b0e5a3bf37',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Settings.tsx:handleReset:afterProfileRefresh',message:'Got updated user profile',data:{afterWeights:{i:updatedProfile?.instinctWeight,l:updatedProfile?.logicWeight,p:updatedProfile?.psycheWeight}},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2,H3'})}).catch(()=>{});
      // #endregion
      
      setUserProfile(updatedProfile);
      
      // Start a new conversation
      clearMessages();
      const newConvo = await createConversation(false);
      setCurrentConversation(newConvo);
      
      // Get and add the opening message
      const opener = await getConversationOpener(false);
      addMessage({
        id: crypto.randomUUID(),
        conversationId: newConvo.id,
        role: 'governor',
        content: opener.content,
        timestamp: new Date(),
      });
      
      // #region agent log
      fetch('http://127.0.0.1:7246/ingest/b1642af4-d9a7-4f6d-adc2-21b0e5a3bf37',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Settings.tsx:handleReset:newConvo',message:'Started new conversation',data:{convoId:newConvo?.id},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H8'})}).catch(()=>{});
      // #endregion
      
      setShowResetModal(false);
      setIncludeConversations(false);
    } catch (err) {
      // #region agent log
      fetch('http://127.0.0.1:7246/ingest/b1642af4-d9a7-4f6d-adc2-21b0e5a3bf37',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'Settings.tsx:handleReset:error',message:'Reset failed',data:{error:String(err)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2,H3,H4,H5'})}).catch(()=>{});
      // #endregion
      console.error('Failed to reset personalization:', err);
    } finally {
      setIsResetting(false);
    }
  }, [activePersonaProfile, includeConversations, setActivePersonaProfile, setUserProfile, userProfile, clearMessages, setCurrentConversation, addMessage]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't close Settings if API modal is open - let it close first
      // Close reset modal with ESC (or ⌘ESC)
      if (e.key === 'Escape' && showResetModal && !isResetting) {
        e.preventDefault();
        setShowResetModal(false);
        return;
      }
      // Close Settings with ESC (but not if modals are open)
      if (e.key === 'Escape' && isOpen && !showApiModal && !showResetModal) {
        onClose();
      }
      // ⌘K to open API key modal
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && isOpen) {
        e.preventDefault();
        setShowApiModal(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, showApiModal, showResetModal, isResetting]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop - absolute to respect app-container clipping */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-void/80 backdrop-blur-sm z-40"
          />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="absolute right-2 top-2 w-[480px] max-h-[calc(100%-16px)] bg-obsidian/98 backdrop-blur-xl border border-smoke/40 rounded-2xl z-50 flex flex-col shadow-2xl"
          >
            {/* Header - Started date and ESC */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-smoke/30 flex-shrink-0">
              {activePersonaProfile && (
                <div className="flex items-center gap-2 text-[11px] text-ash/70 font-sans">
                  <Calendar className="w-3.5 h-3.5 text-ash/50" strokeWidth={1.5} />
                  <span>Started {formatDate(activePersonaProfile.createdAt)}</span>
                  <span className="px-2 py-0.5 bg-smoke/40 rounded-full text-ash/60">{activePersonaProfile.messageCount} messages</span>
                </div>
              )}
              <button
                onClick={onClose}
                className="px-2 py-1 rounded text-[9px] font-sans text-ash bg-smoke/30 hover:bg-smoke/50 border border-smoke/50 transition-colors cursor-pointer flex items-center justify-center"
              >
                ESC
              </button>
            </div>

            <div className="p-4 space-y-4 flex-1 overflow-y-auto">

              {/* Archetypes Section */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-[10px] font-sans text-ash/50 uppercase tracking-wider">Archetypes</p>
                  <a
                    href="https://www.discoelysium.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[9px] text-amber-400/80 hover:text-amber-300 hover:bg-amber-500/20 hover:border-amber-500/50 font-sans transition-all cursor-pointer"
                  >
                    <span>Inspired by Disco Elysium</span>
                    <ExternalLink className="w-2.5 h-2.5" strokeWidth={1.5} />
                  </a>
                </div>
                <div className="flex gap-2">
                  {(Object.keys(ARCHETYPES) as Array<keyof typeof ARCHETYPES>).map((key) => {
                    const archetype = ARCHETYPES[key];
                    const isActive = 
                      localPoints.logic === archetype.points.logic &&
                      localPoints.instinct === archetype.points.instinct &&
                      localPoints.psyche === archetype.points.psyche &&
                      selectedDominantTrait === archetype.dominant;
                    
                    return (
                      <button
                        key={key}
                        onClick={async () => {
                          // Set points
                          setLocalPoints(archetype.points);
                          // Set dominant trait
                          setSelectedDominantTrait(archetype.dominant);
                          // Save to backend
                          try {
                            await updatePoints(
                              archetype.points.instinct,
                              archetype.points.logic,
                              archetype.points.psyche
                            );
                            // Update dominant trait
                            await updateDominantTrait(archetype.dominant);
                            // Refresh profiles
                            const updatedProfile = await getUserProfile();
                            setUserProfile(updatedProfile);
                            const activePersona = await getActivePersonaProfile();
                            if (activePersona) {
                              setActivePersonaProfile(activePersona);
                            }
                          } catch (err) {
                            console.error('Failed to apply archetype:', err);
                          }
                        }}
                        className={`flex-1 relative h-20 rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                          isActive
                            ? 'border-amber-500 shadow-lg shadow-amber-500/20'
                            : 'border-transparent hover:border-smoke/50'
                        }`}
                      >
                        {/* Background image */}
                        <img 
                          src={archetype.image} 
                          alt={archetype.name}
                          className="absolute inset-0 w-full h-full object-cover"
                          style={{ objectPosition: archetype.imagePosition }}
                        />
                        {/* Dark overlay for text readability */}
                        <div className={`absolute inset-0 transition-all ${
                          isActive 
                            ? 'bg-gradient-to-t from-black/80 via-black/40 to-black/20' 
                            : 'bg-gradient-to-t from-black/70 via-black/30 to-black/10 hover:from-black/60'
                        }`} />
                        {/* Archetype name */}
                        <div className="absolute inset-0 flex items-end justify-center pb-2">
                          <span className={`text-sm font-bold uppercase tracking-widest drop-shadow-lg ${
                            isActive ? 'text-amber-400' : 'text-white/90'
                          }`}>
                            {archetype.name}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Agent weights - Radar chart */}
              {activePersonaProfile && (
                <section>
                  
                  <div 
                    className="rounded-xl p-4 border border-smoke/30 relative overflow-hidden"
                    style={{
                      // Dynamic gradient based on INVERTED weights (lower = more dominant)
                      // Colors: Logic #00D4FF, Psyche #E040FB, Instinct #EF4444
                      paddingBottom: '67px',
                      background: (() => {
                        const logicInv = 1 - (userProfile?.logicWeight ?? 0.333);
                        const psycheInv = 1 - (userProfile?.psycheWeight ?? 0.333);
                        const instinctInv = 1 - (userProfile?.instinctWeight ?? 0.333);
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
                    {/* Points display - top right inside the box */}
                    <div className="absolute top-4 right-4 z-20">
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-smoke/30 bg-obsidian/90 backdrop-blur-sm">
                        <span 
                          className={`text-xs font-bold tabular-nums ${
                            localPoints.instinct + localPoints.logic + localPoints.psyche === 12
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }`}
                          style={{ fontFamily: 'var(--font-sans)' }}
                        >
                          {localPoints.instinct + localPoints.logic + localPoints.psyche}
                        </span>
                        <span className="text-[10px] font-sans text-ash/40">
                          / 12
                        </span>
                      </div>
                    </div>
                    
                    {/* Info tooltip - Educational explanation */}
                    <div className="absolute top-4 left-4 z-50">
                      <div className="group/info relative flex-shrink-0">
                        <Info className="w-4 h-4 text-ash/50 hover:text-ash/70 transition-colors cursor-pointer" strokeWidth={1.5} />
                        {/* Expanded educational tooltip */}
                        <div className="absolute left-0 top-full mt-2 z-50 w-80 px-4 py-3 bg-obsidian/95 backdrop-blur-xl border border-smoke/40 rounded-lg opacity-0 invisible group-hover/info:opacity-100 group-hover/info:visible transition-all shadow-xl pointer-events-none">
                          <h4 className="text-xs font-semibold text-ash mb-2 font-sans">Understanding the Triangles</h4>
                          
                          <div className="space-y-2">
                            <div className="text-[10px] text-ash/70 font-sans leading-relaxed flex items-start gap-2">
                              <span className="inline-block w-3 h-0.5 mt-1.5 bg-gradient-to-r from-red-400 via-cyan-400 to-purple-400 rounded shrink-0" />
                              <span><span className="text-pearl font-medium">Solid triangle</span> — Your points. What you set to prioritize voices.</span>
                            </div>
                            
                            <div className="text-[10px] text-ash/70 font-sans leading-relaxed flex items-start gap-2">
                              <span className="inline-block w-3 h-0.5 mt-1.5 border-t border-dashed border-ash/60 shrink-0" />
                              <span><span className="text-ash/80 font-medium">Dotted triangle</span> — Learned weights. What Intersect observes from your engagement.</span>
                            </div>
                            
                            <div className="text-[10px] text-ash/70 font-sans leading-relaxed mt-2 pt-2 border-t border-smoke/30">
                              <span className="text-amber-400 font-medium">Dominant Trait</span> — Click a portrait to choose how Governor speaks to you.
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Subtle radial overlay for depth */}
                    <div 
                      className="absolute inset-0 opacity-20"
                      style={{
                        background: (() => {
                          const logicInv = 1 - (userProfile?.logicWeight ?? 0.333);
                          const psycheInv = 1 - (userProfile?.psycheWeight ?? 0.333);
                          const instinctInv = 1 - (userProfile?.instinctWeight ?? 0.333);
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
                    
                    <div className="relative z-10 pt-[132px]">
                      <RadarChart 
                        weights={{
                          instinct: animatedWeights.instinct,
                          logic: animatedWeights.logic,
                          psyche: animatedWeights.psyche,
                        }}
                        learnedWeights={userProfile ? {
                          instinct: (userProfile?.instinctWeight ?? 0.333),
                          logic: (userProfile?.logicWeight ?? 0.333),
                          psyche: (userProfile?.psycheWeight ?? 0.333),
                        } : undefined}
                        localPoints={localPoints}
                        onPointChange={handlePointChange}
                        selectedDominantTrait={selectedDominantTrait}
                        onDominantTraitSelect={setSelectedDominantTrait}
                      />
                    </div>
                  </div>
                </section>
              )}

            </div>



            {/* Footer - sticky at bottom */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-smoke/30 shrink-0">
              {/* Left: Copyright + Reset */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <img src={governorTransparent} alt="" className="w-4 h-4 opacity-60" />
                  <p className="text-xs text-ash/60 font-sans">Intersect v1.2.0</p>
                </div>
                <button
                  onClick={() => setShowResetModal(true)}
                  className="flex items-center gap-1 px-2 py-1 rounded-full border border-smoke/30 text-[10px] text-ash/50 hover:text-red-400 hover:border-red-400/30 transition-colors font-sans"
                  title="Reset Personalization"
                >
                  <RefreshCw size={12} />
                  Reset
                </button>
              </div>
              {/* Right: Connected + API Key */}
              <div className="flex items-center gap-2">
                {userProfile?.apiKey && (
                  <span className="flex items-center gap-1 px-2 py-1 rounded-full border border-smoke/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span className="text-[10px] text-emerald-500/80 font-sans">Connected</span>
                  </span>
                )}
                <button
                  onClick={() => setShowApiModal(true)}
                  className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-ash/60 hover:text-pearl hover:bg-smoke/30 transition-colors cursor-pointer"
                  title="Change API Key (⌘K)"
                >
                  <ApiKeyIcon size={14} className="shrink-0" />
                  <kbd className="w-5 h-5 bg-smoke/30 rounded text-[9px] font-sans text-ash/50 border border-smoke/40 flex items-center justify-center">⌘K</kbd>
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

          {/* Reset Personalization Modal */}
          <AnimatePresence>
            {showResetModal && (
              <motion.div
                className="fixed inset-0 flex items-center justify-center z-70"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {/* Backdrop */}
                <div 
                  className="absolute inset-0 bg-obsidian/80 backdrop-blur-sm"
                  onClick={() => !isResetting && setShowResetModal(false)}
                />
                
                {/* Modal */}
                <motion.div
                  className="relative bg-obsidian/95 backdrop-blur-xl border border-smoke/40 rounded-xl p-5 w-[340px] shadow-2xl font-sans"
                  initial={{ scale: 0.95, opacity: 0, y: 10 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.95, opacity: 0, y: 10 }}
                  transition={{ type: 'spring', damping: 25, stiffness: 400 }}
                >
                  {/* ESC button */}
                  <button
                    onClick={() => !isResetting && setShowResetModal(false)}
                    className="absolute top-3 right-3 px-2 py-1 text-[10px] text-ash/40 hover:text-ash/60 border border-smoke/30 rounded transition-colors"
                  >
                    ⌘ ESC
                  </button>
                  
                  <h3 className="text-lg font-medium text-pearl mb-2">Reset Personalization</h3>
                  <p className="text-xs text-ash/70 mb-4 leading-relaxed">
                    This will reset your weights to defaults and clear learned patterns. 
                    Your API keys, points, and dominant trait will be preserved.
                  </p>
                  
                  {/* Checkbox for including conversations */}
                  <label className="flex items-center gap-2 mb-4 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={includeConversations}
                      onChange={(e) => setIncludeConversations(e.target.checked)}
                      className="w-4 h-4 rounded border border-smoke/40 bg-transparent checked:bg-red-500 checked:border-red-500"
                    />
                    <span className="text-xs text-ash/60 group-hover:text-ash/80 transition-colors">
                      Also delete conversation history
                    </span>
                  </label>
                  
                  {/* Buttons */}
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => {
                        setShowResetModal(false);
                        setIncludeConversations(false);
                      }}
                      disabled={isResetting}
                      className="px-3 py-1.5 text-xs text-ash/60 hover:text-ash transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleReset}
                      disabled={isResetting}
                      className="px-3 py-1.5 text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded transition-colors disabled:opacity-50"
                    >
                      {isResetting ? 'Resetting...' : 'Reset'}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}
