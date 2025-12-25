import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { Message, AgentType } from '../types';
import { AGENTS, DISCO_AGENTS, USER_PROFILES, GOVERNOR } from '../constants/agents';
import { useAppStore } from '../store';
import { ThoughtsContainer } from './ThoughtBubble';

interface MessageBubbleProps {
  message: Message;
  isLatest?: boolean;
}

export function MessageBubble({ message, isLatest: _isLatest }: MessageBubbleProps) {
  const { activePersonaProfile } = useAppStore();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isGovernor = message.role === 'governor';
  const agentConfig = message.isDisco ? DISCO_AGENTS : AGENTS;
  const agent = isUser ? null : (isSystem || isGovernor) ? GOVERNOR : agentConfig[message.role as AgentType];
  
  
  // Typewriter effect for agent messages
  const [displayedText, setDisplayedText] = useState(() => isUser ? message.content : '');
  const [isTyping, setIsTyping] = useState(() => !isUser);
  const messageIdRef = useRef(message.id);
  
  useEffect(() => {
    // Skip typing effect for user messages
    if (isUser) {
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
  
  // Get user's dominant agent from active persona profile for their profile photo
  const dominantAgent: AgentType = activePersonaProfile?.dominantTrait || 'logic';
  const userAvatar = USER_PROFILES[dominantAgent];
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-2`}
    >
      {/* V2: Show thoughts above Governor synthesis */}
      {isGovernor && message.thoughts && message.thoughts.length > 0 && (
        <ThoughtsContainer thoughts={message.thoughts} />
      )}
      
      {/* Bubble row - avatar aligned with name tag */}
      <div className={`flex gap-2 items-start ${isUser ? 'flex-row-reverse' : ''}`}>
        {/* Agent avatar - aligned with name tag (slight offset from top) */}
        {agent && (
          <div className="relative flex-shrink-0 mt-[7px]">
            <div className="w-8 h-8 rounded-full overflow-hidden">
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
              ? 'bg-smoke/40 text-pearl/90'
              : 'bg-charcoal/40'
          }`}
          style={{ maxWidth: 'calc(75vw - 60px)' }}
        >
          {/* Agent/Governor name tag - compact */}
          {!isUser && !isSystem && agent && (
            <span 
              className="inline-block px-2 py-0.5 rounded text-[11px] font-mono font-medium mb-1.5"
              style={{ 
                backgroundColor: `${agent.color}20`,
                color: agent.color,
              }}
            >
              {isGovernor ? 'Governor' : agent.name}
            </span>
          )}
          
          <div 
            className="leading-snug text-[13px] font-mono prose prose-invert prose-sm max-w-none prose-p:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:my-1.5 prose-strong:font-semibold prose-code:bg-smoke/30 prose-code:px-1 prose-code:rounded prose-code:text-[12px]"
            style={!isUser && agent ? { color: `${agent.color}dd` } : undefined}
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
