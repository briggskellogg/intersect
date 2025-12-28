import { create } from 'zustand';
import { Message, UserProfile, PersonaProfile, Conversation, AgentType, DebateMode } from '../types';

export type Theme = 'light' | 'dark' | 'system';

interface AgentModeState {
  instinct: 'on' | 'off';
  logic: 'on' | 'off';
  psyche: 'on' | 'off';
}

interface AppState {
  // User profile (API keys, message count)
  userProfile: UserProfile | null;
  setUserProfile: (profile: UserProfile | null) => void;
  
  // Active persona profile (multi-profile system)
  activePersonaProfile: PersonaProfile | null;
  setActivePersonaProfile: (profile: PersonaProfile | null) => void;
  allPersonaProfiles: PersonaProfile[];
  setAllPersonaProfiles: (profiles: PersonaProfile[]) => void;
  
  // Current conversation (includes isDisco for conversation-level disco mode)
  currentConversation: Conversation | null;
  setCurrentConversation: (conv: Conversation | null) => void;
  
  // Messages
  messages: Message[];
  addMessage: (message: Message) => void;
  setMessages: (messages: Message[]) => void;
  clearMessages: () => void;
  
  // Agent modes (simple on/off toggle)
  agentModes: AgentModeState;
  toggleAgentMode: (agent: AgentType) => void;
  
  // Global disco mode (all agents + governor)
  isDiscoMode: boolean;
  toggleDiscoMode: () => void;
  
  getActiveAgentsList: () => AgentType[];
  isAgentActive: (agent: AgentType) => boolean;
  
  // Legacy compatibility (deprecated - use agentModes instead)
  activeAgents: { instinct: boolean; logic: boolean; psyche: boolean };
  toggleAgent: (agent: AgentType) => void;
  
  // Legacy disco conversation check (now derived from agent modes)
  isDiscoConversation: () => boolean;
  
  // Debate mode
  debateMode: DebateMode;
  setDebateMode: (mode: DebateMode) => void;
  
  // Loading
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  thinkingAgent: AgentType | 'system' | null;
  setThinkingAgent: (agent: AgentType | 'system' | null) => void;
  thinkingPhase: 'routing' | 'thinking';
  setThinkingPhase: (phase: 'routing' | 'thinking') => void;
  
  // Error
  error: string | null;
  setError: (error: string | null) => void;
  apiConnectionError: string | null;
  setApiConnectionError: (error: string | null) => void;
  
  // Settings
  isSettingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  
  // Floating mode
  isFloatingMode: boolean;
  setFloatingMode: (floating: boolean) => void;
  
  // Theme (light/dark mode)
  theme: Theme;
  setTheme: (theme: Theme) => void;
  
  // ElevenLabs API key (for voice transcription)
  elevenLabsApiKey: string | null;
  setElevenLabsApiKey: (key: string | null) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // User profile (API keys, message count)
  userProfile: null,
  setUserProfile: (profile) => set({ userProfile: profile }),
  
  // Active persona profile (multi-profile system)
  activePersonaProfile: null,
  setActivePersonaProfile: (profile) => set({ activePersonaProfile: profile }),
  allPersonaProfiles: [],
  setAllPersonaProfiles: (profiles) => set({ allPersonaProfiles: profiles }),
  
  // Current conversation
  currentConversation: null,
  setCurrentConversation: (conv) => set({ currentConversation: conv }),
  
