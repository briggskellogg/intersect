import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, Key, Info } from 'lucide-react';
import { useAppStore } from '../store';
import { AGENTS } from '../constants/agents';
import { 
  getUserProfile, 
  updatePoints,
  getActivePersonaProfile,
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

interface RadarChartProps {
  weights: { instinct: number; logic: number; psyche: number };
  targetWeights?: { instinct: number; logic: number; psyche: number };
  localPoints?: { instinct: number; logic: number; psyche: number };
  onPointChange?: (trait: 'instinct' | 'logic' | 'psyche', delta: number) => void;
  selectedDominantTrait?: 'instinct' | 'logic' | 'psyche' | null;
  onDominantTraitSelect?: (trait: 'instinct' | 'logic' | 'psyche') => void;
}

// Radar chart component for agent weights with profile pictures
function RadarChart({ 
  weights, 
  targetWeights: _targetWeights,
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
  
  // Image sizes scale with weight
  const minImageSize = 52;
  const maxImageSize = 72;
  
  const getImageSize = (weight: number) => {
    const clamped = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weight));
    const normalized = (clamped - MIN_WEIGHT) / (MAX_WEIGHT - MIN_WEIGHT);
    return minImageSize + normalized * (maxImageSize - minImageSize);
  };
  
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
      
      {/* Profile pictures at corners - size scales with weight, full colored */}
      {agents.map(({ id, label, weight, hotkey }) => {
        const typeLabels = { instinct: 'Instinct', logic: 'Logic', psyche: 'Psyche' };
        const imgSize = getImageSize(weight);
        
        // Offset profile pictures upward from label point to avoid overlapping chart
        // Logic is at top (-90°), so needs more upward offset
        const verticalOffset = id === 'logic' ? -imgSize * 0.8 : (id === 'psyche' || id === 'instinct' ? -imgSize * 0.3 : 0);
        
        return (
          <div
            key={id}
            className="absolute flex flex-col items-center transition-all duration-300"
            style={{
              left: `${label.x - imgSize / 2}px`,
              top: `${label.y - imgSize / 2 + verticalOffset}px`,
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
                  width: imgSize,
                  height: imgSize,
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
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded-full"
                  style={{ 
                    backgroundColor: `${AGENTS[id].color}20`,
                    color: AGENTS[id].color,
                  }}
                >
                  {typeLabels[id]}
                </span>
                <kbd 
                  className="text-[8px] font-mono px-1 py-0.5 rounded bg-smoke/30 text-ash/50"
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
                    className={`w-5 h-5 rounded border flex items-center justify-center transition-all font-mono text-[10px] ${
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
                      fontFamily: 'var(--font-mono)',
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
                      ((localPoints.instinct + localPoints.logic + localPoints.psyche) >= 11 &&
                      !(['instinct', 'logic', 'psyche'] as const).some(t => t !== id && localPoints[t] > 2))
                    }
                    className={`w-5 h-5 rounded border flex items-center justify-center transition-all font-mono text-[10px] ${
                      localPoints[id] < 6 && (
                        (localPoints.instinct + localPoints.logic + localPoints.psyche) < 11 ||
                        (['instinct', 'logic', 'psyche'] as const).some(t => t !== id && localPoints[t] > 2)
                      )
                        ? 'border-ash/50 hover:border-ash/70 hover:bg-smoke/30 cursor-pointer active:scale-95'
                        : 'border-ash/20 opacity-30 cursor-not-allowed'
                    }`}
                    style={{
                      borderColor: (
                        localPoints[id] < 6 && (
                          (localPoints.instinct + localPoints.logic + localPoints.psyche) < 11 ||
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
  } = useAppStore();
  const [showApiModal, setShowApiModal] = useState(false);
  // Convert weights to points (11 total, each 2-6)
  const weightsToPoints = (weight: number) => Math.round(weight * 11);
  const pointsToWeight = (points: number) => points / 11;
  
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
    
    // Only prevent increases if total would exceed 11 (no automatic reallocation)
    // Allow decreases freely (no automatic reallocation)
    if (delta > 0 && newTotal > 11) {
      // Can't increase if it would exceed 11 total
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
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, showApiModal]);

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
              <div className="inline-flex px-2.5 py-1 rounded-full bg-smoke/20 border border-smoke/40">
                <h2 className="font-mono text-xs text-pearl font-medium uppercase tracking-wider">PROFILE</h2>
              </div>
              {/* ESC button */}
              <button
                onClick={onClose}
                className="p-1 rounded text-[9px] font-mono text-ash bg-smoke/30 hover:bg-smoke/50 border border-smoke/50 transition-colors cursor-pointer aspect-square flex items-center justify-center"
              >
                ESC
              </button>
            </div>

            <div className="p-4 space-y-5 flex-1 overflow-y-auto">

              {/* Agent weights - Radar chart */}
              {userProfile && (
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2 text-[11px] text-ash/70 font-mono">
                      <Calendar className="w-4 h-4 text-ash/60" strokeWidth={1.5} />
                      <span>Started on {formatDate(userProfile.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-ash/70 font-mono">
                      <span className="tabular-nums">{userProfile.totalMessages}</span>
                      <span className="text-ash/50">messages</span>
                    </div>
                  </div>
                  
                  <div 
                    className="rounded-xl p-4 border border-smoke/30 relative overflow-hidden"
                    style={{
                      // Dynamic gradient based on INVERTED weights (lower = more dominant)
                      // Colors: Logic #00D4FF, Psyche #E040FB, Instinct #EF4444
                      paddingBottom: '67px',
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
                    {/* Points display - top right inside the box */}
                    <div className="absolute top-4 right-4 z-20">
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-smoke/30 bg-obsidian/90 backdrop-blur-sm">
                        <span 
                          className={`text-xs font-bold tabular-nums ${
                            localPoints.instinct + localPoints.logic + localPoints.psyche === 11
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }`}
                          style={{ fontFamily: 'var(--font-mono)' }}
                        >
                          {localPoints.instinct + localPoints.logic + localPoints.psyche}
                        </span>
                        <span className="text-[10px] font-mono text-ash/40">
                          / 11
                        </span>
                      </div>
                    </div>
                    
                    {/* Info tooltip */}
                    <div className="absolute top-4 left-4 z-50">
                      <div className="group/info relative flex-shrink-0">
                        <Info className="w-4 h-4 text-ash/50 hover:text-ash/70 transition-colors cursor-pointer" strokeWidth={1.5} />
                        {/* Tooltip */}
                        <div className="absolute left-0 top-full mt-2 z-50 w-64 px-3 py-2 bg-obsidian/95 backdrop-blur-xl border border-smoke/40 rounded-lg opacity-0 invisible group-hover/info:opacity-100 group-hover/info:visible transition-all shadow-xl pointer-events-none">
                          <p className="text-[10px] text-ash/70 font-mono leading-relaxed">
                            Adjust how the Governor thinks—give more points to the voices you want to hear most often. Choose your dominant trait to shape how the Governor sees and talks to you.
                          </p>
                        </div>
                      </div>
                    </div>
                    
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
                    
                    <div className="relative z-10 pt-[132px]">
                      <RadarChart 
                        weights={{
                          instinct: animatedWeights.instinct,
                          logic: animatedWeights.logic,
                          psyche: animatedWeights.psyche,
                        }}
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
            <div className="flex items-center justify-between px-4 py-3 border-t border-smoke/30 flex-shrink-0">
              <div className="flex items-center gap-1.5">
                <img src={governorTransparent} alt="" className="w-4 h-4 opacity-60" />
                <p className="text-xs text-ash/60 font-mono">Intersect v1.1.0</p>
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
