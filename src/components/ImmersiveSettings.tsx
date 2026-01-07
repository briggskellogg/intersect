import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore, addBackgroundMusic, removeBackgroundMusic } from '../store';
import { DISCO_AGENTS, GOVERNOR } from '../constants/agents';
import { Play, Square, Music, Trash2, Plus, Volume2, ElevenLabsIcon } from './icons';
import { v4 as uuidv4 } from 'uuid';

interface ImmersiveSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenApiKeys: () => void;
}

type VoiceGroup = 'disco' | 'instinct' | 'logic' | 'psyche' | 'governor';

// Sample text for voice preview
const PREVIEW_TEXTS: Record<VoiceGroup, string> = {
  disco: "Why are you really avoiding this?",
  instinct: "Your gut is screaming. Are you listening?",
  logic: "Let's analyze the actual data here.",
  psyche: "What are you really feeling right now?",
  governor: "Let me synthesize what we've discussed.",
};

export function ImmersiveSettings({ isOpen, onClose }: ImmersiveSettingsProps) {
  const { 
    elevenLabsApiKey,
    immersiveVoices, 
    setImmersiveVoice,
    usePerAgentVoices,
    setUsePerAgentVoices,
    backgroundMusic,
    backgroundMusicVolume,
    setBackgroundMusicVolume,
  } = useAppStore();
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [localVoices, setLocalVoices] = useState({
    disco: (immersiveVoices as Record<string, string | null>).thoughtsDisco || '',
    instinct: immersiveVoices.instinct || '',
    logic: immersiveVoices.logic || '',
    psyche: immersiveVoices.psyche || '',
    governor: immersiveVoices.governor || '',
  });
  const [localUsePerAgent, setLocalUsePerAgent] = useState(usePerAgentVoices);
  const [previewingVoice, setPreviewingVoice] = useState<VoiceGroup | null>(null);
  const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);

  // Sync with store
  useEffect(() => {
    setLocalVoices({
      disco: (immersiveVoices as Record<string, string | null>).thoughtsDisco || '',
      instinct: immersiveVoices.instinct || '',
      logic: immersiveVoices.logic || '',
      psyche: immersiveVoices.psyche || '',
      governor: immersiveVoices.governor || '',
    });
    setLocalUsePerAgent(usePerAgentVoices);
  }, [immersiveVoices, usePerAgentVoices, isOpen]);

  // ESC to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const handleSave = () => {
    // Save per-agent toggle
    setUsePerAgentVoices(localUsePerAgent);
    // Save disco voice (used for all agent thoughts when not using per-agent)
    setImmersiveVoice('thoughtsDisco', localVoices.disco || null);
    // Save individual agent voices
    setImmersiveVoice('instinct', localVoices.instinct || null);
    setImmersiveVoice('logic', localVoices.logic || null);
    setImmersiveVoice('psyche', localVoices.psyche || null);
    // Save governor voice
    setImmersiveVoice('governor', localVoices.governor || null);
    onClose();
  };

  const handlePreviewVoice = async (group: VoiceGroup) => {
    const voiceId = localVoices[group];
    if (!voiceId || !elevenLabsApiKey) return;

    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }

    setPreviewingVoice(group);

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': elevenLabsApiKey,
          },
          body: JSON.stringify({
            text: PREVIEW_TEXTS[group],
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

      if (!response.ok) throw new Error('Failed to preview');

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setPreviewingVoice(null);
        setPreviewAudio(null);
      };
      
      setPreviewAudio(audio);
      audio.play();
    } catch (err) {
      console.error('Voice preview error:', err);
      setPreviewingVoice(null);
    }
  };

  const stopPreview = () => {
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
      setPreviewAudio(null);
    }
    setPreviewingVoice(null);
  };

  const canPreview = (group: VoiceGroup) => !!localVoices[group] && !!elevenLabsApiKey;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm z-40"
            onClick={onClose}
          />

          {/* Centered Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none"
          >
            <div className="w-80 bg-slate-900/95 backdrop-blur-2xl rounded-2xl border border-slate-700/40 shadow-2xl pointer-events-auto overflow-hidden font-sans">
              {/* Header */}
              <div className="px-5 py-4 border-b border-slate-700/30 flex items-center justify-between">
                <span className="text-sm font-sans text-slate-200">Voice Settings</span>
                <button
                  onClick={onClose}
                  className="px-1.5 py-0.5 rounded bg-slate-800/50 text-[9px] font-sans text-slate-500 border border-slate-700/30 hover:text-slate-300 hover:border-slate-600 transition-colors cursor-pointer"
                >
                  ESC
                </button>
              </div>

              {/* Content */}
              <div className="p-5 space-y-4">
                {/* Agent Voices Section */}
                <div className="space-y-3">
                  {/* Toggle: Single vs Per-Agent */}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">Agent Voices</span>
                    <button
                      onClick={() => setLocalUsePerAgent(!localUsePerAgent)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-medium transition-all border ${
                        localUsePerAgent
                          ? 'bg-purple-500/20 border-purple-500/40 text-purple-300'
                          : 'bg-slate-800/50 border-slate-700/40 text-slate-400'
                      }`}
                    >
                      {localUsePerAgent ? 'Per Agent' : 'Single Voice'}
                    </button>
                  </div>
                  
                  {/* Single voice for all agents */}
                  {!localUsePerAgent && (
                    <VoiceRow
                      sublabel="Swarm, Spin, Storm"
                      avatars={[DISCO_AGENTS.instinct.avatar, DISCO_AGENTS.logic.avatar, DISCO_AGENTS.psyche.avatar]}
                      value={localVoices.disco}
                      onChange={(v) => setLocalVoices(prev => ({ ...prev, disco: v }))}
                      isPreviewing={previewingVoice === 'disco'}
                      canPreview={canPreview('disco')}
                      onPreview={() => previewingVoice === 'disco' ? stopPreview() : handlePreviewVoice('disco')}
                      accentColor="#EF4444"
                      isDisco
                    />
                  )}
                  
                  {/* Per-agent voices */}
                  {localUsePerAgent && (
                    <div className="space-y-2">
                      <VoiceRow
                        label="Swarm"
                        avatars={[DISCO_AGENTS.instinct.avatar]}
                        value={localVoices.instinct}
                        onChange={(v) => setLocalVoices(prev => ({ ...prev, instinct: v }))}
                        isPreviewing={previewingVoice === 'instinct'}
                        canPreview={canPreview('instinct')}
                        onPreview={() => previewingVoice === 'instinct' ? stopPreview() : handlePreviewVoice('instinct')}
                        accentColor={DISCO_AGENTS.instinct.color}
                        single
                      />
                      <VoiceRow
                        label="Spin"
                        avatars={[DISCO_AGENTS.logic.avatar]}
                        value={localVoices.logic}
                        onChange={(v) => setLocalVoices(prev => ({ ...prev, logic: v }))}
                        isPreviewing={previewingVoice === 'logic'}
                        canPreview={canPreview('logic')}
                        onPreview={() => previewingVoice === 'logic' ? stopPreview() : handlePreviewVoice('logic')}
                        accentColor={DISCO_AGENTS.logic.color}
                        single
                      />
                      <VoiceRow
                        label="Storm"
                        avatars={[DISCO_AGENTS.psyche.avatar]}
                        value={localVoices.psyche}
                        onChange={(v) => setLocalVoices(prev => ({ ...prev, psyche: v }))}
                        isPreviewing={previewingVoice === 'psyche'}
                        canPreview={canPreview('psyche')}
                        onPreview={() => previewingVoice === 'psyche' ? stopPreview() : handlePreviewVoice('psyche')}
                        accentColor={DISCO_AGENTS.psyche.color}
                        single
                      />
                    </div>
                  )}
                </div>

                {/* Governor Voice */}
                <VoiceRow
                  label="Governor"
                  avatars={[GOVERNOR.avatar]}
                  value={localVoices.governor}
                  onChange={(v) => setLocalVoices(prev => ({ ...prev, governor: v }))}
                  isPreviewing={previewingVoice === 'governor'}
                  canPreview={canPreview('governor')}
                  onPreview={() => previewingVoice === 'governor' ? stopPreview() : handlePreviewVoice('governor')}
                  accentColor={GOVERNOR.color}
                  single
                />

                {/* Hint */}
                {!elevenLabsApiKey && (
                  <div className="flex items-center justify-center gap-1.5 pt-1">
                    <ElevenLabsIcon size={12} className="text-emerald-400/60" />
                    <p className="text-[10px] text-emerald-400/60">
                      Configure ElevenLabs API key in profile to enable voice
                    </p>
                  </div>
                )}
                
                {/* Divider */}
                <div className="border-t border-slate-700/30 my-3" />
                
                {/* Background Music Section */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Music size={14} className="text-slate-400" />
                    <span className="text-xs font-medium text-slate-300">Background Music</span>
                    <span className="text-[9px] text-slate-500 italic">shuffle + crossfade</span>
                  </div>
                  
                  {/* Volume slider */}
                  <div className="flex items-center gap-2">
                    <Volume2 size={12} className="text-slate-500" />
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={backgroundMusicVolume}
                      onChange={(e) => setBackgroundMusicVolume(parseFloat(e.target.value))}
                      className="flex-1 h-1 rounded-full appearance-none bg-slate-700/60 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400"
                    />
                    <span className="text-[10px] text-slate-500 w-8 text-right">{Math.round(backgroundMusicVolume * 100)}%</span>
                  </div>
                  
                  {/* Track list */}
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {backgroundMusic.map((track) => (
                      <div
                        key={track.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-800/40 border border-slate-700/30"
                      >
                        <Music size={10} className="text-emerald-400/60 flex-shrink-0" />
                        <span className="text-[10px] text-slate-400 flex-1 truncate">{track.name}</span>
                        <button
                          onClick={() => removeBackgroundMusic(track.id)}
                          className="text-slate-600 hover:text-red-400 transition-colors p-1 cursor-pointer"
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    ))}
                    
                    {backgroundMusic.length === 0 && (
                      <p className="text-[10px] text-slate-600 text-center py-2">No tracks added</p>
                    )}
                  </div>
                  
                  {/* Add track button */}
                  {backgroundMusic.length < 10 && (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".mp3,audio/mpeg"
                        multiple
                        className="hidden"
                        onChange={async (e) => {
                          const files = e.target.files;
                          if (!files) return;
                          
                          const filesToProcess = Array.from(files).slice(0, 10 - backgroundMusic.length);
                          
                          for (const file of filesToProcess) {
                            // Only accept mp3 files
                            if (!file.name.toLowerCase().endsWith('.mp3')) continue;
                            
                            const dataUrl = await new Promise<string>((resolve) => {
                              const reader = new FileReader();
                              reader.onload = () => resolve(reader.result as string);
                              reader.readAsDataURL(file);
                            });
                            
                            await addBackgroundMusic(uuidv4(), file.name, dataUrl);
                          }
                          
                          // Reset input
                          e.target.value = '';
                        }}
                      />
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full py-2 rounded-lg border border-dashed border-slate-700/50 text-[10px] text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors flex items-center justify-center gap-1.5"
                      >
                        <Plus size={12} />
                        Add MP3 tracks ({backgroundMusic.length}/10)
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-slate-700/30 flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200 border border-slate-700/40 hover:border-slate-600 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="flex-1 py-2 rounded-lg text-xs font-medium text-white transition-colors"
                  style={{ backgroundColor: '#E040FB' }}
                >
                  Save
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// Voice row component
interface VoiceRowProps {
  label?: string;
  sublabel?: string;
  avatars: string[];
  value: string;
  onChange: (value: string) => void;
  isPreviewing: boolean;
  canPreview: boolean;
  onPreview: () => void;
  accentColor: string;
  single?: boolean;
  isDisco?: boolean;
}

function VoiceRow({ label, sublabel, avatars, value, onChange, isPreviewing, canPreview, onPreview, accentColor, single, isDisco }: VoiceRowProps) {
  return (
    <div className="flex items-center gap-3">
      {/* Overlapping avatars */}
      <div className={`flex ${single ? '' : '-space-x-2'} flex-shrink-0`}>
        {avatars.map((avatar, i) => (
          <img 
            key={i} 
            src={avatar} 
            alt="" 
            className={`${single ? 'w-9 h-9' : 'w-7 h-7'} rounded-full ring-2 ring-slate-900`}
          />
        ))}
      </div>

      {/* Label and input */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1">
          {isDisco ? (
            <span className="px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[9px] font-medium border border-red-500/30">
              {sublabel}
            </span>
          ) : (
            <>
              {label && <span className="text-xs font-medium text-slate-300">{label}</span>}
              <span className="text-[9px] text-slate-600">{sublabel}</span>
            </>
          )}
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Voice ID"
          className="w-full px-2.5 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/40 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 text-[11px] font-sans"
        />
      </div>

      {/* Preview button */}
      <button
        onClick={onPreview}
        disabled={!canPreview}
        className="w-9 h-9 rounded-lg flex items-center justify-center transition-all disabled:opacity-20 border"
        style={{ 
          color: isPreviewing ? '#fff' : accentColor,
          borderColor: isPreviewing ? accentColor : 'rgba(100, 116, 139, 0.3)',
          backgroundColor: isPreviewing ? `${accentColor}30` : 'rgba(30, 41, 59, 0.5)',
        }}
        title={isPreviewing ? 'Stop' : 'Preview'}
      >
        {isPreviewing ? <Square size={12} /> : <Play size={14} />}
      </button>
    </div>
  );
}
