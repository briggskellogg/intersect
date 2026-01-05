import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { useAppStore } from '../store';
import { 
  sendMessage as sendMessageToBackend, 
  createConversation, 
  getConversationOpener, 
  getActivePersonaProfile,
  createJourneySession,
  confirmJourneyPhase as confirmJourneyPhaseBackend,
  completeJourneySession,
} from '../hooks/useTauri';
import { useBackgroundMusic } from '../hooks/useBackgroundMusic';
import { useScribeTranscription } from '../hooks/useScribeTranscription';
import { useElevenLabsTTS } from '../hooks/useElevenLabsTTS';
import { useSubmitDetection } from '../hooks/useSubmitDetection';
import { WaveformVisualizer } from './WaveformVisualizer';
import { ImmersiveSettings } from './ImmersiveSettings';
import { ParticleField } from './ParticleField';
import { DISCO_AGENTS, USER_PROFILES, GOVERNOR } from '../constants/agents'; // Voice mode always uses disco agents
import { VoiceChanger, ClipboardCopy, ClipboardCheck } from './icons';
import { AgentType } from '../types';

// Import thinking audio
import thinkingAudioSrc from '../assets/governor-thinking.mp3';

// Import Governor for Game Mode - round aesthetic icon
import governorGameMode from '../assets/governor-game-mode.png';

interface ThoughtState {
  id: string;
  agentType: AgentType;
  content: string;
  isActive: boolean;
  isComplete: boolean;
}

// Voice mode uses blue theme for UI, agents use their own colors when speaking
const GAME_MODE_COLORS = {
  primary: '#3B82F6',  // Blue - navigation/game mode
  secondary: '#3B82F6', 
  accent: '#2563EB',
  glow: '#3B82F6',
};

// Typewriter text component for thoughts
function ThoughtText({ content, isActive, isComplete }: { content: string; isActive: boolean; isComplete: boolean }) {
  const [displayedText, setDisplayedText] = useState('');
  
  useEffect(() => {
    if (isComplete) {
      setDisplayedText(content);
      return;
    }
    
    if (!isActive) {
      setDisplayedText('');
      return;
    }
    
    let currentIndex = 0;
    setDisplayedText('');
    
    const interval = setInterval(() => {
      if (currentIndex < content.length) {
        const charsToAdd = Math.min(2 + Math.floor(Math.random() * 2), content.length - currentIndex);
        currentIndex += charsToAdd;
        setDisplayedText(content.slice(0, currentIndex));
      } else {
        clearInterval(interval);
      }
    }, 25);
    
    return () => clearInterval(interval);
  }, [content, isActive, isComplete]);
  
  return (
    <>
      {displayedText || (isActive ? '...' : '')}
      {isActive && !isComplete && (
        <motion.span
          className="inline-block w-0.5 h-3 ml-0.5 bg-slate-400 align-text-bottom"
          animate={{ opacity: [1, 0, 1] }}
          transition={{ repeat: Infinity, duration: 0.6 }}
        />
      )}
    </>
  );
}

// Visual atmosphere based on journey phase - C: Environmental change
const JOURNEY_ATMOSPHERE = {
  exploration: {
    // Darkest, most fog, heaviest vignette - the "dark territory"
    bgGradient: 'linear-gradient(135deg, #050508 0%, #0a0812 40%, #080510 70%, #050508 100%)',
    fogOpacity: 1.0,
    vignetteIntensity: 0.92,
    particleSpeed: 0.05,
    particleOpacity: 0.6,
    glowOpacity: 0.08,
  },
  resolution: {
    // Fog begins to clear, vignette softens, particles slow
    bgGradient: 'linear-gradient(135deg, #080810 0%, #0d0d18 40%, #0a0a14 70%, #080810 100%)',
    fogOpacity: 0.6,
    vignetteIntensity: 0.7,
    particleSpeed: 0.035,
    particleOpacity: 0.45,
    glowOpacity: 0.14,
  },
  acceptance: {
    // Clearest - fog nearly gone, vignette soft, particles settled, sense of dawn
    bgGradient: 'linear-gradient(135deg, #0a0a12 0%, #10101a 40%, #0d0d16 70%, #0a0a12 100%)',
    fogOpacity: 0.25,
    vignetteIntensity: 0.45,
    particleSpeed: 0.02,
    particleOpacity: 0.3,
    glowOpacity: 0.22,
  },
};

