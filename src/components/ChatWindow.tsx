import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MessageSquarePlus, BadgeCheck } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { DebateIndicator } from './DebateIndicator';
import { ThinkingIndicator } from './ThinkingIndicator';
import { useAppStore } from '../store';
import { Message, AgentType, DebateMode } from '../types';
import { AGENTS, AGENT_ORDER, USER_PROFILES } from '../constants/agents';
import { 
  sendMessage, 
  createConversation, 
  getConversationOpener,
  getUserProfile,
} from '../hooks/useTauri';
import { v4 as uuidv4 } from 'uuid';
import governorIcon from '../assets/governor-transparent.png';
import { GovernorNotification } from './GovernorNotification';

interface ChatWindowProps {
  onOpenSettings: () => void;
}

export function ChatWindow({ onOpenSettings }: ChatWindowProps) {
  const {
    messages,
    addMessage,
    clearMessages,
    currentConversation,
    setCurrentConversation,
    getActiveAgentsList,
    activeAgents,
    toggleAgent,
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
  const activeCount = Object.values(activeAgents).filter(Boolean).length;
  
  // Get dominant trait for user identity
  const getDominantAgent = () => {
    if (!userProfile) return 'logic' as AgentType;
    const weights = {
      instinct: userProfile.instinctWeight,
      logic: userProfile.logicWeight,
      psyche: userProfile.psycheWeight,
    };
    let max: AgentType = 'logic';
    let maxWeight = 0;
    for (const [agent, weight] of Object.entries(weights)) {
      if (weight > maxWeight) {
        maxWeight = weight;
        max = agent as AgentType;
      }
    }
    return max;
  };
  const dominantAgent = getDominantAgent();
  const dominantAgentConfig = AGENTS[dominantAgent];
  
  const [inputValue, setInputValue] = useState('');
  const [governorNotification, setGovernorNotification] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hasInitialized = useRef(false);

  // Initialize conversation when API key is available
  useEffect(() => {
    async function initConversation() {
      // Prevent double initialization in React StrictMode
      if (hasInitialized.current) return;
      hasInitialized.current = true;
      
      try {
        // Create a new conversation
        const conv = await createConversation();
        setCurrentConversation(conv);
        
        // Governor is choosing who should greet
        setIsLoading(true);
        setThinkingPhase('routing');
        setThinkingAgent('system'); // Governor thinking
        
        // Governor thinks for 3 seconds while choosing agent
        await new Promise(r => setTimeout(r, 3000));
        
        // Get opener (backend chooses agent based on weights)
        const openerResult = await getConversationOpener();
        
        // Now show the chosen agent thinking
        setThinkingAgent(openerResult.agent as AgentType);
        setThinkingPhase('thinking');
        
        // Agent thinks briefly before responding
        await new Promise(r => setTimeout(r, 1500));
        
        const agentMessage: Message = {
          id: uuidv4(),
          conversationId: conv.id,
          role: openerResult.agent as AgentType,
          content: openerResult.content,
          responseType: 'primary',
          timestamp: new Date(),
        };
        addMessage(agentMessage);
        setIsLoading(false);
        setThinkingAgent(null);
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
  }, [userProfile?.apiKey]);

  // Scroll to bottom when messages change or loading state changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);
  
  // Also scroll on any content update with a small delay for render
  useEffect(() => {
    const scrollTimer = setInterval(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    
    // Clear interval when not loading
    if (!isLoading) {
      clearInterval(scrollTimer);
    }
    
    return () => clearInterval(scrollTimer);
  }, [isLoading]);

  // Clear debate mode after a few seconds
  useEffect(() => {
    if (debateMode) {
      const timer = setTimeout(() => setDebateMode(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [debateMode, setDebateMode]);

  // Global keyboard shortcuts (Command + key)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Command key shortcuts
      if (e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'n':
            e.preventDefault();
            handleNewConversation();
            break;
          case 'p':
            e.preventDefault();
            onOpenSettings();
            break;
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
  }, []);

  // Handle send message
  const handleSend = async () => {
    const content = inputValue.trim();
    if (!content || isLoading || !currentConversation) return;
    
    const activeList = getActiveAgentsList();
    if (activeList.length === 0) {
      setError('Enable at least one agent');
      return;
    }
    
    // Clear input and reset debate mode
    setInputValue('');
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
      const result = await sendMessage(currentConversation.id, content, activeList);
      
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
        };
        addMessage(agentMessage);
        
        // If there's another response after this, wait for typing to complete
        if (i < result.responses.length - 1) {
          const typingTime = getTypingDuration(response.agent, response.content.length);
          await new Promise(r => setTimeout(r, typingTime));
        }
      }
      
      // Show weight change notification from Governor as toast
      if (result.weight_change) {
        setGovernorNotification(result.weight_change.message);
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
    }
  };

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Handle new conversation
  const handleNewConversation = async () => {
    clearMessages();
    setCurrentConversation(null);
    setDebateMode(null);
    hasInitialized.current = false;
    
    try {
      const conv = await createConversation();
      setCurrentConversation(conv);
      
      // Governor is choosing who should greet
      setIsLoading(true);
      setThinkingPhase('routing');
      setThinkingAgent('system'); // Governor thinking
      
      // Governor thinks for 3 seconds while choosing agent
      await new Promise(r => setTimeout(r, 3000));
      
      // Get opener (backend chooses agent based on weights)
      const openerResult = await getConversationOpener();
      
      // Now show the chosen agent thinking
      setThinkingAgent(openerResult.agent as AgentType);
      setThinkingPhase('thinking');
      
      // Agent thinks briefly before responding
      await new Promise(r => setTimeout(r, 1500));
      
      addMessage({
        id: uuidv4(),
        conversationId: conv.id,
        role: openerResult.agent as AgentType,
        content: openerResult.content,
        responseType: 'primary',
        timestamp: new Date(),
      });
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
      {/* Debate indicator */}
      <DebateIndicator mode={debateMode} />
      
      {/* Governor notification toast */}
      <GovernorNotification
        message={governorNotification || ''}
        isVisible={!!governorNotification}
        onDismiss={() => setGovernorNotification(null)}
      />
      
      {/* Header - Clean, centered logo with space for macOS window controls */}
      {/* #region agent log */}
      <header 
        className="flex items-center justify-between pl-20 pr-4 py-3 border-b border-smoke/30 bg-obsidian/80 backdrop-blur-md cursor-default"
        onMouseDown={async (e) => {
          const isButton = (e.target as HTMLElement).closest('button');
          fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ChatWindow.tsx:header',message:'Header mousedown',data:{isButton:!!isButton,target:(e.target as HTMLElement).tagName},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
          if (isButton) return;
          try {
            await getCurrentWindow().startDragging();
            fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ChatWindow.tsx:header',message:'startDragging succeeded',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2'})}).catch(()=>{});
          } catch (err) {
            fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ChatWindow.tsx:header',message:'startDragging failed',data:{error:String(err)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2'})}).catch(()=>{});
          }
        }}
      >
      {/* #endregion */}
        {/* Left spacer for centering (no longer needed, padding handles window controls) */}
        <div className="w-20" data-tauri-drag-region />
        
        {/* Centered logo */}
        <div 
          className="flex items-center gap-2 select-none"
          data-tauri-drag-region
        >
          <h1 className="font-logo text-base font-bold tracking-wide leading-none pointer-events-none text-white">
            Intersect
          </h1>
          <span className="px-1 py-0.5 bg-smoke/40 border border-smoke/50 rounded text-[10px] font-mono text-ash/70 pointer-events-none leading-none">v1</span>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-2 justify-end">
          {/* New conversation */}
          <button
            onClick={handleNewConversation}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-ash hover:text-pearl hover:bg-smoke/20 transition-all group cursor-pointer"
            title="New conversation (⌘N)"
          >
            <MessageSquarePlus className="w-4 h-4" strokeWidth={1.5} />
            <kbd className="px-1.5 py-0.5 bg-smoke/30 rounded text-[10px] font-mono text-ash/60 border border-smoke/40 leading-none">⌘N</kbd>
          </button>
          
          {/* Governor - click to open Profile */}
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-smoke/20 transition-all cursor-pointer"
            title="Profile (⌘P)"
          >
            <img src={governorIcon} alt="Governor" className="w-5 h-5" />
            {activeCount > 1 ? (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-ash/40" />
            )}
            <kbd className="px-1.5 py-0.5 bg-smoke/30 rounded text-[10px] font-mono text-ash/60 border border-smoke/40 leading-none">⌘P</kbd>
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24">
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
            <ThinkingIndicator agent={thinkingAgent} phase={thinkingPhase} />
          )}
        </AnimatePresence>

        <div ref={messagesEndRef} />
      </div>

      {/* Floating Input with Agent Toggles */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-3/4 max-w-5xl">
        <div className="flex items-center gap-3">
          {/* Floating chat input */}
          <div className="flex-1 bg-charcoal/80 backdrop-blur-xl rounded-2xl border border-smoke/30 transition-all relative flex items-center shadow-2xl">
            {/* User identity indicator on left */}
            <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
              <div className="relative">
                <img 
                  src={USER_PROFILES[dominantAgent]} 
                  alt="You"
                  className="w-7 h-7 rounded-full"
                  style={{ boxShadow: `0 0 0 2px ${dominantAgentConfig.color}60` }}
                />
                <div 
                  className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: dominantAgentConfig.color }}
                >
                  <BadgeCheck className="w-3.5 h-3.5 text-obsidian" strokeWidth={2.5} />
                </div>
              </div>
            </div>
            
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder=""
              disabled={isLoading}
              rows={1}
              className="w-full bg-transparent text-pearl font-mono text-sm pl-14 pr-20 py-3 resize-none outline-none border-none min-h-[48px] max-h-[120px]"
              style={{ boxShadow: 'none' }}
            />
            {/* Placeholder with styled slash */}
            {!inputValue && (
              <div className="absolute left-14 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none">
                <span className="text-ash/40 font-mono text-sm">Press</span>
                <kbd className="px-1.5 py-0.5 bg-smoke/30 rounded-md text-ash/60 font-mono text-xs border border-smoke/40">/</kbd>
                <span className="text-ash/40 font-mono text-sm">to chat</span>
              </div>
            )}
            {/* Enter hint on right side */}
            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
              <kbd className="px-1.5 py-0.5 bg-smoke/30 rounded-md text-ash/50 font-mono text-[10px] border border-smoke/40">↵ ENT</kbd>
            </div>
          </div>

          {/* Agent toggles on the right */}
          <div className="flex items-center gap-3">
            {AGENT_ORDER.map((agentId) => {
              const agent = AGENTS[agentId];
              const isActive = activeAgents[agentId];
              const canToggle = activeCount > 1 || !isActive;
              
              // Agent-specific greetings in their style
              const greetings: Record<AgentType, string> = {
                instinct: "I'm Snap. I trust my gut and help you cut through the noise with quick, intuitive reads.",
                logic: "I'm Dot. I help you think methodically, breaking down problems with structured reasoning.",
                psyche: "I'm Puff. I explore the 'why' behind everything — your motivations, emotions, and deeper meaning.",
              };
              
              return (
                <div key={agentId} className="relative group/agent">
                  <motion.button
                    onClick={() => canToggle && toggleAgent(agentId)}
                    className={`relative w-9 h-9 rounded-full overflow-hidden transition-all ${
                      isActive 
                        ? 'ring-2 ring-offset-2 ring-offset-obsidian opacity-100' 
                        : 'opacity-40 grayscale hover:opacity-60'
                    } ${!canToggle ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    style={{ 
                      // @ts-expect-error Tailwind CSS variable for ring color
                      '--tw-ring-color': isActive ? agent.color : 'transparent',
                    }}
                    whileHover={canToggle ? { scale: 1.08 } : {}}
                    whileTap={canToggle ? { scale: 0.92 } : {}}
                  >
                    <img 
                      src={agent.avatar} 
                      alt={agent.name}
                      className="w-full h-full object-cover"
                    />
                  </motion.button>
                  
                  {/* Hover tooltip with agent greeting */}
                  <div 
                    className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 px-3 py-2 bg-obsidian/95 border rounded-lg opacity-0 invisible group-hover/agent:opacity-100 group-hover/agent:visible transition-all shadow-xl w-[200px] z-50 pointer-events-none"
                    style={{ borderColor: `${agent.color}40` }}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span 
                        className="text-xs font-sans font-medium"
                        style={{ color: agent.color }}
                      >
                        {agent.name}
                      </span>
                      <span className="text-[9px] text-ash/50 font-mono uppercase">{agentId}</span>
                    </div>
                    <p className="text-[10px] text-ash/80 font-mono leading-relaxed">
                      {greetings[agentId]}
                    </p>
                    {!canToggle && (
                      <p className="text-[9px] text-instinct/60 font-mono mt-1">At least one agent required</p>
                    )}
                    {/* Tooltip arrow */}
                    <div 
                      className="absolute left-1/2 -translate-x-1/2 top-full -mt-px border-4 border-transparent"
                      style={{ borderTopColor: `${agent.color}40` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
