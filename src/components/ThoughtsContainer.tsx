import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { Message, AgentType } from '../types';
import { AGENTS, DISCO_AGENTS } from '../constants/agents';

interface ThoughtsContainerProps {
  thoughts: Message[];
}

// Individual thought with typewriter effect
function ThoughtBubble({ thought, agent }: { thought: Message; agent: { name: string; color: string; avatar: string } }) {
  const [displayedText, setDisplayedText] = useState('');
  const [isTyping, setIsTyping] = useState(true);
  const messageIdRef = useRef(thought.id);

  useEffect(() => {
    // If this is the same message that already typed, skip
    if (messageIdRef.current === thought.id && displayedText === thought.content) {
      setIsTyping(false);
      return;
    }

    messageIdRef.current = thought.id;
    setIsTyping(true);
    let currentIndex = 0;
    const content = thought.content;

    // Fast typing for thoughts
    const interval = 8;
    const charsMin = 3;
    const charsMax = 5;

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
  }, [thought.id, thought.content]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="group/thought"
    >
      {/* Agent name with profile picture and pill */}
      <div className="flex items-center gap-1.5 mb-1">
        {/* Agent profile picture - smaller */}
        <div className="flex-shrink-0 w-5 h-5 rounded-full overflow-hidden opacity-70">
          <img 
            src={agent.avatar} 
            alt={agent.name}
            className="w-full h-full object-cover"
          />
        </div>
        {/* Agent name in pill - smaller and more faded */}
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[9px] font-mono font-medium opacity-70"
          style={{ 
            backgroundColor: `${agent.color}15`,
            color: agent.color,
          }}
        >
          {agent.name}
        </span>
      </div>

      {/* Thought content with typewriter - smaller and more faded */}
      <div className="ml-0 opacity-60">
        <div
          className="text-[10px] font-mono leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-0.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-headings:my-1 prose-strong:font-semibold prose-code:bg-smoke/20 prose-code:px-1 prose-code:rounded prose-code:text-[9px]"
          style={{ color: 'rgba(148, 163, 184, 0.6)' }}
        >
          {isTyping ? (
            <>
              <span className="whitespace-pre-wrap">{displayedText}</span>
              <motion.span 
                className="inline-block ml-0.5 w-[1px] h-[0.8em] align-baseline rounded-full"
                style={{ backgroundColor: agent.color }}
                animate={{ opacity: [1, 0] }}
                transition={{ duration: 0.5, repeat: Infinity, ease: 'linear' }}
              />
            </>
          ) : (
            <ReactMarkdown>{thought.content}</ReactMarkdown>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export function ThoughtsContainer({ thoughts }: ThoughtsContainerProps) {
  if (thoughts.length === 0) {
    return null;
  }

  const getAgentInfo = (message: Message) => {
    if (!message.agentName) return null;
    
    const agentType = Object.keys(AGENTS).find(
      key => AGENTS[key as AgentType].name === message.agentName
    ) || Object.keys(DISCO_AGENTS).find(
      key => DISCO_AGENTS[key as AgentType].name === message.agentName
    );
    
    if (agentType) {
      return (message.isDisco ? DISCO_AGENTS : AGENTS)[agentType as AgentType];
    }
    return null;
  };

  return (
    <div className="mb-2">
      <div className="space-y-2 pl-4 border-l-2 border-ash/10">
        {thoughts.map((thought) => {
          const agent = getAgentInfo(thought);
          if (!agent) return null;

          return (
            <ThoughtBubble 
              key={thought.id} 
              thought={thought} 
              agent={agent} 
            />
          );
        })}
      </div>
    </div>
  );
}
