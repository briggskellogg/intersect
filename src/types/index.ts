// Agent types
export type AgentType = 'instinct' | 'logic' | 'psyche';

// Agent mode: off, on (normal), or disco (intense mode per-agent)
export type AgentMode = 'off' | 'on' | 'disco';

export type ResponseType = 'primary' | 'addition' | 'rebuttal' | 'debate';

export interface AgentConfig {
  id: AgentType;
  name: string;
  color: string;
  softColor: string;
  description: string;
  avatar: string;
}

// Message types
export type MessageRole = 'user' | 'system' | 'governor' | 'governor_thoughts' | AgentType;

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  responseType?: ResponseType;
  referencesMessageId?: string;
  timestamp: Date;
  isStreaming?: boolean;
  isDisco?: boolean;  // Whether this message was generated in Disco Mode
  agentName?: string; // For governor_thoughts: which agent said this
}

// Agent response from backend
export interface AgentResponse {
  agent: string;
  content: string;
  response_type: string;
  references_message_id?: string;
}

// Weight change notification
export interface WeightChangeNotification {
  message: string;
  old_dominant: string;
  new_dominant: string;
  change_type: 'shift' | 'major_shift' | 'minor';
}

// Send message result
export interface SendMessageResult {
  responses: AgentResponse[];
  debate_mode: 'mild' | 'intense' | null;
  weight_change: WeightChangeNotification | null;
  governor_thoughts: string | null;
  governor_response: string | null;
}

// User profile (API keys and message count)
export interface UserProfile {
  id: number;
  apiKey: string | null;
  anthropicKey: string | null;
  instinctWeight: number;
  logicWeight: number;
  psycheWeight: number;
  totalMessages: number;
  createdAt: Date;
  updatedAt: Date;
}

// Persona profile (multi-profile system for different user states)
export interface PersonaProfile {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  dominantTrait: AgentType;
  secondaryTrait: AgentType;
  instinctWeight: number;
  logicWeight: number;
  psycheWeight: number;
  instinctPoints: number;  // User-allocated points (2-6, total 11)
  logicPoints: number;
  psychePoints: number;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Conversation
export interface Conversation {
  id: string;
  title: string | null;
  summary: string | null;
  isDisco: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// User context (learned facts)
export interface UserContext {
  id: number;
  key: string;
  value: string;
  confidence: number;
  sourceAgent: string | null;
  updatedAt: Date;
}

// Debate mode
export type DebateMode = 'mild' | 'intense' | null;




