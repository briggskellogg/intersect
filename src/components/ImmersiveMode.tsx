import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { useAppStore } from '../store';
import { sendMessage as sendMessageToBackend, createConversation, getConversationOpener } from '../hooks/useTauri';
import { useBackgroundMusic } from '../hooks/useBackgroundMusic';
import { useScribeTranscription } from '../hooks/useScribeTranscription';
import { useElevenLabsTTS } from '../hooks/useElevenLabsTTS';
import { useSubmitDetection } from '../hooks/useSubmitDetection';
import { WaveformVisualizer } from './WaveformVisualizer';
import { ImmersiveSettings } from './ImmersiveSettings';
import { DISCO_AGENTS } from '../constants/agents'; // Voice mode always uses disco agents
import { VoiceChanger, ClipboardCopy, ClipboardCheck } from './icons';
import { AgentType } from '../types';

// Import thinking audio
import thinkingAudioSrc from '../assets/governor-thinking.mp3';

// Import transparent Governor for immersive mode
import governorTransparent from '../assets/governor-transparent-immersive.png';

interface ThoughtState {
  id: string;
  agentType: AgentType;
  content: string;
  isActive: boolean;
  isComplete: boolean;
}

// Voice mode always uses disco colors
const DISCO_COLORS = {
  primary: '#EAB308',  // Yellow/gold
  secondary: '#EAB308', 
  accent: '#F59E0B',
  glow: '#EAB308',
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

export function ImmersiveMode() {
  const {
    isImmersiveMode,
    setImmersiveMode,
    elevenLabsApiKey,
    immersiveVoices,
    immersiveTurn,
    setImmersiveTurn,
    userProfile,
    setLastImmersiveConversationId,
    backgroundMusic,
    backgroundMusicVolume,
  } = useAppStore();
  
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
  const [copiedVoice, setCopiedVoice] = useState(false);
  
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

  // Copy voice mode conversation to clipboard
  const copyVoiceConversation = useCallback(async () => {
    let text = '';
    
    dialogHistory.forEach((entry) => {
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
    currentThoughts.forEach((thought) => {
      const agent = DISCO_AGENTS[thought.agentType];
      text += `${agent?.name || thought.agentType} (thinking):\n${thought.content}\n\n`;
    });
    
    if (currentGovernorText) {
      text += `Governor:\n${currentGovernorText}\n\n`;
    }
    
    try {
      await navigator.clipboard.writeText(text.trim());
      setCopiedVoice(true);
      setTimeout(() => setCopiedVoice(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [dialogHistory, currentThoughts, currentGovernorText]);

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
    } catch (err) {
      console.error('Send message error:', err);
      setError(err instanceof Error ? err.message : 'Failed to send message');
      setIsThinking(false);
      stopThinkingAudio();
      setImmersiveTurn('user');
      setIsListening(true);
    }
  }, [gameModeConversationId, scribe, tts, elevenLabsApiKey, immersiveVoices, setImmersiveTurn, getThoughtVoiceId]);

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
      setError(null);
      hasInitializedRef.current = false; // Reset so next session initializes properly
    };
  }, [isImmersiveMode, elevenLabsApiKey]);

  // Handle exit with confirmation if there's dialogue
  const handleExitRequest = useCallback(() => {
    if (dialogHistory.length > 0 || currentThoughts.length > 0 || currentGovernorText) {
      setShowExitConfirm(true);
    } else {
      setImmersiveMode(false);
    }
  }, [dialogHistory, currentThoughts, currentGovernorText, setImmersiveMode]);
  
  // Keyboard shortcuts: Cmd+ESC to exit, Cmd+V for settings, Space to skip
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Escape' && !isSettingsOpen && !showExitConfirm) {
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
  }, [isImmersiveMode, setImmersiveMode, isSettingsOpen, tts, isGovernorSpeaking, currentGovernorText, currentThoughts, stopThinkingAudio, setImmersiveTurn, elevenLabsApiKey, scribe, startThinkingAudio, handleExitRequest, copyVoiceConversation, showExitConfirm]);

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

  // Voice mode always uses disco styling
  const themeColor = DISCO_COLORS.primary;

  return (
    <AnimatePresence>
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 overflow-hidden rounded-xl"
        style={{
          background: 'linear-gradient(135deg, #0f0a1a 0%, #1a0a2e 50%, #0a1628 100%)', // Voice mode disco style
          filter: 'saturate(1.2)',
        }}
      >
        {/* Ambient background glow from center */}
        <div className="absolute inset-0 opacity-40">
          <motion.div 
            className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full blur-3xl"
            style={{ backgroundColor: DISCO_COLORS.secondary }}
            animate={{ 
              scale: [1, 1.2, 1], 
              opacity: [0.3, 0.5, 0.3] 
            }}
            transition={{ repeat: Infinity, duration: 4 }}
          />
          <motion.div 
            className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full blur-3xl"
            style={{ backgroundColor: DISCO_COLORS.accent }}
            animate={{ 
              scale: [1.2, 1, 1.2], 
              opacity: [0.5, 0.3, 0.5] 
            }}
            transition={{ repeat: Infinity, duration: 4 }}
          />
          {/* Center glow - always shown in voice mode */}
          <motion.div 
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full blur-3xl"
            style={{ backgroundColor: DISCO_COLORS.glow }}
            animate={{ scale: [0.8, 1, 0.8], opacity: [0.1, 0.2, 0.1] }}
            transition={{ repeat: Infinity, duration: 3 }}
          />
        </div>


        {/* Header controls - boxed shortcuts */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 hover:border-slate-600/50 transition-all text-[11px] font-sans tracking-wide"
            title="Voice Settings (⌘V)"
          >
            <VoiceChanger size={14} className="flex-shrink-0" />
            <span>⌘V</span>
          </button>
          <button
            onClick={handleExitRequest}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 hover:border-slate-600/50 transition-all text-[11px] font-sans tracking-wide"
            title="Exit (⌘ESC)"
          >
            ⌘ESC
          </button>
        </div>

        {/* Agent avatars - top left (always disco agents in voice mode) */}
        <div className="absolute top-4 left-4 z-30 flex items-center gap-3">
          <div className="relative flex items-center bg-slate-800/60 rounded-full px-2 py-1.5 border border-amber-500/30">
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
            {/* Single green active dot */}
            <motion.div
              className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-slate-800 z-10"
              style={{ backgroundColor: '#22C55E' }}
              animate={{ opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>
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
          transition={{ delay: 0.2 }}
          className="absolute left-4 top-16 bottom-28 w-72 flex flex-col z-20"
        >
          {/* Panel Header */}
          <div className="flex items-center justify-between px-3 py-2 rounded-t-xl bg-slate-900/60 backdrop-blur-sm border border-slate-700/30 border-b-0">
            <span className="text-[10px] font-sans text-slate-500 tracking-wider">
              {tts.isSpeaking ? 'SPACE to skip' : ''}
            </span>
          </div>
          
          {/* Dialog Stream - shows history + current */}
          <div ref={dialogScrollRef} className="flex-1 overflow-y-auto rounded-b-xl bg-slate-900/40 backdrop-blur-sm border border-slate-700/30 border-t-0">
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
                    className="px-3 py-2 mb-2 border-l-2 border-emerald-500/50 bg-emerald-500/5"
                  >
                    <p className="text-[11px] text-emerald-400/80 leading-loose">
                      {entry.content}
                    </p>
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
                    style={{ borderColor: themeColor }}
                  >
                    <div className="flex items-start gap-2">
                      <img 
                        src={governorTransparent} 
                        alt="Governor" 
                        className="w-4 h-4 rounded-full flex-shrink-0 mt-0.5 opacity-70"
                      />
                      <p className="text-[11px] text-slate-300 leading-loose">
                        {entry.content}
                      </p>
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
                  style={{ borderColor: themeColor }}
                >
                  <div className="flex items-start gap-2">
                    <img 
                      src={governorTransparent} 
                      alt="Governor" 
                      className="w-5 h-5 rounded-full flex-shrink-0 mt-0.5"
                      style={{ 
                        boxShadow: isGovernorSpeaking ? `0 0 8px ${themeColor}60` : 'none',
                      }}
                    />
                    <p className="text-xs text-slate-200 leading-relaxed">
                      <ThoughtText 
                        content={currentGovernorText} 
                        isActive={isGovernorSpeaking}
                        isComplete={!isGovernorSpeaking}
                      />
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            
            <div ref={thoughtsEndRef} />
          </div>
        </motion.div>

        {/* Right Transcription Feed - shows when listening, editable */}
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
                <div className="w-full max-h-80 rounded-xl bg-slate-900/70 backdrop-blur-md border border-slate-700/30 overflow-y-auto shadow-2xl" style={{ scrollbarWidth: 'none' }}>
                  <p className="px-4 py-3 text-sm text-white/90 leading-relaxed font-light text-right min-h-[60px]">
                    {currentTranscript.replace(/\s*submit[.!?,\s]*$/i, '').trim() || <span className="text-slate-500 italic">listening...</span>}
                  </p>
                </div>
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
            {/* Thinking rings - pulse when processing */}
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
                      opacity: [0.3, 0.6, 0.3],
                      scale: [1, 1.1, 1],
                    }}
                    transition={{ 
                      repeat: Infinity, 
                      duration: 1.5, 
                      delay: i * 0.3,
                      ease: 'easeInOut',
                    }}
                  />
                ))}
              </>
            )}
            
            {/* Governor avatar - transparent, no circular crop, no pulsing */}
            <div className="w-56 h-56 relative">
              <img 
                src={governorTransparent} 
                alt="Governor"
                className="w-full h-full object-contain"
              />
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
              ? (tts.currentSpeaker === 'governor' ? themeColor : DISCO_AGENTS[tts.currentSpeaker as AgentType]?.color || themeColor)
              : isListening 
                ? '#10B981' // Green when recording
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
                    <kbd className="px-1 py-0.5 rounded bg-charcoal/50 text-[8px] text-ash/40 border border-smoke/20">⌘C</kbd>
                  </button>
                  <button
                    onClick={() => {
                      setShowExitConfirm(false);
                      setImmersiveMode(false);
                    }}
                    className="flex-1 px-3 py-2 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30 transition-all text-[10px] font-sans font-medium"
                  >
                    Exit
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
