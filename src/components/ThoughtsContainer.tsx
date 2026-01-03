import ReactMarkdown from 'react-markdown';
import { Message, AgentType } from '../types';
import { AGENTS, DISCO_AGENTS } from '../constants/agents';

interface ThoughtsContainerProps {
  thoughts: Message[];
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
            <div key={thought.id} className="group/thought">
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

              {/* Thought content - smaller and more faded */}
              <div className="ml-0 opacity-60">
                <div
                  className="text-[10px] font-mono leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-0.5 prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-headings:my-1 prose-strong:font-semibold prose-code:bg-smoke/20 prose-code:px-1 prose-code:rounded prose-code:text-[9px]"
                  style={{ color: 'rgba(148, 163, 184, 0.6)' }}
                >
                  <ReactMarkdown>{thought.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

