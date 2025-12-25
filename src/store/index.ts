import { create } from 'zustand';
import { Message, UserProfile, PersonaProfile, Conversation, AgentType, AgentMode, DebateMode } from '../types';

export type Theme = 'light' | 'dark' | 'system';

interface AgentModeState {
  instinct: AgentMode;
  logic: AgentMode;
  psyche: AgentMode;
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
  
  // Agent modes (off, on, or disco per-agent)
  agentModes: AgentModeState;
  toggleAgentMode: (agent: AgentType) => void;
  toggleAllDisco: () => void;
  getActiveAgentsList: () => AgentType[];
  getDiscoAgentsList: () => AgentType[];
  isAgentActive: (agent: AgentType) => boolean;
  isAgentDisco: (agent: AgentType) => boolean;
  hasAnyDiscoAgent: () => boolean;
  
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
  
  // V2.0: Governor-centric mode
  useGovernorMode: boolean;  // Feature flag for v2 experience
  setUseGovernorMode: (use: boolean) => void;
  
  // V2.0: Current thoughts being collected (for display during thinking)
  currentThoughts: Array<{
    agent: string;
    name: string;
    content: string;
    is_disco: boolean;
  }>;
  addThought: (thought: { agent: string; name: string; content: string; is_disco: boolean }) => void;
  clearThoughts: () => void;
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
    
    // Cycle: off -> on -> disco -> off
    // But prevent turning off if it's the last active agent
    let nextMode: AgentMode;
    if (currentMode === 'off') {
      nextMode = 'on';
    } else if (currentMode === 'on') {
      nextMode = 'disco';
    } else {
      // disco -> off, but prevent if it's the last active agent
      if (activeCount <= 1) {
        nextMode = 'on'; // Can't turn off the last agent, cycle back to on
      } else {
        nextMode = 'off';
      }
    }
    
    return {
      agentModes: {
        ...state.agentModes,
        [agent]: nextMode,
      },
    };
  }),
  
  toggleAllDisco: () => set((state) => {
    const hasAnyDisco = Object.values(state.agentModes).some(m => m === 'disco');
    
    if (hasAnyDisco) {
      // Turn all disco agents back to 'on'
      return {
        agentModes: {
          instinct: state.agentModes.instinct === 'disco' ? 'on' : state.agentModes.instinct,
          logic: state.agentModes.logic === 'disco' ? 'on' : state.agentModes.logic,
          psyche: state.agentModes.psyche === 'disco' ? 'on' : state.agentModes.psyche,
        },
      };
    } else {
      // Turn all active agents to disco
      return {
        agentModes: {
          instinct: state.agentModes.instinct !== 'off' ? 'disco' : 'off',
          logic: state.agentModes.logic !== 'off' ? 'disco' : 'off',
          psyche: state.agentModes.psyche !== 'off' ? 'disco' : 'off',
        },
      };
    }
  }),
  
  getActiveAgentsList: () => {
    const state = get();
    const agents: AgentType[] = [];
    if (state.agentModes.instinct !== 'off') agents.push('instinct');
    if (state.agentModes.logic !== 'off') agents.push('logic');
    if (state.agentModes.psyche !== 'off') agents.push('psyche');
    return agents;
  },
  
  getDiscoAgentsList: () => {
    const state = get();
    const agents: AgentType[] = [];
    if (state.agentModes.instinct === 'disco') agents.push('instinct');
    if (state.agentModes.logic === 'disco') agents.push('logic');
    if (state.agentModes.psyche === 'disco') agents.push('psyche');
    return agents;
  },
  
  isAgentActive: (agent) => {
    const state = get();
    return state.agentModes[agent] !== 'off';
  },
  
  isAgentDisco: (agent) => {
    const state = get();
    return state.agentModes[agent] === 'disco';
  },
  
  hasAnyDiscoAgent: () => {
    const state = get();
    return Object.values(state.agentModes).some(m => m === 'disco');
  },
  
  // Legacy disco conversation check - now derived from agent modes
  isDiscoConversation: () => {
    const state = get();
    return Object.values(state.agentModes).some(m => m === 'disco');
  },
  
  // Legacy compatibility - computed from agentModes
  get activeAgents() {
    const state = get();
    return {
      instinct: state.agentModes.instinct !== 'off',
      logic: state.agentModes.logic !== 'off',
      psyche: state.agentModes.psyche !== 'off',
    };
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
  
  // V2.0: Governor-centric mode - persisted to localStorage
  // Default to TRUE for new installs (v2 experience)
  useGovernorMode: (() => {
    try {
      const stored = localStorage.getItem('intersect-governor-mode');
      if (stored === null) return true; // Default to v2 for new installs
      return stored === 'true';
    } catch {
      return true;
    }
  })(),
  setUseGovernorMode: (useGovernorMode) => {
    try {
      localStorage.setItem('intersect-governor-mode', String(useGovernorMode));
    } catch (e) {
      console.error('Failed to persist governor mode:', e);
    }
    set({ useGovernorMode });
  },
  
  // V2.0: Current thoughts being collected
  currentThoughts: [],
  addThought: (thought) => set((state) => ({
    currentThoughts: [...state.currentThoughts, thought],
  })),
  clearThoughts: () => set({ currentThoughts: [] }),
}));
