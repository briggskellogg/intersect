import { create } from 'zustand';
import { Message, UserProfile, PersonaProfile, Conversation, AgentType, DebateMode } from '../types';
import { getBackgroundTracks, saveBackgroundTrack, deleteBackgroundTrack, getBackgroundTrackData } from '../hooks/useTauri';

// Track with loaded data URL for playback
export interface LoadedTrack {
  id: string;
  name: string;
  dataUrl: string;
}

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
  
  // Immersive mode
  isImmersiveMode: boolean;
  setImmersiveMode: (immersive: boolean) => void;
  
  // Immersive mode voice settings (ElevenLabs voice IDs)
  immersiveVoices: {
    instinct: string | null;
    logic: string | null;
    psyche: string | null;
    governor: string | null;
    thoughtsDisco: string | null;
  };
  setImmersiveVoice: (agent: 'instinct' | 'logic' | 'psyche' | 'governor' | 'thoughtsDisco', voiceId: string | null) => void;
  
  // Immersive mode turn state
  immersiveTurn: 'user' | 'ai';
  setImmersiveTurn: (turn: 'user' | 'ai') => void;
  
  // Thoughts voice mute state
  isThoughtsMuted: boolean;
  toggleThoughtsMuted: () => void;
  
  // Last immersive conversation for export
  lastImmersiveConversationId: string | null;
  setLastImmersiveConversationId: (id: string | null) => void;
  lastImmersiveMessages: Message[];
  setLastImmersiveMessages: (messages: Message[]) => void;
  
  // Background music for immersive mode (tracks with loaded dataUrls)
  backgroundMusic: LoadedTrack[];
  setBackgroundMusic: (tracks: LoadedTrack[]) => void;
  addBackgroundMusicTrack: (track: LoadedTrack) => void;
  removeBackgroundMusicTrack: (id: string) => void;
  backgroundMusicEnabled: boolean;
  setBackgroundMusicEnabled: (enabled: boolean) => void;
  backgroundMusicVolume: number;
  setBackgroundMusicVolume: (volume: number) => void;
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
  
  // Immersive mode
  isImmersiveMode: false,
  setImmersiveMode: (isImmersiveMode) => set({ isImmersiveMode }),
  
  // Immersive mode voice settings - persisted to localStorage
  immersiveVoices: (() => {
    try {
      const stored = localStorage.getItem('immersive-voices');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {
      // ignore
    }
    return {
      instinct: null,
      logic: null,
      psyche: null,
      governor: null,
      thoughtsDisco: null,
    };
  })(),
  setImmersiveVoice: (agent, voiceId) => {
    set((state) => {
      const newVoices = {
        ...state.immersiveVoices,
        [agent]: voiceId,
      };
      try {
        localStorage.setItem('immersive-voices', JSON.stringify(newVoices));
      } catch (e) {
        console.error('Failed to persist immersive voices:', e);
      }
      return { immersiveVoices: newVoices };
    });
  },
  
  // Immersive mode turn state
  immersiveTurn: 'user',
  setImmersiveTurn: (immersiveTurn) => set({ immersiveTurn }),
  
  // Thoughts voice mute state
  isThoughtsMuted: false,
  toggleThoughtsMuted: () => set((state) => ({ isThoughtsMuted: !state.isThoughtsMuted })),
  
  // Last immersive conversation for export
  lastImmersiveConversationId: null,
  setLastImmersiveConversationId: (id) => set({ lastImmersiveConversationId: id }),
  lastImmersiveMessages: [],
  setLastImmersiveMessages: (messages) => set({ lastImmersiveMessages: messages }),
  
  // Background music for immersive mode - persisted to Tauri app data
  // Tracks are loaded asynchronously on app init via loadBackgroundMusicFromTauri()
  backgroundMusic: [],
  setBackgroundMusic: (tracks) => set({ backgroundMusic: tracks }),
  addBackgroundMusicTrack: (track) => {
    set((state) => {
      if (state.backgroundMusic.length >= 10) {
        console.warn('Maximum 10 tracks allowed');
        return state;
      }
      return { backgroundMusic: [...state.backgroundMusic, track] };
    });
  },
  removeBackgroundMusicTrack: (id) => {
    set((state) => ({
      backgroundMusic: state.backgroundMusic.filter(t => t.id !== id)
    }));
  },
  backgroundMusicEnabled: (() => {
    try {
      return localStorage.getItem('immersive-music-enabled') === 'true';
    } catch {
      return false;
    }
  })(),
  setBackgroundMusicEnabled: (enabled) => {
    try {
      localStorage.setItem('immersive-music-enabled', String(enabled));
    } catch (e) {
      console.error('Failed to persist music enabled:', e);
    }
    set({ backgroundMusicEnabled: enabled });
  },
  backgroundMusicVolume: (() => {
    try {
      const stored = localStorage.getItem('immersive-music-volume');
      return stored ? parseFloat(stored) : 0.3;
    } catch {
      return 0.3;
    }
  })(),
  setBackgroundMusicVolume: (volume) => {
    try {
      localStorage.setItem('immersive-music-volume', String(volume));
    } catch (e) {
      console.error('Failed to persist music volume:', e);
    }
    set({ backgroundMusicVolume: volume });
  },
}));

// ============ Background Music Async Helpers ============

/**
 * Load all background music tracks from Tauri storage.
 * Call this on app initialization.
 */
export async function loadBackgroundMusicFromTauri(): Promise<void> {
  try {
    const tracks = await getBackgroundTracks();
    const loadedTracks: LoadedTrack[] = [];
    
    // Load data URLs for each track
    for (const track of tracks) {
      const dataUrl = await getBackgroundTrackData(track.id);
      if (dataUrl) {
        loadedTracks.push({
          id: track.id,
          name: track.name,
          dataUrl,
        });
      }
    }
    
    useAppStore.getState().setBackgroundMusic(loadedTracks);
  } catch (err) {
    console.error('Failed to load background music from Tauri:', err);
  }
}

/**
 * Add a new background music track.
 * Saves to Tauri storage and updates the store.
 */
export async function addBackgroundMusic(id: string, name: string, dataUrl: string): Promise<boolean> {
  const state = useAppStore.getState();
  if (state.backgroundMusic.length >= 10) {
    console.warn('Maximum 10 tracks allowed');
    return false;
  }
  
  try {
    await saveBackgroundTrack(id, name, dataUrl);
    state.addBackgroundMusicTrack({ id, name, dataUrl });
    return true;
  } catch (err) {
    console.error('Failed to save background track:', err);
    return false;
  }
}

/**
 * Remove a background music track.
 * Deletes from Tauri storage and updates the store.
 */
export async function removeBackgroundMusic(id: string): Promise<void> {
  try {
    await deleteBackgroundTrack(id);
    useAppStore.getState().removeBackgroundMusicTrack(id);
  } catch (err) {
    console.error('Failed to remove background track:', err);
  }
}
