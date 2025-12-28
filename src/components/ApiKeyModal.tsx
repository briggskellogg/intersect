import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Loader2, Trash2, Check, AlertCircle, Circle, Mic } from 'lucide-react';
import { saveApiKey, saveAnthropicKey, removeApiKey, removeAnthropicKey, getUserProfile } from '../hooks/useTauri';
import { useAppStore } from '../store';
import governorIcon from '../assets/governor-transparent.png';
import instinctAvatar from '../assets/agents/instinct-incarnate.png';
import logicAvatar from '../assets/agents/logic-incarnate.png';
import psycheAvatar from '../assets/agents/psyche-incarnate.png';

interface ApiKeyModalProps {
  isOpen: boolean;
  onComplete: () => void;
  initialOpenAiKey?: string | null;
  initialAnthropicKey?: string | null;
  initialElevenLabsKey?: string | null;
}

type KeyStatus = 'none' | 'connected' | 'error';

export function ApiKeyModal({ isOpen, onComplete, initialOpenAiKey, initialAnthropicKey, initialElevenLabsKey }: ApiKeyModalProps) {
  const [openAiKey, setOpenAiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [elevenLabsKey, setElevenLabsKey] = useState('');
  const [openAiStatus, setOpenAiStatus] = useState<KeyStatus>(initialOpenAiKey ? 'connected' : 'none');
  const [anthropicStatus, setAnthropicStatus] = useState<KeyStatus>(initialAnthropicKey ? 'connected' : 'none');
  const [elevenLabsStatus, setElevenLabsStatus] = useState<KeyStatus>(initialElevenLabsKey ? 'connected' : 'none');
  const [isLoadingOpenAi, setIsLoadingOpenAi] = useState(false);
  const [isLoadingAnthropic, setIsLoadingAnthropic] = useState(false);
  const [isLoadingElevenLabs, setIsLoadingElevenLabs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const { elevenLabsApiKey, setElevenLabsApiKey } = useAppStore();

  // Reload status on open
  useEffect(() => {
    if (isOpen) {
      getUserProfile().then(profile => {
        setOpenAiStatus(profile.apiKey ? 'connected' : 'none');
        setAnthropicStatus(profile.anthropicKey ? 'connected' : 'none');
      });
      // ElevenLabs status from store
      setElevenLabsStatus(elevenLabsApiKey ? 'connected' : 'none');
    }
  }, [isOpen, elevenLabsApiKey]);

  const handleSaveOpenAi = async () => {
    const trimmedKey = openAiKey.trim();
    if (!trimmedKey) return;
    
    if (!trimmedKey.startsWith('sk-')) {
      setError('OpenAI key should start with "sk-"');
      return;
    }
    
    setIsLoadingOpenAi(true);
    setError(null);
    
    try {
      await saveApiKey(trimmedKey);
      setOpenAiStatus('connected');
      setOpenAiKey('');
      setIsLoadingOpenAi(false);
    } catch (err) {
      setError(`OpenAI: ${err instanceof Error ? err.message : String(err)}`);
      setOpenAiStatus('error');
      setIsLoadingOpenAi(false);
    }
  };

  const handleSaveAnthropic = async () => {
    const trimmedKey = anthropicKey.trim();
    if (!trimmedKey) return;
    
    if (!trimmedKey.startsWith('sk-ant-')) {
      setError('Anthropic key should start with "sk-ant-"');
      return;
    }
    
    setIsLoadingAnthropic(true);
    setError(null);
    
    try {
      await saveAnthropicKey(trimmedKey);
      setAnthropicStatus('connected');
      setAnthropicKey('');
      setIsLoadingAnthropic(false);
    } catch (err) {
      setError(`Anthropic: ${err instanceof Error ? err.message : String(err)}`);
      setAnthropicStatus('error');
      setIsLoadingAnthropic(false);
    }
  };

  const handleRemoveOpenAi = async () => {
    await removeApiKey();
    setOpenAiStatus('none');
  };

  const handleRemoveAnthropic = async () => {
    await removeAnthropicKey();
    setAnthropicStatus('none');
  };

  const handleSaveElevenLabs = async () => {
    const trimmedKey = elevenLabsKey.trim();
    if (!trimmedKey) return;
    
    setIsLoadingElevenLabs(true);
    setError(null);
    
    try {
      // Store in Zustand (persisted locally, not in backend)
      setElevenLabsApiKey(trimmedKey);
      setElevenLabsStatus('connected');
      setElevenLabsKey('');
      setIsLoadingElevenLabs(false);
    } catch (err) {
      setError(`ElevenLabs: ${err instanceof Error ? err.message : String(err)}`);
      setElevenLabsStatus('error');
      setIsLoadingElevenLabs(false);
    }
  };

  const handleRemoveElevenLabs = () => {
    setElevenLabsApiKey(null);
    setElevenLabsStatus('none');
  };

  const handleDone = () => {
    // Only allow closing if both keys are connected
    if (openAiStatus === 'connected' && anthropicStatus === 'connected') {
      onComplete();
    }
  };

  // ⌘+ESC to close if OpenAI connected
  useEffect(() => {
    if (!isOpen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && e.metaKey && openAiStatus === 'connected' && anthropicStatus === 'connected') {
        e.preventDefault();
        e.stopPropagation();
        handleDone();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, openAiStatus]);

  const StatusIndicator = ({ status, isLoading }: { status: KeyStatus; isLoading?: boolean }) => (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full ${
      status === 'connected' ? 'bg-emerald-500/10' : 
      status === 'error' ? 'bg-red-500/10' : 
      'bg-smoke/10'
    }`}>
      {isLoading ? (
        <Loader2 className="w-3 h-3 text-aurora animate-spin" />
      ) : status === 'connected' ? (
        <Check className="w-3 h-3 text-emerald-500" strokeWidth={2.5} />
      ) : status === 'error' ? (
        <AlertCircle className="w-3 h-3 text-red-400" strokeWidth={2} />
      ) : (
        <Circle className="w-3 h-3 text-ash/40" strokeWidth={2} />
      )}
      <span className={`text-[10px] font-mono ${
        status === 'connected' ? 'text-emerald-500' : 
        status === 'error' ? 'text-red-400' : 
        'text-ash/50'
      }`}>
        {isLoading ? 'Connecting...' : status === 'connected' ? 'Connected' : status === 'error' ? 'Error' : 'Not set'}
      </span>
    </div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ pointerEvents: 'all' }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-void/60 backdrop-blur-sm" />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="relative z-10 w-full max-w-md mx-4 bg-obsidian/95 backdrop-blur-xl rounded-2xl border border-smoke/50 shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="px-6 pt-6 pb-4 text-center border-b border-smoke/30 relative">
              {/* ⌘ESC button - top right */}
              {openAiStatus === 'connected' && anthropicStatus === 'connected' && (
                <button
                  onClick={handleDone}
                  className="absolute top-4 right-4 px-1.5 py-1 rounded text-[10px] font-mono text-ash bg-smoke/30 hover:bg-smoke/50 border border-smoke/50 transition-colors cursor-pointer flex items-center justify-center gap-0.5"
                >
                  <span>⌘</span><span>ESC</span>
                </button>
              )}
              
              <div className="flex items-center justify-center gap-2">
                <img src={governorIcon} alt="" className="w-7 h-7 opacity-80" />
                <h1 className="font-logo text-2xl font-bold text-white">
                  Intersect
                </h1>
                <span className="text-[10px] font-mono text-ash/50 ml-1.5">v1</span>
              </div>
            </div>

            <div className="p-6 space-y-5">
              {/* OpenAI Section */}
              <div className={`p-4 rounded-xl border transition-all ${
                openAiStatus === 'connected' 
                  ? 'bg-emerald-500/5 border-emerald-500/30' 
                  : openAiStatus === 'error'
                  ? 'bg-red-500/5 border-red-500/30'
                  : 'bg-charcoal/30 border-smoke/30'
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex -space-x-2">
                      <img src={psycheAvatar} alt="Puff" className="w-7 h-7 rounded-full ring-2 ring-obsidian" />
                      <img src={logicAvatar} alt="Dot" className="w-7 h-7 rounded-full ring-2 ring-obsidian" />
                      <img src={instinctAvatar} alt="Snap" className="w-7 h-7 rounded-full ring-2 ring-obsidian" />
                    </div>
                    <div>
                      <h3 className="text-sm font-sans text-pearl font-medium">OpenAI</h3>
                      <p className="text-[10px] text-ash/60 font-mono">Powers Puff, Dot & Snap</p>
                    </div>
                  </div>
                  <StatusIndicator status={openAiStatus} isLoading={isLoadingOpenAi} />
                </div>
                
                {openAiStatus === 'connected' ? (
                  <button
                    onClick={handleRemoveOpenAi}
                    className="w-full px-3 py-2 text-xs font-mono text-ash/60 hover:text-red-400 border border-smoke/30 hover:border-red-400/50 rounded-lg transition-all flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove Key
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={openAiKey}
                      onChange={(e) => { setOpenAiKey(e.target.value); setError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && openAiKey.trim() && !isLoadingOpenAi) handleSaveOpenAi(); }}
                      placeholder="sk-..."
                      autoFocus
                      className="flex-1 px-3 py-2.5 bg-obsidian/50 border border-smoke/40 rounded-lg text-pearl placeholder-ash/40 font-mono text-xs focus:outline-none focus:border-aurora/50 transition-colors"
                    />
                    <button
                      onClick={handleSaveOpenAi}
                      disabled={isLoadingOpenAi || !openAiKey.trim()}
                      className="px-4 py-2.5 text-xs font-mono font-medium rounded-lg disabled:opacity-40 transition-all flex items-center gap-2 bg-pearl text-void hover:bg-pearl/90 cursor-pointer"
                    >
                      {isLoadingOpenAi && <Loader2 className="w-3 h-3 animate-spin" />}
                      {isLoadingOpenAi ? 'Saving' : 'Save'}
                      <kbd className="px-1 py-0.5 bg-void/20 rounded text-[9px] font-mono">↵</kbd>
                    </button>
                  </div>
                )}
                <p className="mt-2.5 text-[10px] text-ash/50 font-mono flex items-center gap-1">
                  <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-aurora/70 hover:text-aurora transition-colors inline-flex items-center gap-1">
                    <ExternalLink className="w-2.5 h-2.5" />
                    Get your API key
                  </a>
                </p>
              </div>

              {/* Anthropic Section */}
              <div className={`p-4 rounded-xl border transition-all ${
                anthropicStatus === 'connected' 
                  ? 'bg-emerald-500/5 border-emerald-500/30' 
                  : anthropicStatus === 'error'
                  ? 'bg-red-500/5 border-red-500/30'
                  : 'bg-charcoal/30 border-smoke/30'
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <img src={governorIcon} alt="Governor" className="w-7 h-7" />
                    <div>
                      <h3 className="text-sm font-sans text-pearl font-medium">Anthropic</h3>
                      <p className="text-[10px] text-ash/60 font-mono">Powers Governor</p>
                    </div>
                  </div>
                  <StatusIndicator status={anthropicStatus} isLoading={isLoadingAnthropic} />
                </div>
                
                {anthropicStatus === 'connected' ? (
                  <button
                    onClick={handleRemoveAnthropic}
                    className="w-full px-3 py-2 text-xs font-mono text-ash/60 hover:text-red-400 border border-smoke/30 hover:border-red-400/50 rounded-lg transition-all flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove Key
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={anthropicKey}
                      onChange={(e) => { setAnthropicKey(e.target.value); setError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && anthropicKey.trim() && !isLoadingAnthropic) handleSaveAnthropic(); }}
                      placeholder="sk-ant-..."
                      className="flex-1 px-3 py-2.5 bg-obsidian/50 border border-smoke/40 rounded-lg text-pearl placeholder-ash/40 font-mono text-xs focus:outline-none focus:border-psyche/50 transition-colors"
                    />
                    <button
                      onClick={handleSaveAnthropic}
                      disabled={isLoadingAnthropic || !anthropicKey.trim()}
                      className="px-4 py-2.5 text-xs font-mono font-medium rounded-lg disabled:opacity-40 transition-all flex items-center gap-2 bg-pearl text-void hover:bg-pearl/90 cursor-pointer"
                    >
                      {isLoadingAnthropic && <Loader2 className="w-3 h-3 animate-spin" />}
                      {isLoadingAnthropic ? 'Saving' : 'Save'}
                      <kbd className="px-1 py-0.5 bg-void/20 rounded text-[9px] font-mono">↵</kbd>
                    </button>
                  </div>
                )}
                <p className="mt-2.5 text-[10px] text-ash/50 font-mono flex items-center gap-1">
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-psyche/70 hover:text-psyche transition-colors inline-flex items-center gap-1">
                    <ExternalLink className="w-2.5 h-2.5" />
                    Get your API key
                  </a>
                </p>
              </div>

              {/* ElevenLabs Section (Optional) */}
              <div className={`p-4 rounded-xl border transition-all ${
                elevenLabsStatus === 'connected' 
                  ? 'bg-emerald-500/5 border-emerald-500/30' 
                  : elevenLabsStatus === 'error'
                  ? 'bg-red-500/5 border-red-500/30'
                  : 'bg-charcoal/30 border-smoke/30'
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-aurora/20 flex items-center justify-center">
                      <Mic className="w-4 h-4 text-aurora" />
                    </div>
                    <div>
                      <h3 className="text-sm font-sans text-pearl font-medium flex items-center gap-2">
                        ElevenLabs
                        <span className="px-1 py-0.5 bg-amber-500/15 text-amber-400/80 border border-amber-500/25 rounded-full text-[8px] font-mono font-medium leading-none">OPTIONAL</span>
                      </h3>
                      <p className="text-[10px] text-ash/60 font-mono">Voice transcription</p>
                    </div>
                  </div>
                  <StatusIndicator status={elevenLabsStatus} isLoading={isLoadingElevenLabs} />
                </div>
                
                {elevenLabsStatus === 'connected' ? (
                  <button
                    onClick={handleRemoveElevenLabs}
                    className="w-full px-3 py-2 text-xs font-mono text-ash/60 hover:text-red-400 border border-smoke/30 hover:border-red-400/50 rounded-lg transition-all flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove Key
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={elevenLabsKey}
                      onChange={(e) => { setElevenLabsKey(e.target.value); setError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && elevenLabsKey.trim() && !isLoadingElevenLabs) handleSaveElevenLabs(); }}
                      placeholder="xi-..."
                      className="flex-1 px-3 py-2.5 bg-obsidian/50 border border-smoke/40 rounded-lg text-pearl placeholder-ash/40 font-mono text-xs focus:outline-none focus:border-aurora/50 transition-colors"
                    />
                    <button
                      onClick={handleSaveElevenLabs}
                      disabled={isLoadingElevenLabs || !elevenLabsKey.trim()}
                      className="px-4 py-2.5 text-xs font-mono font-medium rounded-lg disabled:opacity-40 transition-all flex items-center gap-2 bg-pearl text-void hover:bg-pearl/90 cursor-pointer"
                    >
                      {isLoadingElevenLabs && <Loader2 className="w-3 h-3 animate-spin" />}
                      {isLoadingElevenLabs ? 'Saving' : 'Save'}
                      <kbd className="px-1 py-0.5 bg-void/20 rounded text-[9px] font-mono">↵</kbd>
                    </button>
                  </div>
                )}
                <p className="mt-2.5 text-[10px] text-ash/50 font-mono flex items-center gap-1">
                  <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="text-aurora/70 hover:text-aurora transition-colors inline-flex items-center gap-1">
                    <ExternalLink className="w-2.5 h-2.5" />
                    Get your API key
                  </a>
                </p>
              </div>

              {error && (
                <motion.p 
                  initial={{ opacity: 0 }} 
                  animate={{ opacity: 1 }} 
                  className="text-xs font-mono text-center px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400"
                >
                  {error}
                </motion.p>
              )}

            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
