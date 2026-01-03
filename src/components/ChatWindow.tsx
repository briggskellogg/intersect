import { useEffect, useRef, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BotMessageSquare, ShieldCheck, X, Minus, Square, Mic, Sparkles, History, ExternalLink } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ThemeToggle } from './ThemeToggle';
import { ThoughtsContainer } from './ThoughtsContainer';
import { ConversationHistory } from './ConversationHistory';
import { useAppStore } from '../store';
import { Message, AgentType, DebateMode } from '../types';
import { AGENTS, DISCO_AGENTS, AGENT_ORDER } from '../constants/agents';
import { 
  sendMessage, 
  createConversation, 
  getConversationOpener,
  getUserProfile,
  finalizeConversation,
  recoverConversations,
  getConversationMessages,
  getRecentConversations,
  getGovernorImage,
  InitResult,
  reopenConversation,
} from '../hooks/useTauri';
import { useScribeTranscription } from '../hooks/useScribeTranscription';
import { v4 as uuidv4 } from 'uuid';
import defaultGovernorIcon from '../assets/governor.png';
import spiritAnimal from '../assets/spirit_animal.png';
import { GovernorNotification } from './GovernorNotification';

interface ChatWindowProps {
  onOpenSettings: () => void;
  recoveryNeeded?: InitResult | null;
  onRecoveryComplete?: () => void;
}

