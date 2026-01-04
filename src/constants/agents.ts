import { AgentConfig, AgentType } from '../types';

// Import agent avatars (for agent messages - Normal mode)
import instinctAvatar from '../assets/agents/instinct-incarnate.png';
import logicAvatar from '../assets/agents/logic-incarnate.png';
import psycheAvatar from '../assets/agents/psyche-incarnate.png';

// Import disco agent avatars (for agent messages - Disco mode)
import discoSnapAvatar from '../assets/agents/disco-snap.png';
import discoDotAvatar from '../assets/agents/disco-dot.png';
import discoPuffAvatar from '../assets/agents/disco-puff.png';

// Import user profile photos (for user messages - based on highest weight)
import instinctProfile from '../assets/agents/instinct.png';
import logicProfile from '../assets/agents/logic.png';
import psycheProfile from '../assets/agents/psyche.png';

// Import Governor avatar (for system messages)
import governorAvatar from '../assets/governor.png';

// Normal mode agents - helpful, practical, solution-oriented
export const AGENTS: Record<AgentType, AgentConfig> = {
  instinct: {
    id: 'instinct',
    name: 'Snap',
    color: '#EF4444', // Red - Instinct
    softColor: '#EF444415',
    description: 'Gut feelings, intuition, emotional intelligence, pattern recognition',
    avatar: instinctAvatar,
  },
  logic: {
    id: 'logic',
    name: 'Dot',
    color: '#00D4FF', // Cyan - Logic
    softColor: '#00D4FF15',
    description: 'Analytical thinking, structured reasoning, evidence-based conclusions',
    avatar: logicAvatar,
  },
  psyche: {
    id: 'psyche',
    name: 'Puff',
    color: '#E040FB', // Purple - Psyche
    softColor: '#E040FB15',
    description: 'Self-awareness, emotional depth, motivations, the "why" behind the "what"',
    avatar: psycheAvatar,
  },
};

// Disco mode agents - challenging, opinionated, personality-forward
// Different names and avatars from normal mode
// Mappings: Instinct→Swarm, Logic→Spin, Psyche→Storm
export const DISCO_AGENTS: Record<AgentType, AgentConfig> = {
  instinct: {
    id: 'instinct',
    name: 'Swarm',
    color: '#EF4444', // Red - Instinct
    softColor: '#EF444415',
    description: 'Raw impulse, unfiltered instinct, the part that moves before thinking',
    avatar: discoSnapAvatar,
  },
  logic: {
    id: 'logic',
    name: 'Spin',
    color: '#00D4FF', // Cyan - Logic
    softColor: '#00D4FF15',
    description: 'Cold analysis, pattern recognition, the part that sees contradictions',
    avatar: discoDotAvatar,
  },
  psyche: {
    id: 'psyche',
    name: 'Storm',
    color: '#E040FB', // Purple - Psyche
    softColor: '#E040FB15',
    description: 'Deep intuition, emotional truth, the part that knows what you\'re avoiding',
    avatar: discoPuffAvatar,
  },
};

// User profile photos based on dominant agent
export const USER_PROFILES: Record<AgentType, string> = {
  instinct: instinctProfile,
  logic: logicProfile,
  psyche: psycheProfile,
};

export const AGENT_ORDER: AgentType[] = ['psyche', 'logic', 'instinct'];

// Governor - system agent for admin/error messages
export const GOVERNOR = {
  id: 'system',
  name: 'Governor',
  color: '#EAB308', // Amber - Governor
  softColor: '#EAB30815',
  description: 'System administrator and guide',
  avatar: governorAvatar,
};