  // Messages
  messages: [],
  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message],
  })),
  setMessages: (messages) => set({ messages }),
  clearMessages: () => set({ messages: [] }),
  
  // Agent modes (simple on/off toggle)
  agentModes: {
    instinct: 'on',
    logic: 'on',
    psyche: 'on',
  },
  
  toggleAgentMode: (agent) => set((state) => {
    const currentMode = state.agentModes[agent];
    const activeCount = Object.values(state.agentModes).filter(m => m !== 'off').length;
    
    // Simple toggle: off -> on, on -> off
    // But prevent turning off if it's the last active agent
    if (currentMode === 'off') {
      return {
        agentModes: {
          ...state.agentModes,
          [agent]: 'on',
        },
      };
    } else {
      // Can't turn off the last agent
      if (activeCount <= 1) {
        return state; // No change
      }
      return {
        agentModes: {
          ...state.agentModes,
          [agent]: 'off',
        },
      };
    }
  }),
  
  // Global disco mode (all agents + governor)
  isDiscoMode: false,
  toggleDiscoMode: () => set((state) => ({ isDiscoMode: !state.isDiscoMode })),
  
  getActiveAgentsList: () => {
    const state = get();
    const agents: AgentType[] = [];
    if (state.agentModes.instinct !== 'off') agents.push('instinct');
    if (state.agentModes.logic !== 'off') agents.push('logic');
    if (state.agentModes.psyche !== 'off') agents.push('psyche');
    return agents;
  },
  
  isAgentActive: (agent) => {
    const state = get();
    return state.agentModes[agent] !== 'off';
  },
  
  // Legacy disco conversation check - now uses global disco mode
  isDiscoConversation: () => {
    const state = get();
    return state.isDiscoMode;
  },
  
  // Legacy compatibility - computed from agentModes
  get activeAgents() {
    const state = get();
    return {
      instinct: state.agentModes.instinct === 'on',
      logic: state.agentModes.logic === 'on',
      psyche: state.agentModes.psyche === 'on',
    };
  },
  
  // Legacy compatibility methods
  getDiscoAgentsList: () => {
    const state = get();
    // If disco mode is on, return all active agents
    if (state.isDiscoMode) {
      return state.getActiveAgentsList();
    }
    return [];
  },
  
  hasAnyDiscoAgent: () => {
    const state = get();
    return state.isDiscoMode;
  },
  
  toggleAllDisco: () => {
    get().toggleDiscoMode();
  },
  
  toggleAgent: (agent) => {
    // Legacy toggle
    get().toggleAgentMode(agent);
  },
  
  // Debate mode
  debateMode: null,
  setDebateMode: (mode) => set({ debateMode: mode }),
  
  // Loading
  isLoading: false,
  setIsLoading: (isLoading) => set({ isLoading }),
  thinkingAgent: null,
  setThinkingAgent: (agent) => set({ thinkingAgent: agent }),
  thinkingPhase: 'routing' as const,
  setThinkingPhase: (phase) => set({ thinkingPhase: phase }),
  
  // Error
  error: null,
  setError: (error) => set({ error }),
  apiConnectionError: null,
  setApiConnectionError: (apiConnectionError) => set({ apiConnectionError }),
  
  // Settings
  isSettingsOpen: false,
  setSettingsOpen: (isSettingsOpen) => set({ isSettingsOpen }),
  
  // Floating mode
  isFloatingMode: false,
  setFloatingMode: (isFloatingMode) => set({ isFloatingMode }),
  
  // Theme (light/dark/system mode) - persisted to localStorage
  theme: (() => {
    try {
      return (localStorage.getItem('intersect-theme') as Theme) || 'system';
    } catch {
      return 'system';
    }
  })(),
  setTheme: (theme) => {
    try {
      localStorage.setItem('intersect-theme', theme);
    } catch (e) {
      console.error('Failed to persist theme:', e);
    }
    set({ theme });
  },
  
  // ElevenLabs API key (for voice transcription) - persisted to localStorage
  elevenLabsApiKey: (() => {
    try {
      return localStorage.getItem('elevenlabs-api-key') || null;
    } catch {
      return null;
    }
  })(),
  setElevenLabsApiKey: (elevenLabsApiKey) => {
    try {
      if (elevenLabsApiKey) {
        localStorage.setItem('elevenlabs-api-key', elevenLabsApiKey);
      } else {
        localStorage.removeItem('elevenlabs-api-key');
      }
    } catch (e) {
      console.error('Failed to persist ElevenLabs API key:', e);
    }
    set({ elevenLabsApiKey });
  },
}));