export function ChatWindow({ onOpenSettings, recoveryNeeded, onRecoveryComplete }: ChatWindowProps) {
  const {
    messages,
    addMessage,
    setMessages,
    clearMessages,
    currentConversation,
    setCurrentConversation,
    getActiveAgentsList,
    agentModes,
    toggleAgentMode,
    toggleDiscoMode,
    isDiscoMode,
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
  
  // Count active agents for Governor logic
  const activeCount = Object.values(agentModes).filter(m => m === 'on').length;
  
  const { activePersonaProfile, elevenLabsApiKey, isSettingsOpen } = useAppStore();
  
  const [inputValue, setInputValue] = useState('');
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [governorIcon, setGovernorIcon] = useState<string | null>(null);
  const [governorNotification, setGovernorNotification] = useState<{
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);

  // Load governor icon from desktop when component mounts
  useEffect(() => {
    getGovernorImage().then(image => {
      if (image) {
        setGovernorIcon(image);
      }
    }).catch(err => {
      console.error('Failed to load governor image:', err);
    });
  }, []);
  
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
      
      try {
        // Try to load the most recent conversation
        const recentConvs = await getRecentConversations(1);
        
        if (recentConvs.length > 0) {
          // Load the most recent conversation and reopen it with a greeting
          const conv = recentConvs[0];
          const loadedMessages = await getConversationMessages(conv.id);
          
          setCurrentConversation(conv);
          
          // Convert agent messages to governor_thoughts format for display
          const convertedMessages = loadedMessages.map(msg => {
            if (msg.role === 'instinct' || msg.role === 'logic' || msg.role === 'psyche') {
              const agentType = msg.role as AgentType;
              const agentConfig = conv.isDisco ? DISCO_AGENTS[agentType] : AGENTS[agentType];
              return {
                ...msg,
                role: 'governor_thoughts' as const,
                agentName: agentConfig.name,
                isDisco: conv.isDisco,
              };
            }
            return msg;
          });
          
          setMessages(convertedMessages);
          
          // Get a "welcome back" greeting from Governor
          setIsLoading(true);
          setThinkingPhase('thinking');
          setThinkingAgent('system');
          
          const opener = await reopenConversation(conv.id);
          const openerMessage: Message = {
            id: uuidv4(),
            conversationId: conv.id,
            role: 'governor',
            content: opener.content,
            responseType: 'primary',
            timestamp: new Date(),
          };
          addMessage(openerMessage);
          setIsLoading(false);
          setThinkingAgent(null);
        } else {
          // No previous conversations, create a new one
          const conv = await createConversation(false);
          setCurrentConversation(conv);
          
          // Governor is greeting the user
          setIsLoading(true);
          setThinkingPhase('thinking');
          setThinkingAgent('system'); // Governor thinking
          
          // Get Governor greeting
          const openerResult = await getConversationOpener();
          
          const openerMessage: Message = {
            id: uuidv4(),
            conversationId: conv.id,
            role: 'governor', // Governor greets the user
            content: openerResult.content,
            responseType: 'primary',
            timestamp: new Date(),
          };
          addMessage(openerMessage);
          setIsLoading(false);
          setThinkingAgent(null);
        }
      } catch (err) {
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
  
  // MutationObserver: Keep scrolled to bottom as typewriter effect grows content
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    
    let lastScrollHeight = container.scrollHeight;
    
    const mutationObserver = new MutationObserver(() => {
      // Check if content height changed
      if (container.scrollHeight !== lastScrollHeight) {
        lastScrollHeight = container.scrollHeight;
        // Only auto-scroll if user is at/near the bottom
        if (!userScrolledUp.current) {
          // Use instant scroll for smoother following during typing
          container.scrollTop = container.scrollHeight;
        }
      }
    });
    
    // Observe all DOM changes within the messages container
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    
    return () => mutationObserver.disconnect();
  }, []);

  // Track close handling
  const isClosingRef = useRef(false);
  
  // Handle window close with archiving (silent - no confirmation dialog)
  const handleWindowClose = useCallback(async () => {
    if (isClosingRef.current) return;
    
    const appWindow = getCurrentWindow();
    isClosingRef.current = true;
    
    // Finalize conversation silently in background (fire and forget)
    if (currentConversation && messages.length > 1) {
      finalizeConversation(currentConversation.id).catch(err => {
        console.error('Failed to finalize on close:', err);
      });
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
        try {
          await recoverConversations();
        } catch (err) {
          console.error('Failed to recover conversations:', err);
          // Only show notification for technical errors
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
            handleNewConversation(); // New conversation
            break;
          case 'h':
            e.preventDefault();
            setIsHistoryOpen(prev => !prev); // Toggle conversation history
            break;
          case 'd':
            e.preventDefault();
            toggleDiscoMode(); // Toggle global disco mode
            break;
          case 'p':
            e.preventDefault();
            onOpenSettings(); // Open Profile modal
            break;
          case 'g':
            // Removed - Governor report no longer exists
            break;
          case 's':
            e.preventDefault();
            toggleTranscription(); // Toggle voice transcription
            break;
          case 't':
            e.preventDefault();
            // Toggle theme (system -> light -> dark -> system)
            const currentTheme = useAppStore.getState().theme;
            const nextTheme = currentTheme === 'system' ? 'light' : currentTheme === 'light' ? 'dark' : 'system';
            useAppStore.getState().setTheme(nextTheme);
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
      
      // Escape key - close history drawer if open
      if (e.key === 'Escape' && isHistoryOpen) {
        e.preventDefault();
        setIsHistoryOpen(false);
      }
    };
    
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [toggleAgentMode, toggleTranscription, isTranscribing, stopTranscription, isSettingsOpen, onOpenSettings]);

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
    // In global disco mode, all active agents are in disco
    const discoList = isDiscoMode ? activeList : [];
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
    // Start with Governor thinking phase
    setThinkingPhase('thinking');
    setThinkingAgent('system'); // Governor is thinking
    
    try {
      const result = await sendMessage(currentConversation.id, content, activeList, discoList);
      
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

      // Show each agent response as Governor's internal thoughts
      for (let i = 0; i < result.responses.length; i++) {
        // Check for user interruption before processing next response
        if (shouldCancelDebate.current && i > 0) {
          console.log('[INTERRUPT] User interrupted debate after', i, 'responses');
          break;
        }
        
        const response = result.responses[i];
        
        // Show this agent thinking (as Governor's internal process)
        setThinkingAgent('system'); // Show Governor thinking
        setThinkingPhase('thinking');
        await new Promise(r => setTimeout(r, 800)); // Brief thinking animation
        
        // Clear thinking indicator before message appears
        setThinkingAgent(null);
        
        // Display agent response as Governor's thought with agent name
        const agentConfig = isDiscoMode ? DISCO_AGENTS : AGENTS;
        const agentInfo = agentConfig[response.agent as AgentType];
        const governorThoughtMessage: Message = {
          id: uuidv4(),
          conversationId: currentConversation.id,
          role: 'governor_thoughts',
          content: response.content,
          responseType: response.response_type as Message['responseType'],
          referencesMessageId: response.references_message_id || undefined,
          timestamp: new Date(),
          agentName: agentInfo?.name || response.agent,
          isDisco: isDiscoMode,
        };
        addMessage(governorThoughtMessage);
        
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
      
      // After all agent thoughts are shown, display Governor's synthesized response
      if (result.governor_response) {
        // Brief pause to transition from thoughts to response
        setThinkingAgent('system');
        setThinkingPhase('thinking');
        await new Promise(r => setTimeout(r, 1000));
        
        setThinkingAgent(null);
        
        const governorResponseMessage: Message = {
          id: uuidv4(),
          conversationId: currentConversation.id,
          role: 'governor',
          content: result.governor_response,
          timestamp: new Date(),
        };
        addMessage(governorResponseMessage);
      }
      
      // Weight change notifications removed - only show technical errors
      
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
    // In global disco mode, all active agents are in disco
    const discoList = isDiscoMode ? activeList : [];
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
    setThinkingPhase('thinking');
    setThinkingAgent('system');
    
    try {
      const result = await sendMessage(currentConversation.id, content, activeList, discoList);
      
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
      
      // Show each agent response as Governor's internal thoughts
      for (let i = 0; i < result.responses.length; i++) {
        if (shouldCancelDebate.current && i > 0) break;
        
        const response = result.responses[i];
        
        // Show this agent thinking (as Governor's internal process)
        setThinkingAgent('system'); // Show Governor thinking
        setThinkingPhase('thinking');
        await new Promise(r => setTimeout(r, 800)); // Brief thinking animation
        
        // Clear thinking indicator before message appears
        setThinkingAgent(null);
        
        // Display agent response as Governor's thought with agent name
        const agentConfig = isDiscoMode ? DISCO_AGENTS : AGENTS;
        const agentInfo = agentConfig[response.agent as AgentType];
        const governorThoughtMessage: Message = {
          id: uuidv4(),
          conversationId: currentConversation.id,
          role: 'governor_thoughts',
          content: response.content,
          responseType: response.response_type as Message['responseType'],
          referencesMessageId: response.references_message_id || undefined,
          timestamp: new Date(),
          agentName: agentInfo?.name || response.agent,
          isDisco: isDiscoMode,
        };
        addMessage(governorThoughtMessage);
        
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
      
      // After all agent thoughts are shown, display Governor's synthesized response
      if (result.governor_response) {
        // Brief pause to transition from thoughts to response
        setThinkingAgent('system');
        setThinkingPhase('thinking');
        await new Promise(r => setTimeout(r, 1000));
        
        setThinkingAgent(null);
        
        const governorResponseMessage: Message = {
          id: uuidv4(),
          conversationId: currentConversation.id,
          role: 'governor',
          content: result.governor_response,
          timestamp: new Date(),
        };
        addMessage(governorResponseMessage);
      }
      
      // Weight change notifications removed - only show technical errors

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
  // Handle new conversation - disco mode is now per-agent, not per-conversation
  const handleNewConversation = async () => {
    // Prevent useEffect from also trying to init (race condition fix)
    hasInitialized.current = true;
    
    // Finalize the previous conversation before starting a new one
    if (currentConversation && messages.length > 1) {
      // Fire and forget - don't block the UI
      finalizeConversation(currentConversation.id).catch(err => 
        console.error('Failed to finalize conversation:', err)
      );
    }
    
    setIsLoading(true);
    clearMessages();
    setCurrentConversation(null);
    setDebateMode(null);
    
    try {
      // Always create normal conversation - disco is per-agent now
      const conv = await createConversation(false);
      setCurrentConversation(conv);
      
      // Governor is greeting the user
      setThinkingPhase('thinking');
      setThinkingAgent('system'); // Governor thinking
      
      // Get Governor greeting
      const openerResult = await getConversationOpener();
      
      const openerMessage: Message = {
        id: uuidv4(),
        conversationId: conv.id,
        role: 'governor', // Governor greets the user
        content: openerResult.content,
        responseType: 'primary',
        timestamp: new Date(),
      };
      addMessage(openerMessage);
      setIsLoading(false);
      setThinkingAgent(null);
    } catch (err) {
      console.error('Failed to create new conversation:', err);
      setError(err instanceof Error ? err.message : 'Failed to create new conversation');
      setIsLoading(false);
      setThinkingAgent(null);
      hasInitialized.current = false; // Allow retry on error
    }
  };

  // Handle loading a conversation from history (always reopens with new greeting)
  const handleLoadConversation = async (conversationId: string) => {
    // Finalize the previous conversation before loading a new one
    if (currentConversation && messages.length > 1) {
      finalizeConversation(currentConversation.id).catch(err => 
        console.error('Failed to finalize conversation:', err)
      );
    }
    
    setIsLoading(true);
    clearMessages();
    setDebateMode(null);
    setThinkingPhase('thinking');
    setThinkingAgent('system'); // Governor thinking
    
    try {
      // Load conversation messages
      const loadedMessages = await getConversationMessages(conversationId);
      
      // Find the conversation info
      const convs = await getRecentConversations(100);
      const conv = convs.find(c => c.id === conversationId);
      
      if (conv) {
        setCurrentConversation(conv);
        
        // Convert agent messages to governor_thoughts format for display
        const convertedMessages = loadedMessages.map(msg => {
          // If message role is an agent type, convert to governor_thoughts
          if (msg.role === 'instinct' || msg.role === 'logic' || msg.role === 'psyche') {
            const agentType = msg.role as AgentType;
            const agentConfig = conv.isDisco ? DISCO_AGENTS[agentType] : AGENTS[agentType];
            return {
              ...msg,
              role: 'governor_thoughts' as const,
              agentName: agentConfig.name,
              isDisco: conv.isDisco,
            };
          }
          return msg;
        });
        
        setMessages(convertedMessages);
        
        // Always reopen with a new Governor greeting
        const opener = await reopenConversation(conversationId);
        const openerMessage: Message = {
          id: uuidv4(),
          conversationId: conv.id,
          role: 'governor',
          content: opener.content,
          responseType: 'primary',
          timestamp: new Date(),
        };
        addMessage(openerMessage);
      } else {
        // If conversation not found, create a new one
        const newConv = await createConversation(false);
        setCurrentConversation(newConv);
      }
    } catch (err) {
      console.error('Failed to load conversation:', err);
      setError('Failed to load conversation');
    } finally {
      setIsLoading(false);
      setThinkingAgent(null);
    }
  };

  // Handle reopening a conversation (with Governor greeting) - no animations
  const handleReopenConversation = async (conversationId: string) => {
    // Finalize the previous conversation before reopening
    if (currentConversation && messages.length > 1) {
      finalizeConversation(currentConversation.id).catch(err => 
        console.error('Failed to finalize conversation:', err)
      );
    }
    
    clearMessages();
    setDebateMode(null);
    
    try {
      // Load conversation messages
      const loadedMessages = await getConversationMessages(conversationId);
      
      // Find the conversation info
      const convs = await getRecentConversations(100);
      const conv = convs.find(c => c.id === conversationId);
      
      if (conv) {
        setCurrentConversation(conv);
        
        // Convert agent messages to governor_thoughts format for display
        const convertedMessages = loadedMessages.map(msg => {
          if (msg.role === 'instinct' || msg.role === 'logic' || msg.role === 'psyche') {
            const agentType = msg.role as AgentType;
            const agentConfig = conv.isDisco ? DISCO_AGENTS[agentType] : AGENTS[agentType];
            return {
              ...msg,
              role: 'governor_thoughts' as const,
              agentName: agentConfig.name,
              isDisco: conv.isDisco,
            };
          }
          return msg;
        });
        
        setMessages(convertedMessages);
        
        // Get the Governor's reopening greeting
        const opener = await reopenConversation(conversationId);
        
        // Add the Governor's reopening greeting (no animation)
        const openerMessage: Message = {
          id: uuidv4(),
          conversationId: conv.id,
          role: 'governor',
          content: opener.content,
          responseType: 'primary',
          timestamp: new Date(),
        };
        addMessage(openerMessage);
      } else {
        // If conversation not found, create a new one
        const newConv = await createConversation(false);
        setCurrentConversation(newConv);
      }
    } catch (err) {
      console.error('Failed to reopen conversation:', err);
      setError('Failed to reopen conversation');
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
        className="relative flex items-center justify-between px-4 py-2 border-b border-smoke/30 bg-obsidian/80 backdrop-blur-md cursor-default"
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
        <div className="flex items-center gap-2 relative z-20">
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

          {/* Conversation history button */}
          <button
            onClick={() => setIsHistoryOpen(true)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-ash/60 hover:text-pearl hover:bg-smoke/20 transition-all cursor-pointer"
            title="Conversation history (⌘H)"
          >
            <History className="w-4 h-4" strokeWidth={1.5} />
            <kbd className="text-[8px] font-mono text-ash/40">⌘H</kbd>
          </button>
          
          {/* New conversation button */}
          <button
            onClick={() => handleNewConversation()}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-ash/60 hover:text-pearl hover:bg-smoke/20 transition-all cursor-pointer"
            title="New conversation (⌘N)"
          >
            <BotMessageSquare className="w-4 h-4" strokeWidth={1.5} />
            <kbd className="text-[8px] font-mono text-ash/40">⌘N</kbd>
          </button>
          
          {/* Agent toggles - in a pill container (simple on/off) */}
          <div className="flex items-center gap-1.5 bg-charcoal/60 rounded-full px-2 py-1.5 border border-smoke/30">
            {AGENT_ORDER.map((agentId, index) => {
              // Use disco agents config if global disco mode is on
              const agentConfig = isDiscoMode ? DISCO_AGENTS[agentId] : AGENTS[agentId];
              const isActive = agentModes[agentId] === 'on';
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
                    title={`Toggle ${agentConfig.name}: ${isActive ? 'On' : 'Off'} (⌘${hotkeyNum})`}
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
                        style={{ backgroundColor: '#22C55E' }}
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
        
        {/* Absolutely centered logo */}
        <div 
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 select-none pointer-events-none"
          data-tauri-drag-region
        >
          <h1 className="font-logo text-base font-bold tracking-wide leading-none text-pearl">
            Intersect
          </h1>
          <span className="px-1 py-0.5 bg-smoke/40 border border-smoke/50 rounded text-[10px] font-mono text-ash/70 leading-none">v1</span>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-[4px] justify-end relative z-10">
          {/* Disco mode toggle - next to governor */}
          <div className="relative group/disco">
            <motion.button
              onClick={() => toggleDiscoMode()}
              className={`flex items-center gap-1 px-2 py-1 rounded-full transition-all cursor-pointer ${
                isDiscoMode
                  ? 'bg-gradient-to-r from-amber-500/25 to-orange-500/25 border border-amber-400/70 text-amber-300 hover:from-amber-500/35 hover:to-orange-500/35'
                  : 'bg-smoke/20 border border-smoke/40 text-ash/60 hover:bg-smoke/30 hover:text-ash'
              }`}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              animate={isDiscoMode ? { 
                boxShadow: ['0 0 0px rgba(234, 179, 8, 0)', '0 0 10px rgba(234, 179, 8, 0.4)', '0 0 0px rgba(234, 179, 8, 0)']
              } : undefined}
              transition={isDiscoMode ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : undefined}
            >
              <Sparkles className={`w-3 h-3 ${isDiscoMode ? 'animate-pulse' : ''}`} strokeWidth={2} />
              <span className="text-[9px] font-mono font-medium tracking-wide">DISCO</span>
              <kbd className={`px-1 py-0.5 rounded text-[8px] font-mono leading-none border ${
                isDiscoMode
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-300'
                  : 'bg-smoke/30 border-smoke/40 text-ash/60'
              }`}>⌘D</kbd>
            </motion.button>
            
            {/* Hover tooltip */}
            <div 
              className="absolute top-full mt-2 right-0 px-3 py-2 bg-obsidian/95 border rounded-lg opacity-0 invisible group-hover/disco:opacity-100 group-hover/disco:visible transition-all shadow-xl w-[260px] z-50 pointer-events-auto"
              style={{ borderColor: 'rgba(234, 179, 8, 0.4)' }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <Sparkles className="w-3 h-3 text-amber-400" strokeWidth={2} />
                <span className="text-xs font-sans font-medium text-amber-300">DISCO MODE</span>
                <kbd className="px-1.5 py-0.5 bg-smoke/30 rounded border border-smoke/40 text-[8px] font-mono text-ash/60">⌘D</kbd>
              </div>
              <p className="text-[10px] text-ash/80 font-mono leading-relaxed mb-1.5">
                In <strong>Normal Mode</strong>, agents are helpful and supportive. In <strong>Disco Mode</strong>, all agents become challenging and push back. They'll question your assumptions, call out blind spots, and engage in spirited debate.
              </p>
              <a
                href="https://www.discoelysium.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[9px] text-amber-400/80 hover:text-amber-300 font-mono italic transition-colors cursor-pointer"
              >
                <span>Inspired by Disco Elysium</span>
                <ExternalLink className="w-2.5 h-2.5" strokeWidth={1.5} />
              </a>
            </div>
          </div>
          
          {/* Governor - opens settings */}
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-smoke/20 transition-all cursor-pointer group/governor"
            title="Settings (⌘P)"
          >
            {/* Governor icon */}
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
              {/* Icon container - use disco icon if in disco mode */}
              <div className="w-6 h-6 rounded-full overflow-hidden">
                <img 
                  src={governorIcon || defaultGovernorIcon} 
                  alt="Governor" 
                  className="w-full h-full object-cover" 
                />
              </div>
            </div>
            <kbd className="p-1 bg-smoke/30 rounded text-[10px] font-mono text-ash/60 border border-smoke/40 leading-none aspect-square flex items-center justify-center">⌘P</kbd>
          </button>
          
          {/* Theme toggle */}
          <ThemeToggle />
          
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

        {messages.map((message, index) => {
          // Group consecutive governor_thoughts messages
          const isThought = message.role === 'governor_thoughts';
          const prevMessage = index > 0 ? messages[index - 1] : null;
          const isFirstThought = isThought && (prevMessage?.role !== 'governor_thoughts');
          
          // Collect all thoughts in this group
          if (isFirstThought) {
            const thoughtGroup: Message[] = [];
            for (let i = index; i < messages.length; i++) {
              if (messages[i].role === 'governor_thoughts') {
                thoughtGroup.push(messages[i]);
              } else {
                break;
              }
            }
            
            return (
              <ThoughtsContainer key={`thoughts-${message.id}`} thoughts={thoughtGroup} />
            );
          }
          
          // Skip other thoughts in the group (they're rendered in ThoughtsContainer)
          if (isThought && !isFirstThought) {
            return null;
          }
          
          // Render normal messages
          return (
            <MessageBubble
              key={message.id}
              message={message}
              isLatest={index === messages.length - 1}
              governorIcon={governorIcon}
              isDiscoMode={isDiscoMode}
            />
          );
        })}

        {/* Thinking indicator */}
        <AnimatePresence>
          {isLoading && (
            <ThinkingIndicator agent={thinkingAgent} phase={thinkingPhase} isDisco={isDiscoMode} />
          )}
        </AnimatePresence>

        <div ref={messagesEndRef} />
      </div>

      {/* Conversation History Drawer */}
      <ConversationHistory
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        currentConversationId={currentConversation?.id || null}
        onSelectConversation={handleLoadConversation}
        onReopenConversation={handleReopenConversation}
      />

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
                  src={governorIcon || defaultGovernorIcon} 
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