export function ImmersiveMode() {
  const {
    isImmersiveMode,
    setImmersiveMode,
    elevenLabsApiKey,
    immersiveVoices,
    immersiveTurn,
    setImmersiveTurn,
    userProfile,
    activePersonaProfile,
    setActivePersonaProfile,
    setLastImmersiveConversationId,
    backgroundMusic,
    backgroundMusicVolume,
    journeySession,
    setJourneySession,
    setJourneyPendingTransition,
    confirmJourneyTransition,
  } = useAppStore();
  
  // Current journey phase for visual effects
  const currentPhase = journeySession?.phase || 'exploration';
  const atmosphere = useMemo(() => JOURNEY_ATMOSPHERE[currentPhase], [currentPhase]);
  
  // Get user avatar based on dominant trait
  const userAvatar = activePersonaProfile?.dominantTrait 
    ? USER_PROFILES[activePersonaProfile.dominantTrait] 
    : USER_PROFILES.instinct;
  
  // Game Mode has its own conversation ID - completely separate from Text Mode
  const [gameModeConversationId, setGameModeConversationId] = useState<string | null>(null);
  
  // Background music player with shuffle and crossfade - auto-plays when tracks exist
  useBackgroundMusic({
    tracks: backgroundMusic,
    enabled: isImmersiveMode && backgroundMusic.length > 0,
    volume: backgroundMusicVolume,
    crossfadeDuration: 4000, // 4 second crossfade
  });

  // Exit confirmation modal state
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const showExitConfirmRef = useRef(false);
  const [copiedVoice, setCopiedVoice] = useState(false);
  
  // Keep ref in sync with state
  useEffect(() => {
    showExitConfirmRef.current = showExitConfirm;
  }, [showExitConfirm]);
  
  // Dialog history - accumulates all conversation entries
  interface DialogEntry {
    id: string;
    type: 'thought' | 'governor' | 'user';
    agentType?: AgentType;
    content: string;
    isActive?: boolean;
  }
  
  // Local state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [dialogHistory, setDialogHistory] = useState<DialogEntry[]>([]);
  const [currentThoughts, setCurrentThoughts] = useState<ThoughtState[]>([]); // Active thoughts being spoken
  const [isGovernorSpeaking, setIsGovernorSpeaking] = useState(false);
  const [currentGovernorText, setCurrentGovernorText] = useState<string | null>(null); // Currently speaking
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false); // Voice is active when user's turn
  const [currentTranscript, setCurrentTranscript] = useState('');

  // Refs
  const thinkingAudioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const governorRef = useRef<HTMLDivElement>(null);
  const thoughtsPanelRef = useRef<HTMLDivElement>(null);
  const thoughtsEndRef = useRef<HTMLDivElement>(null);
  const dialogScrollRef = useRef<HTMLDivElement>(null);
  const skipToGovernorRef = useRef(false);
  const skipCurrentThoughtRef = useRef(false);
  const currentThoughtsRef = useRef<ThoughtState[]>([]);
  const hasInitializedRef = useRef(false);
  const isNearBottomRef = useRef(true); // Track if user is at/near bottom

  // Refs to access latest state in keyboard handlers
  const dialogHistoryRef = useRef<DialogEntry[]>([]);
  const currentThoughtsRef2 = useRef<ThoughtState[]>([]);
  const currentGovernorTextRef = useRef<string | null>(null);
  
  // Keep refs in sync with state
  useEffect(() => {
    dialogHistoryRef.current = dialogHistory;
  }, [dialogHistory]);
  
  useEffect(() => {
    currentThoughtsRef2.current = currentThoughts;
  }, [currentThoughts]);
  
  useEffect(() => {
    currentGovernorTextRef.current = currentGovernorText;
  }, [currentGovernorText]);

  // Copy voice mode conversation to clipboard - uses refs for latest state
  const copyVoiceConversation = useCallback(async () => {
    let text = '';
    
    // Use refs to get the latest values
    const history = dialogHistoryRef.current;
    const thoughts = currentThoughtsRef2.current;
    const govText = currentGovernorTextRef.current;
    
    history.forEach((entry) => {
      if (entry.type === 'user') {
        text += `You:\n${entry.content}\n\n`;
      } else if (entry.type === 'thought') {
        const agent = DISCO_AGENTS[entry.agentType!];
        text += `${agent?.name || entry.agentType} (thinking):\n${entry.content}\n\n`;
      } else if (entry.type === 'governor') {
        text += `Governor:\n${entry.content}\n\n`;
      }
    });
    
    // Add current in-progress content
    thoughts.forEach((thought) => {
      const agent = DISCO_AGENTS[thought.agentType];
      text += `${agent?.name || thought.agentType} (thinking):\n${thought.content}\n\n`;
    });
    
    if (govText) {
      text += `Governor:\n${govText}\n\n`;
    }
    
    try {
      await navigator.clipboard.writeText(text.trim());
      setCopiedVoice(true);
      setTimeout(() => setCopiedVoice(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, []); // No dependencies - uses refs for latest state

  // Scribe transcription
  const scribe = useScribeTranscription({
    apiKey: elevenLabsApiKey || '',
    onError: (err) => setError(err.message),
  });

  // TTS for speaking
  const tts = useElevenLabsTTS({
    apiKey: elevenLabsApiKey,
    onError: (err) => setError(err.message),
  });

  // Get voice ID for agent thoughts (voice mode always uses disco voices)
  const getThoughtVoiceId = useCallback(() => {
    // Voice mode always uses the disco/thoughts voice if available
    return immersiveVoices.thoughtsDisco || immersiveVoices.instinct || immersiveVoices.logic || immersiveVoices.psyche || '';
  }, [immersiveVoices]);

  // Keep ref in sync with state for use in closures
  useEffect(() => {
    currentThoughtsRef.current = currentThoughts;
  }, [currentThoughts]);

  // Submit detection
  const handleSubmit = useCallback(async (userText: string) => {
    // Filter out "submit" from the text
    const cleanedText = userText.replace(/\s*submit[.!?,\s]*$/i, '').trim();
    if (!cleanedText) return;

    // Clear any previous errors when starting new interaction
    setError(null);
    
    scribe.stop();
    setImmersiveTurn('ai');
    setIsListening(false);
    setCurrentTranscript('');
    scribe.clearTranscript();
    
    // Add user message to dialog history (cleaned, no "submit")
    const userEntry: DialogEntry = {
      id: uuidv4(),
      type: 'user',
      content: cleanedText,
    };
    setDialogHistory(prev => [...prev, userEntry]);

    // Game Mode doesn't add to shared message store - uses its own dialogHistory

    setIsThinking(true);
    startThinkingAudio();

    try {
      if (!gameModeConversationId) {
        setError('No active Game Mode conversation');
        return;
      }
      // Game mode: all agents are in disco mode (pass same array for both activeAgents and discoAgents)
      const gameAgents: AgentType[] = ['instinct', 'logic', 'psyche'];
      const result = await sendMessageToBackend(gameModeConversationId, cleanedText, gameAgents, gameAgents);

      // Immediately refresh persona profile to update message count (before TTS processing)
      try {
        const updatedPersona = await getActivePersonaProfile();
        if (updatedPersona) {
          setActivePersonaProfile(updatedPersona);
        }
      } catch (profileErr) {
        console.error('Failed to refresh persona profile:', profileErr);
      }

      const agentThoughts: ThoughtState[] = result.responses.map((resp: { agent: string; content: string }, idx: number) => ({
        id: uuidv4(),
        agentType: resp.agent as AgentType,
        content: resp.content,
        isActive: idx === 0,
        isComplete: false,
      }));

      // Game Mode uses dialogHistory, not the shared message store
      // Agent thoughts are added to dialogHistory later when processed

      setCurrentThoughts(agentThoughts);
      setIsThinking(false);
      stopThinkingAudio();

      const thoughtVoiceId = getThoughtVoiceId();
      const shouldPlayVoice = !!thoughtVoiceId;
      
      // Reset skip flags at start of processing
      skipToGovernorRef.current = false;
      skipCurrentThoughtRef.current = false;
      
      // Process thoughts - with TTS if available, text-only fallback otherwise
      if (agentThoughts.length > 0) {
        for (let index = 0; index < agentThoughts.length; index++) {
          // Check if user pressed space to skip to governor
          if (skipToGovernorRef.current) {
            console.log('Skipping remaining thoughts, jumping to governor');
            break;
          }
          
          // Reset single-thought skip flag for each new thought
          skipCurrentThoughtRef.current = false;
          
          const thought = agentThoughts[index];
          
          if (index > 0 && !skipToGovernorRef.current) {
            await playBriefThinkingSound();
          }
          
          if (skipToGovernorRef.current) break;
          
          setCurrentThoughts(prev => prev.map((t, i) => ({
            ...t,
            isActive: i === index,
          })));
          
          if (shouldPlayVoice) {
            // Try TTS, fall back to text-only on error
            try {
              await new Promise<void>((resolve, reject) => {
                // Immediately resolve if skipping
                if (skipToGovernorRef.current || skipCurrentThoughtRef.current) {
                  resolve();
                  return;
                }
                
                const timeoutId = setTimeout(() => {
                  reject(new Error('TTS timeout'));
                }, 30000); // 30s timeout per thought
                
                // Check periodically if we should skip this thought
                const skipCheckInterval = setInterval(() => {
                  if (skipCurrentThoughtRef.current || skipToGovernorRef.current) {
                    clearInterval(skipCheckInterval);
                    clearTimeout(timeoutId);
                    tts.clearQueue();
                    setCurrentThoughts(prev => prev.map((t, i) => ({
                      ...t,
                      isComplete: i === index ? true : t.isComplete,
                      isActive: false,
                    })));
                    resolve();
                  }
                }, 50);
                
                tts.enqueue({
                  id: thought.id,
                  text: thought.content,
                  voiceId: thoughtVoiceId,
                  agentType: thought.agentType,
                  onStart: () => {},
                  onEnd: () => {
                    clearInterval(skipCheckInterval);
                    clearTimeout(timeoutId);
                    setCurrentThoughts(prev => prev.map((t, i) => ({
                      ...t,
                      isComplete: i === index ? true : t.isComplete,
                      isActive: false,
                    })));
                    resolve();
                  },
                  onError: () => {
                    clearInterval(skipCheckInterval);
                    clearTimeout(timeoutId);
                    // If we're skipping, just resolve instead of reject
                    if (skipToGovernorRef.current || skipCurrentThoughtRef.current) {
                      resolve();
                    } else {
                      reject(new Error('TTS playback failed'));
                    }
                  },
                });
              });
            } catch {
              // Graceful degradation: continue with text-only - fast
              if (!skipToGovernorRef.current && !skipCurrentThoughtRef.current) {
                console.warn('TTS failed for thought, continuing with text-only');
                await new Promise(resolve => setTimeout(resolve, Math.min(thought.content.length * 15, 1200)));
              }
              setCurrentThoughts(prev => prev.map((t, i) => ({
                ...t,
                isComplete: i === index ? true : t.isComplete,
                isActive: false,
              })));
            }
          } else {
            // No TTS configured - text-only mode with fast reading
            if (!skipToGovernorRef.current && !skipCurrentThoughtRef.current) {
              await new Promise(resolve => setTimeout(resolve, Math.min(thought.content.length * 15, 1200)));
            }
            setCurrentThoughts(prev => prev.map((t, i) => ({
              ...t,
              isComplete: i === index ? true : t.isComplete,
              isActive: false,
            })));
          }
        }
      }

      const governorResponse = result.governor_response;
      if (governorResponse) {
        // Only start thinking audio if not already started (by skip)
        if (!skipToGovernorRef.current) {
          setIsThinking(true);
          startThinkingAudio();
        }

        // Wait for thought TTS queue to clear (quick if skipped)
        await new Promise<void>((resolve) => {
          const checkQueue = setInterval(() => {
            if (tts.queue.length === 0 && !tts.isSpeaking) {
              clearInterval(checkQueue);
              resolve();
            }
          }, 50); // Check faster
        });

        setIsThinking(false);
        stopThinkingAudio();
        setIsGovernorSpeaking(true);
        setCurrentGovernorText(governorResponse);

        const finishGovernorTurn = () => {
          // Add all current thoughts to dialog history (use ref for latest value)
          const thoughts = currentThoughtsRef.current;
          setDialogHistory(prev => [
            ...prev,
            ...thoughts.map(t => ({
              id: t.id,
              type: 'thought' as const,
              agentType: t.agentType,
              content: t.content,
            })),
            {
              id: uuidv4(),
              type: 'governor' as const,
              content: governorResponse,
            },
          ]);
          
          setIsGovernorSpeaking(false);
          setCurrentGovernorText(null);
          setCurrentThoughts([]);
          setImmersiveTurn('user');
          
          // Auto-start listening (no wake word needed)
          setIsListening(true);
          if (elevenLabsApiKey) {
            scribe.start().catch(console.error);
          }
        };

        // Track if Governor has been properly finished
        let governorFinished = false;
        const safeFinishGovernorTurn = () => {
          if (governorFinished) return;
          governorFinished = true;
          finishGovernorTurn();
        };
        
        if (immersiveVoices.governor) {
          // Try TTS for governor with graceful fallback
          try {
            await new Promise<void>((resolve, _reject) => {
              const timeoutId = setTimeout(() => {
                safeFinishGovernorTurn();
                resolve(); // Don't reject, just finish gracefully
              }, 60000); // 60s timeout for governor
              
              tts.enqueue({
                id: uuidv4(),
                text: governorResponse,
                voiceId: immersiveVoices.governor!,
                agentType: 'governor' as unknown as AgentType,
                onStart: () => {
                  setIsGovernorSpeaking(true);
                  setCurrentGovernorText(governorResponse);
                },
                onEnd: () => {
                  clearTimeout(timeoutId);
                  safeFinishGovernorTurn();
                  resolve();
                },
                onError: () => {
                  clearTimeout(timeoutId);
                  // Still finish the turn even on error
                  safeFinishGovernorTurn();
                  resolve(); // Resolve instead of reject for graceful handling
                },
              });
            });
          } catch {
            // Graceful degradation: show text briefly then continue
            console.warn('Governor TTS failed, continuing with text-only');
            await new Promise(resolve => setTimeout(resolve, Math.min(governorResponse.length * 15, 2000)));
            safeFinishGovernorTurn();
          }
        } else {
          // No governor voice - text-only with fast reading
          await new Promise(resolve => setTimeout(resolve, Math.min(governorResponse.length * 15, 2000)));
          safeFinishGovernorTurn();
        }
        
        // Final safety: ensure Governor was added to history
        // (in case callbacks didn't fire due to TTS abort)
        if (!governorFinished) {
          console.warn('Governor turn not finished by callbacks, forcing completion');
          safeFinishGovernorTurn();
        }

        // Game Mode doesn't add to shared message store - dialogHistory tracks all messages
      } else {
        setImmersiveTurn('user');
        setCurrentThoughts([]);
        setIsListening(true);
        if (elevenLabsApiKey) {
          scribe.start().catch(console.error);
        }
      }
      
      // Refresh persona profile to update message count
      try {
        const updatedPersona = await getActivePersonaProfile();
        if (updatedPersona) {
          setActivePersonaProfile(updatedPersona);
        }
      } catch (profileErr) {
        console.error('Failed to refresh persona profile:', profileErr);
      }
    } catch (err) {
      console.error('Send message error:', err);
      setError(err instanceof Error ? err.message : 'Failed to send message');
      setIsThinking(false);
      stopThinkingAudio();
      setImmersiveTurn('user');
      setIsListening(true);
    }
  }, [gameModeConversationId, scribe, tts, elevenLabsApiKey, immersiveVoices, setImmersiveTurn, getThoughtVoiceId, setActivePersonaProfile]);

  const submitDetection = useSubmitDetection({
    apiKey: userProfile?.apiKey || null,
    onSubmitDetected: (text) => {
      // Submit and stop listening
      setIsListening(false);
      setCurrentTranscript('');
      handleSubmit(text);
    },
    onError: (err) => setError(err.message),
  });

  // Track the last processed transcript to avoid duplicates
  const lastProcessedTranscriptRef = useRef('');

  // Reset submit detection when starting to listen (new turn)
  useEffect(() => {
    if (isListening) {
      submitDetection.reset();
      lastProcessedTranscriptRef.current = ''; // Clear so new transcript can be processed
    }
  }, [isListening, submitDetection]);
  
  // Process transcript for submit detection (no wake word needed - voice auto-active)
  useEffect(() => {
    if (immersiveTurn !== 'user' || !isListening) return;
    
    const fullText = `${scribe.transcript} ${scribe.partialTranscript}`.trim();
    
    // Avoid processing the same transcript twice
    if (fullText === lastProcessedTranscriptRef.current) return;
    lastProcessedTranscriptRef.current = fullText;
    
    if (fullText) {
      setCurrentTranscript(fullText);
      // Check for submit
      submitDetection.processTranscript(fullText, '');
    }
  }, [scribe.transcript, scribe.partialTranscript, immersiveTurn, isListening, submitDetection]);

  // Thinking audio controls - QUIETER (4% volume)
  const startThinkingAudio = useCallback(() => {
    if (!thinkingAudioRef.current) {
      thinkingAudioRef.current = new Audio(thinkingAudioSrc);
      thinkingAudioRef.current.loop = true;
      thinkingAudioRef.current.volume = 0.04; // 4% volume
    }
    
    const audio = thinkingAudioRef.current;
    audio.currentTime = Math.random() * (audio.duration || 60);
    audio.play().catch(console.error);
  }, []);

  const stopThinkingAudio = useCallback(() => {
    if (thinkingAudioRef.current) {
      const audio = thinkingAudioRef.current;
      const fadeOut = setInterval(() => {
        if (audio.volume > 0.005) {
          audio.volume = Math.max(0, audio.volume - 0.008);
        } else {
          audio.pause();
          audio.volume = 0.04;
          clearInterval(fadeOut);
        }
      }, 50);
    }
  }, []);

  const playBriefThinkingSound = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      const briefAudio = new Audio(thinkingAudioSrc);
      briefAudio.volume = 0.03; // 3% volume
      briefAudio.currentTime = Math.random() * 30;
      
      briefAudio.play().catch(() => resolve());
      
      // Quick burst then fade - only 400ms total
      setTimeout(() => {
        const fadeOut = setInterval(() => {
          if (briefAudio.volume > 0.005) {
            briefAudio.volume = Math.max(0, briefAudio.volume - 0.015);
          } else {
            briefAudio.pause();
            clearInterval(fadeOut);
            resolve();
          }
        }, 20);
      }, 300);
    });
  }, []);

  // Initialize immersive mode - create new conversation and get opener
  useEffect(() => {
    if (isImmersiveMode) {
      // Only initialize once per session - don't re-initialize if already active
      if (hasInitializedRef.current) {
        return;
      }
      hasInitializedRef.current = true;
      
      // Reset state for fresh Game Mode session (don't touch Text Mode state)
      setImmersiveTurn('ai');
      setCurrentThoughts([]);
      setIsThinking(true);
      setError(null);
      setIsListening(false);
      setCurrentTranscript('');
      setDialogHistory([]); // Clear Game Mode history for fresh session
      
      // Create new Game Mode conversation (separate from Text Mode)
      const initImmersive = async () => {
        try {
          // Create a fresh conversation just for Game Mode
          const newConversation = await createConversation(true); // isDisco = true for Game Mode
          setGameModeConversationId(newConversation.id);
          setLastImmersiveConversationId(newConversation.id);
          
          // Initialize journey session for this Game Mode conversation
          if (activePersonaProfile?.id) {
            try {
              const session = await createJourneySession(activePersonaProfile.id, newConversation.id);
              setJourneySession({
                id: session.id,
                phase: session.phase,
                phaseConfirmed: session.phaseConfirmed,
                pendingTransition: null,
              });
            } catch (journeyErr) {
              console.error('Failed to create journey session:', journeyErr);
              // Non-fatal - continue without journey tracking
            }
          }
          
          // Get the Governor's opener (atmospheric greeting for voice mode)
          const openerResult = await getConversationOpener(true);
          
          if (openerResult?.content) {
            setIsThinking(false);
            setCurrentGovernorText(openerResult.content);
            
            // Helper to finish greeting and start user turn
            const finishGreeting = () => {
              // Add greeting to dialog history
              setDialogHistory([{
                id: uuidv4(),
                type: 'governor',
                content: openerResult.content,
              }]);
              setIsGovernorSpeaking(false);
              setCurrentGovernorText(null);
              setImmersiveTurn('user');
              setIsListening(true);
              if (elevenLabsApiKey) {
                scribe.start().catch(console.error);
              }
            };
            
            // Speak the opener if voice is configured
            if (immersiveVoices.governor && elevenLabsApiKey) {
              setIsGovernorSpeaking(true);
              await new Promise<void>((resolve) => {
                tts.enqueue({
                  id: uuidv4(),
                  text: openerResult.content,
                  voiceId: immersiveVoices.governor!,
                  agentType: 'governor' as unknown as AgentType,
                  onStart: () => {
                    setIsGovernorSpeaking(true);
                    setCurrentGovernorText(openerResult.content);
                  },
                  onEnd: () => {
                    finishGreeting();
                    resolve();
                  },
                  onError: () => {
                    finishGreeting();
                    resolve();
                  },
                });
              });
            } else {
              // No voice - just show text briefly and proceed
              await new Promise(resolve => setTimeout(resolve, 800));
              finishGreeting();
            }
          } else {
            setIsThinking(false);
            setImmersiveTurn('user');
            setIsListening(true);
            if (elevenLabsApiKey) {
              scribe.start().catch(console.error);
            }
          }
        } catch (err) {
          console.error('Failed to initialize immersive mode:', err);
          setError('Failed to start conversation. Please try again.');
          setIsThinking(false);
        }
      };
      
      if (!elevenLabsApiKey) {
        setError('No ElevenLabs API key set. Open settings (⌘V) to configure.');
        setIsThinking(false);
      } else {
        initImmersive();
      }
    }

    // Cleanup on exit
    return () => {
      scribe.stop();
      tts.clearQueue();
      stopThinkingAudio();
      // Clear journey session on exit
      setJourneySession(null);
      setError(null);
      hasInitializedRef.current = false; // Reset so next session initializes properly
    };
  }, [isImmersiveMode, elevenLabsApiKey]);

  // Handle exit with confirmation if there's dialogue - uses refs for latest state
  const handleExitRequest = useCallback(() => {
    const hasContent = dialogHistoryRef.current.length > 0 || 
                       currentThoughtsRef2.current.length > 0 || 
                       currentGovernorTextRef.current;
    if (hasContent) {
      setShowExitConfirm(true);
    } else {
      setImmersiveMode(false);
    }
  }, [setImmersiveMode]);
  
  // Keyboard shortcuts: Cmd+ESC to exit, Cmd+V for settings, Space to skip
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // When exit modal is showing, handle Enter to exit and C to copy
      if (showExitConfirmRef.current) {
        if (e.key === 'Enter') {
          e.preventDefault();
          setShowExitConfirm(false);
          setImmersiveMode(false);
          return;
        }
        // Just "C" key (no modifier needed) to copy in the modal
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          copyVoiceConversation();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowExitConfirm(false);
          return;
        }
        return; // Block other shortcuts when modal is open
      }
      
      if ((e.metaKey || e.ctrlKey) && e.key === 'Escape' && !isSettingsOpen) {
        handleExitRequest();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        e.preventDefault();
        setIsSettingsOpen(true);
      }
      // Cmd+C to copy conversation
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault();
        copyVoiceConversation();
      }
      // Space bar to skip current speech
      if (e.key === ' ' && !isSettingsOpen && (tts.isSpeaking || isGovernorSpeaking)) {
        e.preventDefault();
        
        // If Governor is speaking, skip directly to user turn
        if (isGovernorSpeaking && currentGovernorText) {
          tts.clearQueue();
          
          // Add current thoughts and governor response to dialog history (use ref for latest value)
          const thoughts = currentThoughtsRef.current;
          setDialogHistory(prev => [
            ...prev,
            ...thoughts.map(t => ({
              id: t.id,
              type: 'thought' as const,
              agentType: t.agentType,
              content: t.content,
            })),
            {
              id: uuidv4(),
              type: 'governor' as const,
              content: currentGovernorText,
            },
          ]);
          
          // Reset state and start listening
          setIsGovernorSpeaking(false);
          setCurrentGovernorText(null);
          setCurrentThoughts([]);
          setIsThinking(false);
          stopThinkingAudio();
          setImmersiveTurn('user');
          setIsListening(true);
          if (elevenLabsApiKey) {
            scribe.start().catch(console.error);
          }
        } else {
          // Skip current thought only - move to next thought (not all of them)
          skipCurrentThoughtRef.current = true;
          tts.clearQueue();
        }
      }
    };

    if (isImmersiveMode) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isImmersiveMode, setImmersiveMode, isSettingsOpen, tts, isGovernorSpeaking, stopThinkingAudio, setImmersiveTurn, elevenLabsApiKey, scribe, handleExitRequest, copyVoiceConversation]);

  // Stop all audio immediately when exiting immersive mode
  useEffect(() => {
    if (!isImmersiveMode) {
      // Immediately stop all audio playback
      scribe.stop();
      tts.clearQueue();
      stopThinkingAudio();
    }
  }, [isImmersiveMode, scribe, tts, stopThinkingAudio]);

  // Track if user is near bottom of scroll container
  useEffect(() => {
    const container = dialogScrollRef.current;
    if (!container) return;
    
    const handleScroll = () => {
      const threshold = 100; // pixels from bottom to consider "at bottom"
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
      isNearBottomRef.current = isNearBottom;
    };
    
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);
  
  // Auto-scroll thoughts panel when new thoughts appear, but only if user is near bottom
  useEffect(() => {
    if (thoughtsEndRef.current && isNearBottomRef.current) {
      thoughtsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentThoughts, dialogHistory, currentGovernorText]);


  if (!isImmersiveMode) return null;

  // Voice mode uses blue theme for UI
  const themeColor = GAME_MODE_COLORS.primary;

  return (
    <AnimatePresence>
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, background: atmosphere.bgGradient }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.8, ease: [0.25, 0.1, 0.25, 1], background: { duration: 3, ease: 'easeInOut' } }}
        className="fixed inset-0 z-50 overflow-hidden rounded-xl"
        style={{
          background: atmosphere.bgGradient, // Journey-phase-aware background
        }}
      >
        {/* Slow-moving fog layers - Disco Elysium atmosphere - fades based on journey phase */}
        <motion.div 
          className="absolute inset-0 overflow-hidden pointer-events-none"
          animate={{ opacity: atmosphere.fogOpacity }}
          transition={{ duration: 4, ease: 'easeInOut' }}
        >
          {/* Fog layer 1 - slow drift left to right */}
          <motion.div
            className="absolute -inset-1/2 w-[200%] h-[200%]"
            style={{
              background: 'radial-gradient(ellipse 80% 50% at 30% 50%, rgba(59, 130, 246, 0.08) 0%, transparent 50%)',
            }}
            animate={{ x: ['0%', '25%', '0%'] }}
            transition={{ repeat: Infinity, duration: 40, ease: 'easeInOut' }}
          />
          {/* Fog layer 2 - slow drift right to left */}
          <motion.div
            className="absolute -inset-1/2 w-[200%] h-[200%]"
            style={{
              background: 'radial-gradient(ellipse 60% 80% at 70% 60%, rgba(147, 51, 234, 0.06) 0%, transparent 45%)',
            }}
            animate={{ x: ['0%', '-20%', '0%'] }}
            transition={{ repeat: Infinity, duration: 35, ease: 'easeInOut', delay: 5 }}
          />
          {/* Fog layer 3 - vertical drift */}
          <motion.div
            className="absolute -inset-1/2 w-[200%] h-[200%]"
            style={{
              background: 'radial-gradient(ellipse 100% 40% at 50% 80%, rgba(30, 58, 95, 0.1) 0%, transparent 50%)',
            }}
            animate={{ y: ['0%', '-10%', '0%'] }}
            transition={{ repeat: Infinity, duration: 30, ease: 'easeInOut', delay: 10 }}
          />
        </motion.div>

        {/* Ambient background glow from center - intensity increases as journey progresses */}
        <motion.div 
          className="absolute inset-0 pointer-events-none"
          animate={{ opacity: 0.5 + atmosphere.glowOpacity }}
          transition={{ duration: 3, ease: 'easeInOut' }}
        >
          <motion.div 
            className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full blur-3xl"
            style={{ backgroundColor: GAME_MODE_COLORS.secondary }}
            animate={{ 
              scale: [1, 1.3, 1], 
              opacity: [0.2, 0.4, 0.2] 
            }}
            transition={{ repeat: Infinity, duration: 8, ease: 'easeInOut' }}
          />
          <motion.div 
            className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full blur-3xl"
            style={{ backgroundColor: GAME_MODE_COLORS.accent }}
            animate={{ 
              scale: [1.3, 1, 1.3], 
              opacity: [0.4, 0.2, 0.4] 
            }}
            transition={{ repeat: Infinity, duration: 7, ease: 'easeInOut' }}
          />
          {/* Center glow - intensity grows as journey progresses */}
          <motion.div 
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] rounded-full blur-3xl"
            style={{ backgroundColor: GAME_MODE_COLORS.glow }}
            animate={{ 
              scale: [0.8, 1.1, 0.8], 
              opacity: [atmosphere.glowOpacity, atmosphere.glowOpacity + 0.1, atmosphere.glowOpacity] 
            }}
            transition={{ repeat: Infinity, duration: 6, ease: 'easeInOut' }}
          />
        </motion.div>

        {/* Deep vignette - softens as journey progresses */}
        <motion.div 
          className="absolute inset-0 pointer-events-none"
          animate={{ opacity: atmosphere.vignetteIntensity }}
          transition={{ duration: 4, ease: 'easeInOut' }}
          style={{
            background: 'radial-gradient(ellipse 70% 60% at 50% 45%, transparent 0%, transparent 30%, rgba(5, 5, 8, 0.4) 60%, rgba(5, 5, 8, 1) 100%)',
          }}
        />

        {/* Floating dust particles - settle as journey progresses */}
        <ParticleField 
          particleCount={45} 
          speed={atmosphere.particleSpeed}
          color={`rgba(255, 255, 255, ${atmosphere.particleOpacity})`}
        />

        {/* Painterly noise texture overlay */}
        <div className="immersive-noise" />


        {/* Draggable region for window movement */}
        <div 
          data-tauri-drag-region 
          className="absolute top-0 left-0 right-0 h-12 z-[5]"
        />

        {/* Header controls - boxed shortcuts */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <div className="relative group/voice">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-[#0f0f14]/80 transition-all duration-300"
              title="Voice Settings (⌘V)"
            >
              <VoiceChanger size={14} className="shrink-0 opacity-60 group-hover/voice:opacity-100 transition-opacity duration-300" />
              <kbd className="p-1 bg-[#0c0c10]/80 rounded text-[10px] font-mono text-slate-500 border border-slate-700/40 leading-none">⌘V</kbd>
            </button>
            {/* Hover box */}
            <div className="absolute top-0 left-0 right-0 bottom-0 rounded-lg bg-[#0f0f14]/70 border border-slate-700/40 opacity-0 group-hover/voice:opacity-100 transition-all duration-300 -z-10" />
          </div>
          <div className="relative group/exit">
            <button
              onClick={handleExitRequest}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-[#0f0f14]/80 transition-all duration-300"
              title="Exit (⌘ESC)"
            >
              <kbd className="p-1 bg-[#0c0c10]/80 rounded text-[10px] font-mono text-slate-500 border border-slate-700/40 leading-none">⌘ESC</kbd>
            </button>
            {/* Hover box */}
            <div className="absolute top-0 left-0 right-0 bottom-0 rounded-lg bg-[#0f0f14]/70 border border-slate-700/40 opacity-0 group-hover/exit:opacity-100 transition-all duration-300 -z-10" />
          </div>
        </div>

        {/* Agent avatars + Journey Phase indicator - top left */}
        <div className="absolute top-4 left-4 z-30 flex items-center gap-3">
          <div className="relative flex items-center bg-[#0a0a0f]/80 rounded-full px-2 py-1.5 border border-slate-800/50">
            <div className="flex -space-x-2">
              {(['psyche', 'logic', 'instinct'] as const).map((agentId) => {
                const agentConfig = DISCO_AGENTS[agentId]; // Voice mode always uses disco agents
                return (
                  <div 
                    key={agentId} 
                    className="w-5 h-5 rounded-full overflow-hidden ring-2 ring-slate-800"
                  >
                    <img 
                      src={agentConfig.avatar} 
                      alt={agentConfig.name}
                      className="w-full h-full object-cover"
                    />
                  </div>
                );
              })}
            </div>
            {/* Single green active dot - slow pulse */}
            <motion.div
              className="absolute bottom-0 right-0 w-2 h-2 rounded-full border border-slate-800 z-10"
              style={{ backgroundColor: '#22C55E' }}
              animate={{ opacity: [0.6, 1, 0.6] }}
              transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>
          
          {/* Journey Phase indicator */}
          {journeySession && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#0a0a0f]/80 rounded-full border border-slate-800/50"
            >
              {/* Phase dots */}
              <div className="flex gap-1">
                {(['exploration', 'resolution', 'acceptance'] as const).map((phase, idx) => (
                  <motion.div
                    key={phase}
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      backgroundColor: currentPhase === phase 
                        ? (phase === 'exploration' ? '#3B82F6' : phase === 'resolution' ? '#A78BCA' : '#22C55E')
                        : idx < ['exploration', 'resolution', 'acceptance'].indexOf(currentPhase)
                          ? '#4B5563'
                          : '#1F2937',
                    }}
                    animate={currentPhase === phase ? { scale: [1, 1.3, 1] } : {}}
                    transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
                  />
                ))}
              </div>
              {/* Phase label */}
              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">
                {currentPhase}
              </span>
            </motion.div>
          )}
        </div>

        {/* Friendly error overlay */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center z-50"
              style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
              onClick={() => setError(null)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="max-w-sm p-6 rounded-2xl text-center"
                style={{ 
                  backgroundColor: 'rgba(30, 41, 59, 0.95)',
                  border: '1px solid rgba(248, 113, 113, 0.3)',
                  boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
                  <span className="text-2xl">⚠</span>
                </div>
                <h3 className="text-slate-200 font-medium mb-2">Something went wrong</h3>
                <p className="text-slate-400 text-sm mb-4 leading-relaxed">
                  {error.includes('API key') || error.includes('401') || error.includes('Unauthorized')
                    ? 'Your ElevenLabs API key appears to be invalid or missing.'
                    : error.includes('rate') || error.includes('429')
                      ? 'Rate limit reached. Please wait a moment and try again.'
                      : error.includes('network') || error.includes('fetch')
                        ? 'Network connection issue. Check your internet and try again.'
                        : error}
                </p>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => setError(null)}
                    className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    Dismiss
                  </button>
                  {(error.includes('API key') || error.includes('401') || error.includes('Unauthorized') || error.includes('configure')) && (
                    <button
                      onClick={() => {
                        setError(null);
                        setIsSettingsOpen(true);
                      }}
                      className="px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
                    >
                      Open Settings
                    </button>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Left Stream Panel - Thoughts + Governor */}
        <motion.div
          ref={thoughtsPanelRef}
          initial={{ x: -300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.8, ease: [0.25, 0.1, 0.25, 1] }}
          className="absolute left-4 top-16 bottom-28 w-72 flex flex-col z-20"
        >
          {/* Panel Header */}
          <div className="flex items-center justify-between px-3 py-2 rounded-t-xl bg-[#0a0a0f]/80 backdrop-blur-md border border-slate-800/40 border-b-0">
            <span className="text-[10px] font-sans text-slate-500 tracking-wider flex items-center gap-1.5">
              {tts.isSpeaking && (
                <>
                  <kbd className="px-2 py-0.5 rounded bg-slate-800/80 text-[9px] text-slate-400 border border-slate-600/50 font-mono">␣</kbd>
                  <span>to skip</span>
                </>
              )}
            </span>
          </div>
          
          {/* Dialog Stream - shows history + current */}
          <div ref={dialogScrollRef} className="flex-1 overflow-y-auto rounded-b-xl bg-[#08080c]/70 backdrop-blur-md border border-slate-800/40 border-t-0">
            {dialogHistory.length === 0 && currentThoughts.length === 0 && !isThinking && !currentGovernorText && (
              <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                Conversation will appear here...
              </div>
            )}
            
            {/* Dialog History - past entries */}
            {dialogHistory.map((entry) => {
              const agents = DISCO_AGENTS; // Voice mode always uses disco agents
              
              if (entry.type === 'user') {
                return (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="px-3 py-2 mb-2 border-l-2 border-blue-500/50 bg-blue-500/5"
                  >
                    <div className="flex items-start gap-2">
                      <img 
                        src={userAvatar}
                        alt="You"
                        className="w-4 h-4 rounded-full object-cover ring-1 ring-blue-500/40 shrink-0 mt-0.5"
                      />
                      <p className="text-[11px] text-blue-400/80 leading-loose">
                        {entry.content}
                      </p>
                    </div>
                  </motion.div>
                );
              }
              
              if (entry.type === 'thought' && entry.agentType) {
                const agent = agents[entry.agentType];
                return (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.6 }}
                    className="px-3 py-2 mb-1"
                  >
                    <div className="flex items-start gap-2">
                      <img 
                        src={agent.avatar} 
                        alt={agent.name} 
                        className="w-4 h-4 rounded-full flex-shrink-0 mt-0.5 opacity-50"
                      />
                      <div>
                        <span 
                          className="text-[8px] font-sans font-medium px-1 py-0.5 rounded mb-0.5 inline-block opacity-70"
                          style={{ backgroundColor: `${agent.color}15`, color: agent.color }}
                        >
                          {agent.name}
                        </span>
                        <p className="text-[10px] text-slate-500 leading-loose italic">
                          {entry.content}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                );
              }
              
              if (entry.type === 'governor') {
                return (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="px-3 py-2 mb-3 border-l-2"
                    style={{ borderColor: GOVERNOR.color }}
                  >
                    <div className="flex items-start gap-2">
                      <div 
                        className="w-4 h-4 rounded-full flex-shrink-0 mt-0.5 overflow-hidden"
                        style={{
                          WebkitMaskImage: 'radial-gradient(circle, white 50%, transparent 80%)',
                          maskImage: 'radial-gradient(circle, white 50%, transparent 80%)',
                        }}
                      >
                        <img 
                          src={governorGameMode} 
                          alt="Governor" 
                          className="w-full h-full object-cover scale-150"
                        />
                      </div>
                      <div className="flex-1">
                        <span 
                          className="inline-block px-1.5 py-0.5 rounded text-[9px] font-mono font-medium mb-1"
                          style={{ 
                            backgroundColor: `${GOVERNOR.color}20`,
                            color: GOVERNOR.color,
                          }}
                        >
                          {GOVERNOR.name}
                        </span>
                        <p className="text-[11px] text-slate-300 leading-loose">
                          {entry.content}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                );
              }
              
              return null;
            })}
            
            {/* Current thoughts - being spoken now */}
            {currentThoughts.map((thought, index) => {
              const agent = DISCO_AGENTS[thought.agentType]; // Voice mode always uses disco agents
              
              return (
                <motion.div
                  key={thought.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className={`px-3 py-2 ${thought.isActive ? 'bg-slate-800/20' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    <img 
                      src={agent.avatar} 
                      alt={agent.name} 
                      className="w-5 h-5 rounded-full flex-shrink-0 mt-0.5 opacity-70"
                    />
                    <div>
                      <span 
                        className="text-[9px] font-sans font-medium px-1.5 py-0.5 rounded mb-1 inline-block"
                        style={{ backgroundColor: `${agent.color}20`, color: agent.color }}
                      >
                        {agent.name}
                      </span>
                      <p className="text-[11px] text-slate-400 leading-relaxed italic">
                        <ThoughtText 
                          content={thought.content} 
                          isActive={thought.isActive}
                          isComplete={thought.isComplete}
                        />
                      </p>
                    </div>
                  </div>
                </motion.div>
              );
            })}
            
            {/* Current Governor response - being spoken now */}
            <AnimatePresence>
              {currentGovernorText && (
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className="px-3 py-2 border-l-2"
                  style={{ borderColor: GOVERNOR.color }}
                >
                  <div className="flex items-start gap-2">
                    <div 
                      className="w-5 h-5 rounded-full flex-shrink-0 mt-0.5 overflow-hidden relative"
                      style={{
                        WebkitMaskImage: 'radial-gradient(circle, white 50%, transparent 80%)',
                        maskImage: 'radial-gradient(circle, white 50%, transparent 80%)',
                        boxShadow: isGovernorSpeaking ? `0 0 12px ${GOVERNOR.color}80` : 'none',
                      }}
                    >
                      <img 
                        src={governorGameMode} 
                        alt="Governor" 
                        className="w-full h-full object-cover scale-150"
                      />
                    </div>
                    <div className="flex-1">
                      <span 
                        className="inline-block px-1.5 py-0.5 rounded text-[9px] font-mono font-medium mb-1"
                        style={{ 
                          backgroundColor: `${GOVERNOR.color}20`,
                          color: GOVERNOR.color,
                        }}
                      >
                        {GOVERNOR.name}
                      </span>
                      <p className="text-xs text-slate-200 leading-relaxed">
                        <ThoughtText 
                          content={currentGovernorText} 
                          isActive={isGovernorSpeaking}
                          isComplete={!isGovernorSpeaking}
                        />
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            
            <div ref={thoughtsEndRef} />
          </div>
        </motion.div>

        {/* Right Transcription Feed - shows when listening */}
        <div className="absolute right-8 bottom-28 w-96">
          <AnimatePresence>
            {immersiveTurn === 'user' && isListening && (
              <motion.div
                key="transcription"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex flex-col items-end"
              >
                {/* Box with profile picture and text - slow dreamy pulse */}
                <motion.div 
                  className="w-full rounded-xl bg-[#0a0a0f]/80 backdrop-blur-md border border-slate-800/40 shadow-2xl overflow-hidden"
                  animate={{ 
                    borderColor: ['rgba(100, 116, 139, 0.25)', 'rgba(59, 130, 246, 0.35)', 'rgba(100, 116, 139, 0.25)']
                  }}
                  transition={{ 
                    repeat: Infinity, 
                    duration: 4,
                    ease: 'easeInOut'
                  }}
                >
                  <div className="flex items-start gap-3 p-3">
                    {/* Profile picture - always visible */}
                    <img
                      src={userAvatar}
                      alt="You"
                      className="w-10 h-10 rounded-full object-cover ring-2 ring-blue-400/40 shrink-0"
                    />
                    {/* Text area */}
                    <div className="flex-1 min-h-[40px] flex items-center">
                      {currentTranscript.replace(/\s*submit[.!?,\s]*$/i, '').trim() ? (
                        <p className="text-sm text-white/90 leading-relaxed font-light text-left">
                          {currentTranscript.replace(/\s*submit[.!?,\s]*$/i, '').trim()}
                        </p>
                      ) : (
                        <motion.span 
                          className="text-sm text-slate-500 italic"
                          animate={{ opacity: [0.35, 0.65, 0.35] }}
                          transition={{ repeat: Infinity, duration: 2.5, ease: 'easeInOut' }}
                        >
                          listening...
                        </motion.span>
                      )}
                    </div>
                  </div>
                </motion.div>
                <span className="text-[9px] text-slate-600 font-sans mt-1.5">
                  say "Submit"
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Center content - Governor (completely transparent, no border) */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div ref={governorRef} className="relative pointer-events-auto">
            {/* Thinking rings - pulse when processing - slow dreamy pace */}
            {isThinking && (
              <>
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="absolute inset-0 rounded-full border-2"
                    style={{ 
                      borderColor: themeColor,
                      margin: `${-20 - i * 20}px`,
                    }}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ 
                      opacity: [0.2, 0.5, 0.2],
                      scale: [1, 1.08, 1],
                    }}
                    transition={{ 
                      repeat: Infinity, 
                      duration: 3.5, 
                      delay: i * 0.6,
                      ease: 'easeInOut',
                    }}
                  />
                ))}
              </>
            )}
            
            {/* Governor avatar with state-based animations */}
            <div className="w-56 h-56 relative">
              {/* Orbiting agent avatars when agents are speaking */}
              {currentThoughts.length > 0 && (
                <div className="absolute inset-0">
                  {currentThoughts.map((thought, index) => {
                    const agent = DISCO_AGENTS[thought.agentType];
                    const orbitRadius = 140; // Distance from center
                    const startAngle = index * (360 / Math.max(currentThoughts.length, 1));
                    
                    return (
                      <motion.div
                        key={thought.id}
                        className="absolute"
                        style={{
                          width: 40,
                          height: 40,
                          left: '50%',
                          top: '50%',
                          marginLeft: -20,
                          marginTop: -20,
                        }}
                        initial={{ opacity: 0, scale: 0 }}
                        animate={{ 
                          opacity: thought.isActive ? 1 : 0.4,
                          scale: thought.isActive ? 1 : 0.8,
                          rotate: [startAngle, startAngle + 360],
                        }}
                        exit={{ opacity: 0, scale: 0 }}
                        transition={{
                          rotate: {
                            duration: 24, // Slower, dreamier orbit
                            repeat: Infinity,
                            ease: 'linear',
                          },
                          opacity: { duration: 0.6 },
                          scale: { duration: 0.6 },
                        }}
                      >
                        <motion.div
                          style={{ 
                            transform: `translateX(${orbitRadius}px)`,
                          }}
                          animate={{
                            rotate: [-startAngle, -startAngle - 360], // Counter-rotate to keep upright
                          }}
                          transition={{
                            duration: 24, // Match outer rotation
                            repeat: Infinity,
                            ease: 'linear',
                          }}
                        >
                          <div 
                            className="w-10 h-10 rounded-full overflow-hidden border-2"
                            style={{ 
                              borderColor: agent.color,
                              boxShadow: thought.isActive ? `0 0 16px ${agent.color}60` : 'none',
                            }}
                          >
                            <img src={agent.avatar} alt={agent.name} className="w-full h-full object-cover" />
                          </div>
                        </motion.div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
              
              {/* Governor speaking ring - amber glow - slow dreamy pulse */}
              {isGovernorSpeaking && (
                <motion.div
                  className="absolute -inset-6 rounded-full"
                  style={{
                    background: `radial-gradient(circle, transparent 50%, ${GOVERNOR.color}40 60%, transparent 70%)`,
                  }}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{
                    scale: [1, 1.06, 1],
                    opacity: [0.4, 0.7, 0.4],
                  }}
                  transition={{
                    duration: 4,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                />
              )}
              
              {/* Animated ring based on state - using key to prevent jittery transitions */}
              <motion.div
                key={isListening ? 'listening' : isThinking ? 'thinking' : 'default'}
                className="absolute inset-0 rounded-full"
                initial={{ opacity: 0.3, scale: 1 }}
                style={{
                  background: isListening
                    ? 'radial-gradient(circle, transparent 45%, rgba(59, 130, 246, 0.25) 50%, transparent 55%)'
                    : isThinking
                    ? 'radial-gradient(circle, transparent 45%, rgba(234, 179, 8, 0.35) 50%, transparent 55%)'
                    : 'radial-gradient(circle, transparent 45%, rgba(100, 116, 139, 0.12) 50%, transparent 55%)',
                }}
                animate={{
                  scale: [1, 1.03, 1],
                  opacity: isListening || isThinking
                    ? [0.5, 0.8, 0.5]
                    : [0.25, 0.45, 0.25],
                }}
                transition={{
                  duration: 5,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
              />
              
              {/* Secondary outer ring for listening/thinking - slow dreamy */}
              {(isListening || isThinking) && (
                <motion.div
                  key={isListening ? 'outer-listening' : 'outer-thinking'}
                  className="absolute -inset-4 rounded-full"
                  initial={{ opacity: 0, scale: 1 }}
                  style={{
                    background: isListening
                      ? 'radial-gradient(circle, transparent 60%, rgba(59, 130, 246, 0.12) 70%, transparent 80%)'
                      : 'radial-gradient(circle, transparent 60%, rgba(234, 179, 8, 0.15) 70%, transparent 80%)',
                  }}
                  animate={{
                    scale: [1, 1.08, 1],
                    opacity: [0.3, 0.6, 0.3],
                    rotate: isThinking ? [0, 360] : 0,
                  }}
                  transition={{
                    duration: isThinking ? 8 : 6,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                />
              )}
              
              {/* Governor image container - circular with radial fade */}
              <div className="relative w-full h-full">
                {/* Spinning glow ring - creates rotation illusion */}
                <motion.div
                  className="absolute inset-[-8px] rounded-full pointer-events-none"
                  style={{
                    background: 'conic-gradient(from 0deg, transparent 0%, rgba(59, 130, 246, 0.3) 25%, transparent 50%, rgba(147, 51, 234, 0.2) 75%, transparent 100%)',
                  }}
                  animate={{
                    rotate: [0, 360],
                  }}
                  transition={{
                    duration: 20,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                />
                
                {/* Secondary counter-rotating glow */}
                <motion.div
                  className="absolute inset-[-4px] rounded-full pointer-events-none"
                  style={{
                    background: 'conic-gradient(from 180deg, transparent 0%, rgba(59, 130, 246, 0.15) 30%, transparent 60%, rgba(100, 116, 139, 0.1) 80%, transparent 100%)',
                  }}
                  animate={{
                    rotate: [360, 0],
                  }}
                  transition={{
                    duration: 15,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                />
                
                {/* Circular mask with radial fade - breathing scale */}
                <motion.div 
                  className="absolute inset-0 rounded-full overflow-hidden"
                  style={{
                    WebkitMaskImage: 'radial-gradient(circle, white 40%, transparent 70%)',
                    maskImage: 'radial-gradient(circle, white 40%, transparent 70%)',
                  }}
                  animate={{
                    scale: isGovernorSpeaking 
                      ? [0.95, 1.05, 0.95]
                      : isThinking
                      ? [0.98, 1.02, 0.98]
                      : [0.97, 1.03, 0.97],
                  }}
                  transition={{
                    duration: isGovernorSpeaking ? 3 : 5,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                >
                  <img 
                    src={governorGameMode} 
                    alt="Governor"
                    className="w-full h-full object-cover"
                    style={{ transform: 'scale(1.35)' }}
                  />
                </motion.div>
                
                {/* Inner glow pulse */}
                <motion.div
                  className="absolute inset-0 rounded-full pointer-events-none"
                  style={{
                    background: isGovernorSpeaking 
                      ? 'radial-gradient(circle, transparent 25%, rgba(59, 130, 246, 0.3) 45%, transparent 65%)'
                      : isThinking
                      ? 'radial-gradient(circle, transparent 25%, rgba(234, 179, 8, 0.25) 45%, transparent 65%)'
                      : 'radial-gradient(circle, transparent 30%, rgba(59, 130, 246, 0.15) 50%, transparent 70%)',
                  }}
                  animate={{
                    opacity: [0.5, 1, 0.5],
                    scale: [0.98, 1.02, 0.98],
                  }}
                  transition={{
                    duration: 4,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Bottom waveform */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-[600px] h-16">
          <WaveformVisualizer
            isActive={isListening || tts.isSpeaking}
            mode={
              isListening
                ? 'input' 
                : tts.isSpeaking 
                  ? 'output' 
                  : 'idle'
            }
            color={tts.isSpeaking && tts.currentSpeaker 
              ? (tts.currentSpeaker === 'governor' ? GOVERNOR.color : DISCO_AGENTS[tts.currentSpeaker as AgentType]?.color || themeColor)
              : isListening 
                ? '#3B82F6' // Blue when recording
                : themeColor
            }
            className="w-full h-full"
            outputAnalyser={tts.analyser}
          />
        </div>


        {/* Settings overlay */}
        <ImmersiveSettings 
          isOpen={isSettingsOpen} 
          onClose={() => setIsSettingsOpen(false)}
          onOpenApiKeys={() => {
            setIsSettingsOpen(false);
            setImmersiveMode(false);
            // The API key modal will show automatically if keys are missing
            // Or user can access via profile
          }}
        />
        
        {/* Exit Confirmation Modal */}
        <AnimatePresence>
          {showExitConfirm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-md"
              onClick={() => setShowExitConfirm(false)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 10 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 10 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="bg-obsidian/95 border border-smoke/20 rounded-xl p-5 w-72 mx-4 shadow-2xl relative"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setShowExitConfirm(false);
                  }
                }}
                tabIndex={0}
                ref={(el) => el?.focus()}
              >
                {/* ESC button - top right */}
                <kbd 
                  onClick={() => setShowExitConfirm(false)}
                  className="absolute top-3 right-3 px-1.5 py-0.5 rounded bg-charcoal/50 text-[9px] font-sans text-ash/40 border border-smoke/20 cursor-pointer hover:text-ash/60 hover:border-smoke/40 transition-colors"
                >
                  ESC
                </kbd>
                
                {/* Header */}
                <h3 className="text-ash font-sans text-xs font-medium tracking-wide mb-3 pr-10">EXIT GAME MODE?</h3>
                
                <p className="text-ash/50 text-[10px] font-sans mb-4">
                  Your conversation will be lost.
                </p>
                
                <div className="flex gap-2">
                  <button
                    onClick={copyVoiceConversation}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border transition-all text-[10px] font-sans ${
                      copiedVoice 
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : 'border-smoke/20 text-ash/60 hover:text-ash hover:border-smoke/40'
                    }`}
                  >
                    {copiedVoice ? <ClipboardCheck size={11} /> : <ClipboardCopy size={11} />}
                    {copiedVoice ? 'Copied' : 'Copy'}
                    <kbd className="px-1 py-0.5 rounded bg-charcoal/50 text-[8px] text-ash/40 border border-smoke/20">C</kbd>
                  </button>
                  <button
                    onClick={() => {
                      setShowExitConfirm(false);
                      setImmersiveMode(false);
                    }}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 transition-all text-[10px] font-sans font-medium"
                  >
                    Exit
                    <kbd className="px-1 py-0.5 rounded bg-charcoal/50 text-[8px] text-red-400/50 border border-red-500/20">↵ ENT</kbd>
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        
        {/* Phase Transition Confirmation Modal */}
        <AnimatePresence>
          {journeySession?.pendingTransition && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[180] flex items-center justify-center bg-black/50 backdrop-blur-sm"
              onClick={() => setJourneyPendingTransition(null)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 10 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 10 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="bg-[#0a0a12]/95 border border-slate-700/30 rounded-xl p-6 w-80 mx-4 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Phase transition icon */}
                <div className="flex items-center justify-center gap-3 mb-4">
                  <div 
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ 
                      backgroundColor: currentPhase === 'exploration' ? '#3B82F6' : '#A78BCA',
                    }}
                  />
                  <motion.span 
                    className="text-slate-500"
                    animate={{ x: [0, 4, 0] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                  >
                    →
                  </motion.span>
                  <div 
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ 
                      backgroundColor: journeySession.pendingTransition === 'resolution' ? '#A78BCA' : '#22C55E',
                    }}
                  />
                </div>
                
                {/* Header */}
                <h3 className="text-slate-200 font-medium text-sm text-center mb-2">
                  {journeySession.pendingTransition === 'resolution' 
                    ? 'Ready to explore solutions?' 
                    : 'Ready to accept and move forward?'}
                </h3>
                
                <p className="text-slate-500 text-xs text-center mb-5 leading-relaxed">
                  {journeySession.pendingTransition === 'resolution'
                    ? 'You\'ve identified the core issue. Let\'s find a path forward.'
                    : 'You\'ve found your resolution. Time to integrate and close this chapter.'}
                </p>
                
                <div className="flex gap-2">
                  <button
                    onClick={() => setJourneyPendingTransition(null)}
                    className="flex-1 px-3 py-2 rounded-lg border border-slate-700/30 text-slate-500 hover:text-slate-300 hover:border-slate-600/40 transition-all text-xs"
                  >
                    Not yet
                  </button>
                  <button
                    onClick={async () => {
                      if (journeySession.pendingTransition === 'acceptance') {
                        // Complete the journey
                        try {
                          await completeJourneySession(journeySession.id);
                        } catch (err) {
                          console.error('Failed to complete journey:', err);
                        }
                      } else {
                        // Confirm phase transition
                        try {
                          await confirmJourneyPhaseBackend(journeySession.id);
                        } catch (err) {
                          console.error('Failed to confirm phase:', err);
                        }
                      }
                      confirmJourneyTransition();
                    }}
                    className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all"
                    style={{
                      backgroundColor: journeySession.pendingTransition === 'acceptance' 
                        ? 'rgba(34, 197, 94, 0.2)' 
                        : 'rgba(167, 139, 202, 0.2)',
                      border: journeySession.pendingTransition === 'acceptance'
                        ? '1px solid rgba(34, 197, 94, 0.4)'
                        : '1px solid rgba(167, 139, 202, 0.4)',
                      color: journeySession.pendingTransition === 'acceptance'
                        ? '#4ADE80'
                        : '#C4B5FD',
                    }}
                  >
                    {journeySession.pendingTransition === 'acceptance' ? 'Complete Journey' : 'Continue'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}
