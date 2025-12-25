import { motion } from 'framer-motion';

interface ThoughtBubbleProps {
  agent: string;      // "instinct", "logic", "psyche"
  name: string;       // Display name: "Snap", "Swarm", etc.
  content: string;    // The thought content
  isDisco: boolean;   // Whether disco mode was used
  index: number;      // For staggered animation
}

// Agent colors
const AGENT_COLORS: Record<string, { normal: string; disco: string }> = {
  instinct: { normal: '#E07A5F', disco: '#EF4444' },
  logic: { normal: '#6BB8C9', disco: '#22D3EE' },
  psyche: { normal: '#A78BCA', disco: '#C084FC' },
};

export function ThoughtBubble({ agent, name, content, isDisco, index }: ThoughtBubbleProps) {
  const colors = AGENT_COLORS[agent] || AGENT_COLORS.logic;
  const color = isDisco ? colors.disco : colors.normal;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ 
        duration: 0.3, 
        delay: index * 0.15, // Stagger animation
        ease: 'easeOut' 
      }}
      className="flex items-start gap-2 mb-1.5"
    >
      {/* Agent indicator dot */}
      <div 
        className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      
      {/* Thought content */}
      <div className="flex-1 min-w-0">
        {/* Agent name */}
        <span 
          className="text-[10px] font-mono font-medium mr-1.5"
          style={{ color }}
        >
          {name}
        </span>
        
        {/* Thought text - smaller, muted */}
        <span className="text-xs text-ash/70 font-mono leading-relaxed">
          {content}
        </span>
      </div>
    </motion.div>
  );
}

// Container for multiple thoughts (displayed above Governor's response)
interface ThoughtsContainerProps {
  thoughts: Array<{
    agent: string;
    name: string;
    content: string;
    is_disco: boolean;
  }>;
}

export function ThoughtsContainer({ thoughts }: ThoughtsContainerProps) {
  if (!thoughts || thoughts.length === 0) return null;
  
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mb-3 pl-10 border-l-2 border-smoke/30 ml-4"
    >
      <div className="text-[9px] text-ash/40 font-mono uppercase tracking-wider mb-2">
        Internal Council
      </div>
      {thoughts.map((thought, idx) => (
        <ThoughtBubble
          key={`${thought.agent}-${idx}`}
          agent={thought.agent}
          name={thought.name}
          content={thought.content}
          isDisco={thought.is_disco}
          index={idx}
        />
      ))}
    </motion.div>
  );
}

