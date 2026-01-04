import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AgentType } from '../types';
import { AGENTS } from '../constants/agents';

interface ImmersiveThoughtBubbleProps {
  id: string;
  agentType: AgentType;
  content: string;
  position: { x: number; y: number }; // Position relative to center
  isActive: boolean; // Currently speaking
  isComplete: boolean; // Finished speaking
  onAnimationComplete?: () => void;
}

export function ImmersiveThoughtBubble({
  id,
  agentType,
  content,
  position,
  isActive,
  isComplete,
  onAnimationComplete,
}: ImmersiveThoughtBubbleProps) {
  const agent = AGENTS[agentType];
  const [displayedText, setDisplayedText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const typingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Typewriter effect
  useEffect(() => {
    if (!isActive) return;

    setIsTyping(true);
    let currentIndex = 0;
    const text = content;

    typingIntervalRef.current = setInterval(() => {
      if (currentIndex < text.length) {
        const charsToAdd = Math.min(2 + Math.floor(Math.random() * 2), text.length - currentIndex);
        currentIndex += charsToAdd;
        setDisplayedText(text.slice(0, currentIndex));
      } else {
        if (typingIntervalRef.current) {
          clearInterval(typingIntervalRef.current);
        }
        setIsTyping(false);
      }
    }, 30);

    return () => {
      if (typingIntervalRef.current) {
        clearInterval(typingIntervalRef.current);
      }
    };
  }, [isActive, content]);

  // Show full text when complete
  useEffect(() => {
    if (isComplete && !isActive) {
      setDisplayedText(content);
      setIsTyping(false);
    }
  }, [isComplete, isActive, content]);

  return (
    <AnimatePresence onExitComplete={onAnimationComplete}>
      {!isComplete && (
        <motion.div
          key={id}
          initial={{ opacity: 0, scale: 0.8, x: position.x, y: position.y }}
          animate={{ 
            opacity: isActive ? 1 : 0.6, 
            scale: isActive ? 1 : 0.9,
            x: position.x,
            y: position.y,
          }}
          exit={{ 
            opacity: 0, 
            scale: 0.5,
            x: 0,
            y: 0,
            transition: { duration: 0.5 }
          }}
          transition={{ 
            type: 'spring',
            stiffness: 200,
            damping: 20,
          }}
          className="absolute flex flex-col items-center gap-2 pointer-events-none"
          style={{ 
            left: '50%',
            top: '50%',
            transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px)`,
            maxWidth: '280px',
          }}
        >
          {/* Agent avatar */}
          <motion.div 
            className="relative"
            animate={isActive ? { 
              boxShadow: `0 0 20px ${agent.color}80`,
            } : {}}
          >
            <div 
              className="w-12 h-12 rounded-full overflow-hidden border-2"
              style={{ borderColor: agent.color }}
            >
              <img 
                src={agent.avatar} 
                alt={agent.name}
                className="w-full h-full object-cover"
              />
            </div>
            
            {/* Speaking indicator */}
            {isActive && (
              <motion.div
                className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full"
                style={{ backgroundColor: agent.color }}
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ repeat: Infinity, duration: 0.8 }}
              />
            )}
          </motion.div>

          {/* Agent name pill */}
          <div
            className="px-2 py-0.5 rounded-full text-xs font-mono font-medium"
            style={{ 
              backgroundColor: `${agent.color}20`,
              color: agent.color,
            }}
          >
            {agent.name}
          </div>

          {/* Thought bubble */}
          <motion.div
            className="relative px-4 py-3 rounded-2xl backdrop-blur-sm"
            style={{
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              border: `1px solid ${agent.color}40`,
            }}
            animate={isActive ? {
              borderColor: [`${agent.color}40`, `${agent.color}80`, `${agent.color}40`],
            } : {}}
            transition={{ repeat: Infinity, duration: 2 }}
          >
            {/* Content */}
            <p 
              className="text-sm leading-relaxed"
              style={{ color: 'rgba(226, 232, 240, 0.9)' }}
            >
              {displayedText || '...'}
              {isTyping && (
                <motion.span
                  className="inline-block w-0.5 h-4 ml-0.5 align-text-bottom rounded"
                  style={{ backgroundColor: agent.color }}
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ repeat: Infinity, duration: 0.6 }}
                />
              )}
            </p>

            {/* Decorative tail pointing to avatar */}
            <div
              className="absolute -top-2 left-1/2 -translate-x-1/2 w-0 h-0"
              style={{
                borderLeft: '8px solid transparent',
                borderRight: '8px solid transparent',
                borderBottom: `8px solid ${agent.color}40`,
              }}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Helper to calculate radial positions around center
// Positions thoughts in upper arc to keep them visible
export function calculateBubblePositions(count: number, radius: number = 160): { x: number; y: number }[] {
  // Fixed positions that stay visible - upper arc only
  const fixedPositions = [
    { x: 0, y: -radius },           // Top center
    { x: -radius * 0.9, y: -radius * 0.4 },  // Upper left
    { x: radius * 0.9, y: -radius * 0.4 },   // Upper right
  ];
  
  return fixedPositions.slice(0, count);
}
