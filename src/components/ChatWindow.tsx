import { useEffect, useRef, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { MessageSquare, BotMessageSquare, ShieldCheck, X, Minus, Square, Mic } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ProfileSwitcher } from './ProfileSwitcher';
import { useAppStore } from '../store';
import { Message, AgentType, DebateMode } from '../types';
import { AGENTS, DISCO_AGENTS, AGENT_ORDER, USER_PROFILES } from '../constants/agents';
import { 
  sendMessage, 
  createConversation, 
  getConversationOpener,
  getUserProfile,
  finalizeConversation,
  recoverConversations,
  InitResult,
} from '../hooks/useTauri';
import { useScribeTranscription } from '../hooks/useScribeTranscription';
import { v4 as uuidv4 } from 'uuid';
import governorIcon from '../assets/governor.png';
import spiritAnimal from '../assets/spirit_animal.png';
import { GovernorNotification } from './GovernorNotification';

interface ChatWindowProps {
  onOpenSettings: () => void;
  onOpenReport: () => void;
  recoveryNeeded?: InitResult | null;
  onRecoveryComplete?: () => void;
}

export function ChatWindow({ onOpenSettings, onOpenReport, recoveryNeeded, onRecoveryComplete }: ChatWindowProps) {
  const {
    messages,
    addMessage,
    clearMessages,
    currentConversation,
    setCurrentConversation,
    getActiveAgentsList,
    agentModes,
    toggleAgentMode,
    isDiscoConversation,
    debateMode,
    setDebateMode,
    isLoading,
    setIsLoading,
    thinkingAgent,
    setThinkingAgent,
    thinkingPhase,
    setThinkingPhase,
    setError,
    setApiConnectionError,
    userProfile,
    setUserProfile,
  } = useAppStore();
  
  // Count active agents for Governor logic (on or disco = active)
  const activeCount = Object.values(agentModes).filter(m => m !== 'off').length;
  
  const { activePersonaProfile, elevenLabsApiKey, isSettingsOpen } = useAppStore();
  
  // Get dominant trait from active persona profile
  const dominantAgent: AgentType = activePersonaProfile?.dominantTrait || 'logic';
  
  const [inputValue, setInputValue] = useState('');
  const [governorNotification, setGovernorNotification] = useState<{
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hasInitialized = useRef(false);
  const shouldCancelDebate = useRef(false); // For user interruption during multi-turn debates
  const pendingMessage = useRef<string | null>(null); // Queue user's interrupting message
  
  // Voice transcription - get key from localStorage as fallback for fresh loads
  const effectiveElevenLabsKey = elevenLabsApiKey || (typeof localStorage !== 'undefined' ? localStorage.getItem('elevenlabs-api-key') : null) || '';
  
  const {
    isConnected: isTranscribing, // Use isConnected since isTranscribing never becomes true
    isConnecting,
    transcript,
    partialTranscript,
    start: startTranscription,
    stop: stopTranscription,
    clearTranscript,
  } = useScribeTranscription({
    apiKey: effectiveElevenLabsKey,
    onError: (err) => setError(err.message),
  });

  
  // Sync transcript to input when committed
  useEffect(() => {
    if (transcript) {
      setInputValue(prev => {
        const separator = prev.trim() ? ' ' : '';
        return prev + separator + transcript;
      });
      clearTranscript();
    }
  }, [transcript, clearTranscript]);

  // Reset initialization when profile changes
  const prevProfileId = useRef<string | null>(null);
  useEffect(() => {
    if (activePersonaProfile?.id && prevProfileId.current && prevProfileId.current !== activePersonaProfile.id) {
      // Profile changed - allow re-initialization
      hasInitialized.current = false;
    }
    prevProfileId.current = activePersonaProfile?.id || null;
  }, [activePersonaProfile?.id]);

  // Initialize conversation when API key is available or profile changes
  useEffect(() => {
    async function initConversation() {
      // Prevent double initialization in React StrictMode
      if (hasInitialized.current) {
        return;
      }
      hasInitialized.current = true;
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ChatWindow.tsx:initConversation-start',message:'initConversation starting',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      try {
        // Create a new conversation
        const conv = await createConversation();
        setCurrentConversation(conv);
        
        // Dominant agent is greeting the user
        setIsLoading(true);
        setThinkingPhase('thinking');
        setThinkingAgent(dominantAgent); // Dominant agent thinking
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ChatWindow.tsx:before-getOpener',message:'About to call getConversationOpener',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        // Get Governor greeting
        const openerResult = await getConversationOpener();
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ChatWindow.tsx:after-getOpener',message:'getConversationOpener completed',data:{agent:openerResult.agent},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        const openerMessage: Message = {
          id: uuidv4(),
          conversationId: conv.id,
          role: openerResult.agent as Message['role'], // Dominant agent greeting
          content: openerResult.content,
          responseType: 'primary',
          timestamp: new Date(),
        };
        addMessage(openerMessage);
        setIsLoading(false);
        setThinkingAgent(null);
      } catch (err) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ChatWindow.tsx:initConversation-error',message:'initConversation error',data:{error:String(err)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        console.error('Failed to init conversation:', err);
        setIsLoading(false);
        setThinkingAgent(null);
        hasInitialized.current = false; // Allow retry on error
      }
    }
    
    // Only init if we have an API key and no current conversation
    if (userProfile?.apiKey && !currentConversation) {
      initConversation();
    }
  }, [userProfile?.apiKey, currentConversation]);

  // Track if user has manually scrolled up
  const userScrolledUp = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  
  // Check if user is near bottom of scroll
  const isNearBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const threshold = 100; // pixels from bottom
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  };
  
  // Track user scroll - if they scroll up, don't auto-scroll
  const handleScroll = () => {
    userScrolledUp.current = !isNearBottom();
  };
  
  // Scroll to bottom when messages change (only if user hasn't scrolled up)
  useEffect(() => {
    if (!userScrolledUp.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);
  
  // When loading starts, reset scroll tracking. When loading ends, scroll to show full response.
  useEffect(() => {
    if (isLoading) {
      // Only auto-scroll if user is near bottom when loading starts
      if (isNearBottom()) {
        userScrolledUp.current = false;
      }
    } else {
      // Loading finished - scroll to bottom to show full response (with small delay for render)
      if (!userScrolledUp.current) {
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      }
    }
  }, [isLoading]);

  // Track close handling
  const isClosingRef = useRef(false);
  
  // Handle window close with archiving
  const handleWindowClose = useCallback(async () => {
    if (isClosingRef.current) return;
    
    const appWindow = getCurrentWindow();
    
    if (currentConversation && messages.length > 1) {
      const shouldClose = await confirm(
        "This will end your current conversation, but don't worry — it will be stored in Intersect's knowledge base.",
        { title: 'Intersect', kind: 'info', okLabel: 'Close', cancelLabel: 'Cancel' }
      );
      
      if (!shouldClose) return;
      
      isClosingRef.current = true;
      
      // Fire and forget - don't block window close
      finalizeConversation(currentConversation.id).catch(err => {
        console.error('Failed to finalize on close:', err);
      });
    } else {
      isClosingRef.current = true;
    }
    
    try {
      await appWindow.destroy();
    } catch (err) {
      console.error('Failed to destroy window:', err);
      try {
        isClosingRef.current = false;
        await appWindow.close();
      } catch (err2) {
        console.error('Failed to close window:', err2);
        isClosingRef.current = false;
      }
    }
  }, [currentConversation, messages.length]);
  
  // Listen for window close request
  useEffect(() => {
    const appWindow = getCurrentWindow();
    
    const unlisten = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      await handleWindowClose();
    });
    
    return () => {
      unlisten.then(fn => fn());
    };
  }, [handleWindowClose]);

  // Clear debate mode after a few seconds
  useEffect(() => {
    if (debateMode) {
      const timer = setTimeout(() => setDebateMode(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [debateMode, setDebateMode]);

  // Handle recovery of orphaned conversations from crashes/force-quits
  useEffect(() => {
    if (recoveryNeeded && recoveryNeeded.status === 'recovery_needed' && recoveryNeeded.recoveredCount > 0) {
      const runRecovery = async () => {
        const count = recoveryNeeded.recoveredCount;
        setGovernorNotification({
          message: `Recovering ${count} conversation${count > 1 ? 's' : ''} from last session...`
        });
        
        try {
          await recoverConversations();
          setGovernorNotification({
            message: `Memory updated with ${count} recovered conversation${count > 1 ? 's' : ''}.`
          });
        } catch (err) {
          console.error('Failed to recover conversations:', err);
          setGovernorNotification({ message: 'Failed to recover some conversations.' });
        }
        
        // Clear recovery state
        onRecoveryComplete?.();
      };
      
      runRecovery();
    }
  }, [recoveryNeeded, onRecoveryComplete]);

  // Toggle transcription handler
  const toggleTranscription = useCallback(async () => {
    if (!effectiveElevenLabsKey) {
      setGovernorNotification({
        message: 'elevenlabs_key_prompt', // Special key for custom rendering
        actionLabel: 'Open Profile',
        onAction: onOpenSettings,
      });
      return;
    }
    
    if (isTranscribing) {
      stopTranscription();
    } else {
      try {
        await startTranscription();
      } catch (err) {
        console.error('Failed to start transcription:', err);
      }
    }
  }, [effectiveElevenLabsKey, isTranscribing, startTranscription, stopTranscription, onOpenSettings]);
  
  // Global keyboard shortcuts (Command + key)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Command key shortcuts
      if (e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'n':
            e.preventDefault();
            handleNewConversation(false); // New normal conversation
            break;
          case 'd':
            e.preventDefault();
            handleNewConversation(true); // New disco conversation
            break;
          case 'p':
            e.preventDefault();
            onOpenSettings(); // Open Profile modal
            break;
          case 'g':
            e.preventDefault();
            onOpenReport(); // Open The Governor (report)
            break;
          case 's':
            e.preventDefault();
            toggleTranscription(); // Toggle voice transcription
            break;
          case '1':
            // Skip if Settings is open - let Settings handle profile switching
            if (!isSettingsOpen) {
              e.preventDefault();
              toggleAgentMode('psyche'); // Toggle Puff (first in UI order)
            }
            break;
          case '2':
            if (!isSettingsOpen) {
              e.preventDefault();
              toggleAgentMode('logic'); // Toggle Dot (second in UI order)
            }
            break;
          case '3':
            if (!isSettingsOpen) {
              e.preventDefault();
              toggleAgentMode('instinct'); // Toggle Snap (third in UI order)
            }
            break;
        }
        
        // Cmd+Enter: Send and stop transcription
        if (e.key === 'Enter') {
          e.preventDefault();
          if (isTranscribing) {
            stopTranscription();
          }
          handleSend();
        }
      }
      
      // Non-command shortcuts (only when not in input)
      if (!(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) {
        if (e.key === '/') {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }
    };
    
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [onOpenReport, toggleAgentMode, toggleTranscription, isTranscribing, stopTranscription, isSettingsOpen]);

  // Handle send message
  const handleSend = async () => {
    const content = inputValue.trim();
    if (!content || !currentConversation) return;
    
    // If already loading (agents responding), trigger interruption
    // User can always interrupt - the current typing agent finishes, thinking ones stop
    if (isLoading) {
      shouldCancelDebate.current = true;
      pendingMessage.current = content;
      setInputValue('');
      if (inputRef.current) inputRef.current.style.height = '48px';
      return; // The pending message will be processed after current agent finishes
    }
    
    const activeList = getActiveAgentsList();
    const isDisco = isDiscoConversation();
    if (activeList.length === 0) {
      setError('Enable at least one agent');
      return;
    }
    
    // Reset cancel flag for new message
    shouldCancelDebate.current = false;
    pendingMessage.current = null;
    
    // Clear input and reset debate mode
    setInputValue('');
    if (inputRef.current) inputRef.current.style.height = '48px';
    setDebateMode(null);
    
    // Add user message
    const userMessage: Message = {
      id: uuidv4(),
      conversationId: currentConversation.id,
      role: 'user',
      content,
      timestamp: new Date(),
    };
    addMessage(userMessage);
    
    setIsLoading(true);
    setError(null);
    setApiConnectionError(null); // Clear any previous connection errors on new attempt
    // Start with Governor routing phase
    setThinkingPhase('routing');
    setThinkingAgent('system'); // Governor is routing
    
    try {
      const result = await sendMessage(currentConversation.id, content, activeList, isDisco);
      
      // Set debate mode if applicable
      if (result.debate_mode) {
        setDebateMode(result.debate_mode as DebateMode);
      }
      
      // Calculate typing time for a message based on agent speed
      const getTypingDuration = (agent: string, contentLength: number): number => {
        // Typing speeds (ms per char) - matches MessageBubble
        const speeds: Record<string, number> = {
          instinct: 20,  // Fast (15-25ms avg)
          logic: 45,     // Slow (35-55ms avg)
          psyche: 32,    // Medium (25-40ms avg)
        };
        const msPerChar = speeds[agent] || 30;
        return contentLength * msPerChar + 500; // Add 500ms buffer
      };

      // Show each responding agent - wait for previous to finish typing
      for (let i = 0; i < result.responses.length; i++) {
        // Check for user interruption before processing next response
        if (shouldCancelDebate.current && i > 0) {
          console.log('[INTERRUPT] User interrupted debate after', i, 'responses');
          break;
        }
        
        const response = result.responses[i];
        
        // Show this agent thinking
        setThinkingAgent(response.agent as AgentType);
        setThinkingPhase('thinking');
        await new Promise(r => setTimeout(r, 800)); // Brief thinking animation
        
        // Clear thinking indicator before message appears
        setThinkingAgent(null);
        
        const agentMessage: Message = {
          id: uuidv4(),
          conversationId: currentConversation.id,
          role: response.agent as AgentType,
          content: response.content,
          responseType: response.response_type as Message['responseType'],
          referencesMessageId: response.references_message_id || undefined,
          timestamp: new Date(),
          isDisco, // Conversation-level disco mode
        };
        addMessage(agentMessage);
        
        // If there's another response after this, wait for typing to complete
        if (i < result.responses.length - 1) {
          const typingTime = getTypingDuration(response.agent, response.content.length);
          await new Promise(r => setTimeout(r, typingTime));
          
          // Check again after typing completes
          if (shouldCancelDebate.current) {
            console.log('[INTERRUPT] User interrupted after agent finished typing');
            break;
          }
        }
      }
      
      // Show weight change notification from Governor as toast
      if (result.weight_change) {
        setGovernorNotification({ message: result.weight_change.message });
      }
      
      // Refresh user profile to update weights and message count in UI
      try {
        const updatedProfile = await getUserProfile();
        setUserProfile(updatedProfile);
      } catch (profileErr) {
        console.error('Failed to refresh profile:', profileErr);
      }
    } catch (err) {
      const rawError = err instanceof Error ? err.message : String(err);
      
      // Parse and format friendly error message
      let friendlyMessage = rawError;
      
      if (rawError.includes('insufficient_quota') || rawError.includes('exceeded your current quota')) {
        friendlyMessage = "⚠️ Billing Issue: Your OpenAI account has run out of credits. Visit platform.openai.com/account/billing to add funds, or update your API key in Profile.";
      } else if (rawError.includes('429') || rawError.includes('Too Many Requests') || rawError.includes('rate_limit')) {
        friendlyMessage = "⏳ Rate Limited: OpenAI is temporarily limiting requests. Wait 30 seconds and try again.";
      } else if (rawError.includes('401') || rawError.includes('invalid_api_key') || rawError.includes('Incorrect API key')) {
        friendlyMessage = "🔑 Invalid Key: Your API key was rejected by OpenAI. Check that it's correct in Profile, or generate a new one at platform.openai.com/api-keys.";
      } else if (rawError.includes('timeout') || rawError.includes('ETIMEDOUT')) {
        friendlyMessage = "⏱️ Timeout: The request took too long. OpenAI might be experiencing high load. Try again.";
      } else if (rawError.includes('network') || rawError.includes('fetch') || rawError.includes('Failed to fetch')) {
        friendlyMessage = "🌐 Connection Failed: Unable to reach OpenAI. Check your internet connection.";
      } else if (rawError.includes('model_not_found') || rawError.includes('does not exist')) {
        friendlyMessage = "🤖 Model Error: The AI model is unavailable. This may be a temporary issue.";
      }
      
      setError(friendlyMessage);
      setApiConnectionError(friendlyMessage);
      
      // Add error message from Governor (system)
      addMessage({
        id: uuidv4(),
        conversationId: currentConversation.id,
        role: 'system',
        content: friendlyMessage,
        timestamp: new Date(),
      });
    } finally {
      setIsLoading(false);
      setThinkingAgent(null);
      
      // Process any pending message from user interruption
      const queuedContent = pendingMessage.current;
      if (queuedContent) {
        pendingMessage.current = null;
        shouldCancelDebate.current = false;
        
        // Schedule the pending message to be processed after state updates
        setTimeout(() => {
          processQueuedMessage(queuedContent);
        }, 100);
      }
    }
  };
  
  // Process a queued message (from user interruption)
  const processQueuedMessage = async (content: string) => {
    if (!currentConversation) return;
    
    const activeList = getActiveAgentsList();
    const isDisco = isDiscoConversation();
    if (activeList.length === 0) return;
    
    // Reset cancel flag
    shouldCancelDebate.current = false;
    pendingMessage.current = null;
    setDebateMode(null);
    
    // Add user message
    const userMessage: Message = {
      id: uuidv4(),
      conversationId: currentConversation.id,
      role: 'user',
      content,
      timestamp: new Date(),
    };
    addMessage(userMessage);
    
    setIsLoading(true);
    setError(null);
    setThinkingPhase('routing');
    setThinkingAgent('system');
    
    try {
      const result = await sendMessage(currentConversation.id, content, activeList, isDisco);
      
      if (result.debate_mode) {
        setDebateMode(result.debate_mode as DebateMode);
      }
      
      const getTypingDuration = (agent: string, contentLength: number): number => {
        const speeds: Record<string, number> = {
          instinct: 20,
          logic: 45,
          psyche: 32,
        };
        const msPerChar = speeds[agent] || 30;
        return contentLength * msPerChar + 500;
      };
      
      for (let i = 0; i < result.responses.length; i++) {
        if (shouldCancelDebate.current && i > 0) break;
        
        const response = result.responses[i];
        setThinkingAgent(response.agent as AgentType);
        setThinkingPhase('thinking');
        await new Promise(r => setTimeout(r, 800));
        setThinkingAgent(null);
        
        const agentMessage: Message = {
          id: uuidv4(),
          conversationId: currentConversation.id,
          role: response.agent as AgentType,
          content: response.content,
          responseType: response.response_type as Message['responseType'],
          referencesMessageId: response.references_message_id || undefined,
          timestamp: new Date(),
          isDisco, // Conversation-level disco mode
        };
        addMessage(agentMessage);
        
        if (i < result.responses.length - 1) {
          const typingTime = getTypingDuration(response.agent, response.content.length);
          await new Promise(r => setTimeout(r, typingTime));
          if (shouldCancelDebate.current) break;
        }
      }
      
      if (result.weight_change) {
        setGovernorNotification({ message: result.weight_change.message });
      }

      try {
        const updatedProfile = await getUserProfile();
        setUserProfile(updatedProfile);
      } catch (profileErr) {
        console.error('Failed to refresh profile:', profileErr);
      }
    } catch (err) {
      const rawError = err instanceof Error ? err.message : String(err);
      setError(rawError);
    } finally {
      setIsLoading(false);
      setThinkingAgent(null);
      
      // Handle nested interruption
      const nextQueued = pendingMessage.current;
      if (nextQueued) {
        pendingMessage.current = null;
        shouldCancelDebate.current = false;
        setTimeout(() => processQueuedMessage(nextQueued), 100);
      }
    }
  };

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Handle new conversation - isDisco determines if it's a disco or normal conversation
  const handleNewConversation = async (isDisco: boolean = false) => {
    // Prevent useEffect from also trying to init (race condition fix)
    hasInitialized.current = true;
    
    // Finalize the previous conversation before starting a new one
    if (currentConversation && messages.length > 1) {
      setGovernorNotification({ message: "Sorting this conversation into long-term memory..." });
      // Fire and forget - don't block the UI
      finalizeConversation(currentConversation.id).catch(err => 
        console.error('Failed to finalize conversation:', err)
      );
    }
    
    clearMessages();
    setCurrentConversation(null);
    setDebateMode(null);
    
    try {
      const conv = await createConversation(isDisco);
      setCurrentConversation(conv);
      
      // Dominant agent is greeting the user
      setIsLoading(true);
      setThinkingPhase('thinking');
      setThinkingAgent(dominantAgent); // Dominant agent thinking
      
      // Get dominant agent greeting
      const openerResult = await getConversationOpener();
      
      const openerMessage: Message = {
        id: uuidv4(),
        conversationId: conv.id,
        role: openerResult.agent as Message['role'], // Dominant agent greeting
        content: openerResult.content,
        responseType: 'primary',
        isDisco, // Mark message as disco if conversation is disco
        timestamp: new Date(),
      };
      addMessage(openerMessage);
      setIsLoading(false);
      setThinkingAgent(null);
    } catch (err) {
      console.error('Failed to create new conversation:', err);
      setIsLoading(false);
      setThinkingAgent(null);
    }
  };

  // Subtle linear gradient based on inverted weights (like star chart)
  const getBackgroundStyle = () => {
    if (!userProfile) {
      return { background: 'var(--color-void)' };
    }
    
    const logicInv = 1 - userProfile.logicWeight;
    const psycheInv = 1 - userProfile.psycheWeight;
    const instinctInv = 1 - userProfile.instinctWeight;
    const total = logicInv + psycheInv + instinctInv;
    
    // Very subtle opacity for background
    const l = (logicInv / total) * 0.06;
    const p = (psycheInv / total) * 0.06;
    const i = (instinctInv / total) * 0.06;
    
    return {
      background: `linear-gradient(135deg, 
        rgba(0, 212, 255, ${l.toFixed(3)}) 0%,
        rgba(224, 64, 251, ${p.toFixed(3)}) 50%,
        rgba(239, 68, 68, ${i.toFixed(3)}) 100%
      ), var(--color-void)`,
    };
  };

  return (
    <div 
      className={`flex flex-col h-full ${debateMode ? (debateMode === 'intense' ? 'debate-intense' : 'debate-mild') : ''}`}
      style={getBackgroundStyle()}
    >
      
      {/* Governor notification toast */}
      <GovernorNotification
        message={governorNotification?.message || ''}
        isVisible={!!governorNotification}
        onDismiss={() => setGovernorNotification(null)}
        actionLabel={governorNotification?.actionLabel}
        onAction={governorNotification?.onAction}
      />
      
      {/* Header - Clean, centered logo with space for macOS window controls */}
      <header 
        className="flex items-center justify-between px-4 py-2 border-b border-smoke/30 bg-obsidian/80 backdrop-blur-md cursor-default"
        onMouseDown={async (e) => {
          const isButton = (e.target as HTMLElement).closest('button');
          if (isButton) return;
          try {
            await getCurrentWindow().startDragging();
          } catch (err) {
            // Dragging failed - ignore
          }
        }}
      >
        {/* Left controls - Window buttons + New Chat + Agents */}
        <div className="flex items-center gap-4 relative z-20">
          {/* Custom window controls - always visible */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleWindowClose}
              className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-400 transition-colors cursor-pointer flex items-center justify-center group"
              title="Close"
            >
              <X className="w-2 h-2 text-red-900 opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={3} />
            </button>
            <button
              onClick={async () => { await getCurrentWindow().minimize(); }}
              className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-400 transition-colors cursor-pointer flex items-center justify-center group"
              title="Minimize"
            >
              <Minus className="w-2 h-2 text-yellow-900 opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={3} />
            </button>
            <button
              onClick={async () => { 
                const win = getCurrentWindow();
                await win.setFullscreen(!(await win.isFullscreen())); 
              }}
              className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-400 transition-colors cursor-pointer flex items-center justify-center group"
              title="Fullscreen"
            >
              <Square className="w-1.5 h-1.5 text-green-900 opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={3} />
            </button>
          </div>

          {/* New conversation buttons - in a pill container */}
          <div className="flex items-center bg-charcoal/60 rounded-full px-1.5 py-1 border border-smoke/30">
            {/* Normal conversation */}
            <button
              onClick={() => handleNewConversation(false)}
              className={`flex items-center gap-1 px-2 py-1 rounded-full transition-all cursor-pointer ${
                !isDiscoConversation()
                  ? 'text-pearl bg-smoke/30'
                  : 'text-ash/60 hover:text-ash hover:bg-smoke/20'
              }`}
              title="New conversation (⌘N)"
            >
              <MessageSquare className="w-4 h-4" strokeWidth={1.5} />
              <kbd className="text-[8px] font-mono text-ash/40">⌘N</kbd>
            </button>
            
            {/* Disco conversation */}
            <div className="relative group/disco z-10 hover:z-[200]">
              <button
                onClick={() => handleNewConversation(true)}
                className={`flex items-center gap-1 px-2 py-1 rounded-full transition-all cursor-pointer ${
                  isDiscoConversation()
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'text-ash/60 hover:text-ash hover:bg-smoke/20'
                }`}
                title="New Disco conversation (⌘D)"
              >
                <BotMessageSquare className="w-4 h-4" strokeWidth={1.5} />
                <kbd className="text-[8px] font-mono text-ash/40">⌘D</kbd>
              </button>
              
              {/* Disco Mode tooltip - appears below */}
              <div className="absolute top-full left-1/2 -translate-x-1/2 pt-2 opacity-0 invisible group-hover/disco:opacity-100 group-hover/disco:visible transition-all z-[200] pointer-events-none group-hover/disco:pointer-events-auto">
                <div className="w-[220px] px-3 py-2.5 bg-obsidian border border-amber-500/40 rounded-lg shadow-xl">
                  <h4 className="text-xs font-sans font-medium text-amber-400 mb-1">Disco Mode</h4>
                  <p className="text-[10px] text-ash/70 font-mono leading-relaxed">
                    Agents become intense, opinionated, and challenging. Use when you want to be pushed, not helped.
                  </p>
                  <a 
                    href="https://discoelysium.com" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 mt-2 pt-2 border-t border-smoke/30 text-[9px] text-ash/50 hover:text-amber-400 transition-colors font-mono"
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                    </svg>
                    Inspired by Disco Elysium
                  </a>
                </div>
              </div>
            </div>
          </div>
          
          {/* Agent toggles - in a pill container */}
          <div className="flex items-center gap-1.5 bg-charcoal/60 rounded-full px-2 py-1.5 border border-smoke/30">
            {AGENT_ORDER.map((agentId, index) => {
              // Use disco agents config if in disco conversation
              const isDisco = isDiscoConversation();
              const agentConfig = isDisco ? DISCO_AGENTS[agentId] : AGENTS[agentId];
              const mode = agentModes[agentId];
              const isActive = mode !== 'off';
              const hotkeyNum = index + 1;
              
              return (
                <div key={agentId} className="relative group/agent flex items-center gap-1">
                  <motion.button
                    onClick={() => toggleAgentMode(agentId)}
                    className={`relative w-5 h-5 rounded-full overflow-visible transition-all ${
                      isActive 
                        ? 'opacity-100' 
                        : 'opacity-40 grayscale hover:opacity-60'
                    } cursor-pointer`}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    title={`Toggle ${agentConfig.name} (⌘${hotkeyNum})`}
                  >
                    <div className="w-full h-full rounded-full overflow-hidden">
                      <img 
                        src={agentConfig.avatar} 
                        alt={agentConfig.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    {/* Active indicator dot - bottom right, overlapping */}
                    {isActive && (
                      <motion.div
                        className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-charcoal z-10"
                        style={{ backgroundColor: isDisco ? '#EAB308' : '#22C55E' }}
                        animate={{ opacity: [0.7, 1, 0.7] }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                      />
                    )}
                  </motion.button>
                  <kbd className="text-[8px] font-mono text-ash/40">⌘{hotkeyNum}</kbd>
                  
                  {/* Hover tooltip */}
                  <div 
                    className="absolute top-full mt-2 left-1/2 -translate-x-1/2 px-3 py-2 bg-obsidian/95 border rounded-lg opacity-0 invisible group-hover/agent:opacity-100 group-hover/agent:visible transition-all shadow-xl w-[200px] z-50 pointer-events-none"
                    style={{ borderColor: `${agentConfig.color}40` }}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span 
                        className="text-xs font-sans font-medium"
                        style={{ color: agentConfig.color }}
                      >
                        {agentConfig.name}
                      </span>
                      <span className="text-[9px] text-ash/50 font-mono uppercase">{agentId}</span>
                      <span 
                        className={`text-[8px] px-1.5 py-0.5 rounded-full font-mono uppercase ${
                          isActive 
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-smoke/30 text-ash/50'
                        }`}
                      >
                        {isActive ? 'On' : 'Off'}
                      </span>
                    </div>
                    <p className="text-[10px] text-ash/80 font-mono leading-relaxed">
                      {agentConfig.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          
        </div>
        
        {/* Centered logo */}
        <div 
          className="flex items-center gap-2 select-none"
          data-tauri-drag-region
        >
          <h1 className="font-logo text-base font-bold tracking-wide leading-none pointer-events-none text-white">
            Intersect
          </h1>
          <span className="px-1 py-0.5 bg-smoke/40 border border-smoke/50 rounded text-[10px] font-mono text-ash/70 pointer-events-none leading-none">v0</span>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-3 justify-end relative z-10">
          {/* Profile Switcher - opens profile modal */}
          <ProfileSwitcher onOpenProfileModal={onOpenSettings} />
          
          {/* Governor - opens report modal */}
          <button
            onClick={onOpenReport}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-smoke/20 transition-all cursor-pointer group/governor"
            title="The Governor (⌘G)"
          >
            {/* Governor icon - round with flashing yellow border when routing */}
            <div className="relative w-6 h-6">
              {/* Animated border ring - only this pulses */}
              {activeCount > 1 && (
                <div 
                  className="absolute inset-[-2px] rounded-full"
                  style={{ 
                    border: '1.5px solid #EAB308',
                    animation: 'border-pulse 2s ease-in-out infinite',
                  }}
                />
              )}
              {/* Static border when not routing */}
              {activeCount <= 1 && (
                <div 
                  className="absolute inset-[-2px] rounded-full border border-ash/30"
                />
              )}
              {/* Icon container */}
              <div className="w-6 h-6 rounded-full overflow-hidden">
                <img src={governorIcon} alt="Governor" className="w-full h-full object-cover" />
              </div>
            </div>
            <kbd className="p-1 bg-smoke/30 rounded text-[10px] font-mono text-ash/60 border border-smoke/40 leading-none aspect-square flex items-center justify-center">⌘G</kbd>
          </button>
          
        </div>
      </header>

      {/* Messages */}
      <div 
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto pl-4 pr-6 py-4 pb-24"
      >
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-ash text-sm font-mono flex items-center gap-1">
              Waiting for connection
              <span className="inline-flex">
                <span className="animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: '150ms', animationDuration: '1s' }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: '300ms', animationDuration: '1s' }}>.</span>
              </span>
            </p>
          </div>
        )}

        {messages.map((message, index) => (
          <MessageBubble
            key={message.id}
            message={message}
            isLatest={index === messages.length - 1}
          />
        ))}

        {/* Thinking indicator */}
        <AnimatePresence>
          {isLoading && (
            <ThinkingIndicator agent={thinkingAgent} phase={thinkingPhase} isDisco={isDiscoConversation()} />
          )}
        </AnimatePresence>

        <div ref={messagesEndRef} />
      </div>

      {/* Floating Input */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 w-3/4 max-w-5xl">
        <div className="flex items-center gap-3">
          {/* Input container with transcript overlay above */}
          <div className="flex-1 relative">
            {/* Transcription overlay - shows partial transcript while speaking */}
            <AnimatePresence>
              {isTranscribing && partialTranscript && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute bottom-full mb-2 left-0 right-0 px-4 py-2.5 bg-charcoal/80 backdrop-blur-xl border rounded-2xl shadow-2xl"
                  style={{ borderColor: 'rgba(234, 179, 8, 0.3)' }}
                >
                  <div className="flex items-start gap-2">
                    <motion.div
                      className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
                      style={{ backgroundColor: '#EAB308' }}
                      animate={{ opacity: [0.5, 1, 0.5] }}
                      transition={{ duration: 1, repeat: Infinity }}
                    />
                    <span className="text-sm font-mono italic" style={{ color: 'rgba(234, 179, 8, 0.8)' }}>{partialTranscript}</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            
            {/* Floating chat input */}
            <div className={`bg-charcoal/80 backdrop-blur-xl rounded-2xl border transition-all relative flex items-center shadow-2xl overflow-hidden ${
              isTranscribing ? 'border-amber-500/50' : 'border-smoke/30'
            }`}>
            {/* User identity indicator on left with pulsing border */}
            <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
              <div className="relative">
                {/* Pulsing ring - amber when transcribing, gold otherwise */}
                <motion.div
                  className="absolute inset-0 rounded-full"
                  style={{ 
                    boxShadow: '0 0 0 2px #EAB308',
                  }}
                  animate={{ 
                    opacity: [0.65, 0.9, 0.65],
                  }}
                  transition={{ 
                    duration: isTranscribing ? 1 : 3,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                />
                <img 
                  src={USER_PROFILES[dominantAgent]} 
                  alt="You"
                  className="w-7 h-7 rounded-full relative z-10"
                />
                {/* Transcription indicator dot - bottom right of avatar */}
                {isTranscribing && (
                  <motion.div
                    className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border border-charcoal z-20"
                    animate={{ opacity: [0.6, 1, 0.6], scale: [0.9, 1.1, 0.9] }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
              </div>
            </div>
            
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                // Auto-expand height based on content (up to 5 lines, then scroll)
                e.target.style.height = 'auto';
                const lineHeight = 22; // line height for text-sm with spacing
                const maxHeight = lineHeight * 5 + 24; // 5 lines + padding
                e.target.style.height = Math.min(e.target.scrollHeight, maxHeight) + 'px';
              }}
              onKeyDown={handleKeyDown}
              placeholder=""
              disabled={false}
              rows={1}
              className="w-full bg-transparent text-pearl font-mono text-sm pl-14 pr-16 py-3 resize-none outline-none border-none overflow-y-auto"
              style={{ boxShadow: 'none', minHeight: '48px', maxHeight: '134px' }}
            />
            {/* Placeholder with styled slash */}
            {!inputValue && !isTranscribing && (
              <div className="absolute left-14 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none">
                <span className="text-ash/40 font-mono text-sm leading-none">Press</span>
                <kbd className="px-1 py-0.5 bg-smoke/30 rounded-md text-ash/60 font-mono text-xs border border-smoke/40 flex items-center justify-center leading-none">/</kbd>
                <span className="text-ash/40 font-mono text-sm leading-none">to chat</span>
              </div>
            )}
            {/* Transcribing placeholder - animated */}
            {!inputValue && isTranscribing && (
              <div className="absolute left-14 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none">
                <span className="font-mono text-sm leading-none" style={{ color: 'rgba(234, 179, 8, 0.6)' }}>Listening</span>
                <span className="flex gap-0.5">
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      className="font-mono text-sm leading-none"
                      style={{ color: 'rgba(234, 179, 8, 0.6)' }}
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 1, repeat: Infinity, delay: i * 0.2, ease: 'easeInOut' }}
                    >
                      .
                    </motion.span>
                  ))}
                </span>
              </div>
            )}
            {/* Enter hint - bottom right corner */}
            <div className="absolute right-3 bottom-2.5 pointer-events-none">
              <kbd className="px-1.5 py-0.5 bg-smoke/30 rounded-md text-ash/50 font-mono text-[10px] border border-smoke/40">↵ ENT</kbd>
            </div>
            </div>
          </div>
          
          {/* Microphone button - voice transcription */}
          <motion.button
            onClick={toggleTranscription}
            className={`flex items-center gap-1.5 px-2 py-2 rounded-lg cursor-pointer ${
              isTranscribing || isConnecting
                ? 'text-amber-400' 
                : 'text-ash/50 hover:text-ash'
            }`}
            animate={isConnecting ? { opacity: [0.6, 1, 0.6] } : { opacity: 1 }}
            transition={isConnecting ? { duration: 1.5, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            title={isTranscribing ? 'Stop transcription (⌘S)' : isConnecting ? 'Connecting...' : 'Start voice transcription (⌘S)'}
          >
            <div className="relative">
              <Mic className="w-5 h-5" strokeWidth={1.5} />
              {/* Amber dot when connected (not during connecting) */}
              {isTranscribing && (
                <div 
                  className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: '#EAB308', animation: 'pulse-opacity 1s ease-in-out infinite' }}
                />
              )}
            </div>
            <kbd className="text-[10px] font-mono text-ash/40">⌘S</kbd>
          </motion.button>
        </div>
        
        {/* Privacy notice */}
        <div className="flex items-center justify-center gap-1.5 mt-2">
          <ShieldCheck className="w-3.5 h-3.5 text-cyan-500/60" strokeWidth={1.5} />
          <span className="text-[11px] text-ash/40 font-mono">
            Your data stays on this device and is never used to train models... probably.
          </span>
        </div>
      </div>
      
      {/* Spirit Animal - absolute bottom right */}
      <a 
        href="https://briggskellogg.com" 
        target="_blank" 
        rel="noopener noreferrer"
        className="absolute bottom-3 right-4 cursor-pointer"
      >
        <img 
          src={spiritAnimal} 
          alt="Spirit Animal" 
          className="h-5 w-auto opacity-40 hover:opacity-100 transition-opacity duration-200"
        />
      </a>
    </div>
  );
}

