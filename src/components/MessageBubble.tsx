import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { Message, AgentType } from '../types';
import { AGENTS, DISCO_AGENTS, GOVERNOR, USER_PROFILES } from '../constants/agents';
import { useAppStore } from '../store';

interface MessageBubbleProps {
  message: Message;
  isLatest?: boolean;
  governorIcon?: string | null;
  isDiscoMode?: boolean;
}

export function MessageBubble({ message, isLatest: _isLatest, governorIcon, isDiscoMode: _isDiscoMode = false }: MessageBubbleProps) {
  const { theme } = useAppStore();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isGovernor = message.role === 'governor';
  const isGovernorThoughts = message.role === 'governor_thoughts';
  const agentConfig = message.isDisco ? DISCO_AGENTS : AGENTS;
  
  // Determine if we're in light mode
  const isLightMode = theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  
  // Governor always uses normal avatar (disco mode doesn't affect governor)
  const governorAvatar = governorIcon || GOVERNOR.avatar;
  
  const agent = isUser 
    ? null 
    : isSystem || isGovernor || isGovernorThoughts 
      ? { ...GOVERNOR, avatar: governorAvatar }
      : agentConfig[message.role as AgentType];
  
  
  // Typewriter effect for agent messages and governor thoughts
  // Skip typing if message is older than 2 seconds (e.g. returning from immersive mode)
  const isOldMessage = Date.now() - new Date(message.timestamp).getTime() > 2000;
  const shouldSkipTyping = isUser || isOldMessage;
  
  const [displayedText, setDisplayedText] = useState(() => shouldSkipTyping ? message.content : '');
  const [isTyping, setIsTyping] = useState(() => !shouldSkipTyping);
  const messageIdRef = useRef(message.id);
  
  useEffect(() => {
    // Skip typing effect for user messages or old messages
    if (shouldSkipTyping) {
      setDisplayedText(message.content);
      setIsTyping(false);
      return;
    }
    
    // If this is the same message that already typed, skip
    if (messageIdRef.current === message.id && displayedText === message.content) {
      setIsTyping(false);
      return;
    }
    
    // Start typing animation with agent-specific speeds
    // Instinct: rushed/fast, Psyche: medium, Logic: deliberate/slow
    messageIdRef.current = message.id;
    setIsTyping(true);
    let currentIndex = 0;
    const content = message.content;
    
    // Agent-specific typing characteristics
    const getTypingParams = () => {
      switch (message.role) {
        case 'instinct':
          return { interval: 6, charsMin: 3, charsMax: 5 }; // Fast, rushed
        case 'psyche':
          return { interval: 14, charsMin: 2, charsMax: 3 }; // Medium, thoughtful
        case 'logic':
          return { interval: 22, charsMin: 1, charsMax: 2 }; // Slow, deliberate
        case 'governor_thoughts':
          return { interval: 10, charsMin: 2, charsMax: 4 }; // Medium-fast for thoughts
        case 'governor':
          return { interval: 15, charsMin: 2, charsMax: 3 }; // Medium for Governor responses
        default:
          return { interval: 12, charsMin: 2, charsMax: 3 }; // System/default
      }
    };
    
    const { interval, charsMin, charsMax } = getTypingParams();
    
    const typingInterval = setInterval(() => {
      if (currentIndex < content.length) {
        const charsToAdd = Math.min(
          charsMin + Math.floor(Math.random() * (charsMax - charsMin + 1)), 
          content.length - currentIndex
        );
        currentIndex += charsToAdd;
        setDisplayedText(content.slice(0, currentIndex));
      } else {
        clearInterval(typingInterval);
        setIsTyping(false);
      }
    }, interval);
    
    return () => clearInterval(typingInterval);
  }, [message.id, message.content, isUser, message.role]);
  
  // Use dominant trait profile picture for user messages
  const { activePersonaProfile, userProfile } = useAppStore();
  // Use activePersonaProfile's dominantTrait if available, otherwise calculate from weights
  const dominantTrait = activePersonaProfile?.dominantTrait || 
    (userProfile ? (
      userProfile.logicWeight > userProfile.psycheWeight && userProfile.logicWeight > userProfile.instinctWeight ? 'logic' :
      userProfile.psycheWeight > userProfile.instinctWeight ? 'psyche' : 'instinct'
    ) : 'instinct');
  const userAvatar = USER_PROFILES[dominantTrait];
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-2`}
    >
      {/* Bubble row - avatar aligned with name tag */}
      <div className={`flex gap-2 items-start ${isUser ? 'flex-row-reverse' : ''}`}>
        {/* Agent avatar - aligned with name tag (slight offset from top) */}
        {agent && (
          <div className="relative flex-shrink-0 mt-[7px]">
            <div className={`${isGovernorThoughts ? 'w-9 h-9' : 'w-8 h-8'} rounded-full overflow-hidden`}>
              <img 
                src={agent.avatar} 
                alt={agent.name}
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        )}

        {/* User avatar - aligned with message content, with pulsing gold border */}
        {isUser && (
          <div className="relative flex-shrink-0 mt-2">
            {/* Subtle pulsing gold ring - never fully fades */}
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
            <div className="w-8 h-8 rounded-full overflow-hidden relative z-10">
              <img 
                src={userAvatar} 
                alt="You"
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        )}

        {/* Message bubble - tighter padding, 75% max width */}
        <div
          className={`px-3 py-2 rounded-2xl ${
            isUser
              ? isLightMode 
                ? 'bg-slate-200/80 text-slate-800' 
                : 'bg-smoke/40 text-pearl/90'
              : isGovernorThoughts
              ? isLightMode
                ? 'bg-slate-100/90 border border-slate-300/60 opacity-85'
                : 'bg-charcoal/25 border border-ash/40 opacity-75'
              : isLightMode
                ? 'bg-white/90 border border-slate-200/80 text-slate-900 shadow-sm'
              : 'bg-charcoal/40 text-pearl'
          }`}
          style={{ maxWidth: 'calc(75vw - 60px)' }}
        >
          {/* Agent name tag - compact */}
          {!isUser && !isSystem && !isGovernor && !isGovernorThoughts && agent && (
            <span 
              className="inline-block px-2 py-0.5 rounded text-[11px] font-mono font-medium mb-1.5"
              style={{ 
                backgroundColor: `${agent.color}20`,
                color: agent.color,
              }}
            >
              {agent.name}
            </span>
          )}
          
          {/* Governor thoughts label - shows agent name */}
          {isGovernorThoughts && message.agentName && (
            <div className="flex items-center gap-1.5 mb-1.5">
              {(() => {
                const agentType = Object.keys(AGENTS).find(
                  key => AGENTS[key as AgentType].name === message.agentName
                ) || Object.keys(DISCO_AGENTS).find(
                  key => DISCO_AGENTS[key as AgentType].name === message.agentName
                );
                const agent = agentType 
                  ? (message.isDisco ? DISCO_AGENTS : AGENTS)[agentType as AgentType]
                  : null;
                return agent ? (
                  <span 
                    className="inline-block px-2 py-0.5 rounded text-[11px] font-mono font-medium opacity-90"
                    style={{ 
                      backgroundColor: `${agent.color}20`,
                      color: agent.color,
                    }}
                  >
                    {agent.name}
                  </span>
                ) : (
                  <span 
                    className="inline-block px-2 py-0.5 rounded text-[11px] font-mono font-medium opacity-80"
                    style={{ 
                      backgroundColor: `${GOVERNOR.color}15`,
                      color: GOVERNOR.color,
                    }}
                  >
                    {message.agentName}
                  </span>
                );
              })()}
            </div>
          )}
          
          {/* Governor response label - shows as final answer */}
          {isGovernor && (
            <div className="flex items-center gap-1.5 mb-1.5">
              <span 
                className="inline-block px-2 py-0.5 rounded text-[11px] font-mono font-medium"
                style={{ 
                  backgroundColor: `${GOVERNOR.color}20`,
                  color: GOVERNOR.color,
                }}
              >
                {GOVERNOR.name}
              </span>
            </div>
          )}
          
          {/* System message label (for error messages, etc.) */}
          {isSystem && !isGovernor && !isGovernorThoughts && (
            <div className="flex items-center gap-1.5 mb-1.5">
              <span 
                className="inline-block px-2 py-0.5 rounded text-[11px] font-mono font-medium"
                style={{ 
                  backgroundColor: `${GOVERNOR.color}20`,
                  color: GOVERNOR.color,
                }}
              >
                {GOVERNOR.name}
              </span>
            </div>
          )}
          
          <div 
            className={`leading-snug text-[13px] font-mono prose prose-invert prose-sm max-w-none prose-p:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:my-1.5 prose-strong:font-semibold prose-code:bg-smoke/30 prose-code:px-1 prose-code:rounded prose-code:text-[12px] ${
              isGovernorThoughts ? 'italic text-ash/70' : isLightMode ? 'text-pearl' : ''
            }`}
            style={
              !isUser && agent && !isLightMode
                ? isGovernorThoughts 
                  ? { color: `${GOVERNOR.color}aa` } // Muted governor color for thoughts (dark mode only)
                  : isGovernor
                    ? undefined // Governor responses are white in text mode
                    : { color: `${agent.color}dd` } // Agent color (dark mode only)
                : undefined
            }
          >
            {isTyping ? (
              <>
                <span className="whitespace-pre-wrap">{displayedText}</span>
                <motion.span 
                  className="inline-block ml-0.5 w-[1.5px] h-[1em] align-baseline rounded-full"
                  style={{ backgroundColor: agent?.color }}
                  animate={{ opacity: [1, 0] }}
                  transition={{ duration: 0.6, repeat: Infinity, ease: 'linear' }}
                />
              </>
            ) : (
              <ReactMarkdown>{isUser ? message.content : displayedText}</ReactMarkdown>
            )}
          </div>
        </div>
      </div>
      
      {/* Timestamp - below bubble, aligned with bubble edge */}
      <div className={`text-[9px] text-ash/30 mt-0.5 font-mono ${isUser ? 'mr-10' : 'ml-10'}`}>
        {message.timestamp.toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit' 
        })}
      </div>
    </motion.div>
  );
}
