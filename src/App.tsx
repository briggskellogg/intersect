import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useAppStore } from './store';
import { ApiKeyModal } from './components/ApiKeyModal';
import { ChatWindow } from './components/ChatWindow';
import { Settings } from './components/Settings';
import { initApp, getUserProfile, getActivePersonaProfile, InitResult } from './hooks/useTauri';
import { AGENTS } from './constants/agents';

function App() {
  const {
    setUserProfile,
    isSettingsOpen,
    setSettingsOpen,
    setActivePersonaProfile,
  } = useAppStore();

  const [isLoading, setIsLoading] = useState(true);
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const [recoveryNeeded, setRecoveryNeeded] = useState<InitResult | null>(null);


  // Initialize app
  useEffect(() => {
    async function init() {
      try {
        const initResult = await initApp();
        
        // Check if recovery is needed from a previous crash/force-quit
        if (initResult.status === 'recovery_needed') {
          setRecoveryNeeded(initResult);
        }
        
        const profile = await getUserProfile();
        setUserProfile(profile);
        
        // Check if BOTH API keys are needed (require OpenAI AND Anthropic)
        if (!profile.apiKey || !profile.anthropicKey) {
          setNeedsApiKey(true);
        } else {
          // Load active persona profile (3 profiles are auto-created on init)
          const activePersona = await getActivePersonaProfile();
          if (activePersona) {
            setActivePersonaProfile(activePersona);
          }
        }
      } catch (err) {
        console.error('Failed to initialize:', err);
        setNeedsApiKey(true);
      } finally {
        setIsLoading(false);
      }
    }
    init();
  }, [setUserProfile, setActivePersonaProfile]);

  // Handle API key setup complete - only close if BOTH keys are present
  const handleApiKeyComplete = async () => {
    try {
      const profile = await getUserProfile();
      setUserProfile(profile);
      // Only close modal if both keys are now present
      if (profile.apiKey && profile.anthropicKey) {
        setNeedsApiKey(false);
        
        // Load active persona profile (3 profiles are auto-created on init)
        const activePersona = await getActivePersonaProfile();
        if (activePersona) {
          setActivePersonaProfile(activePersona);
        }
      }
    } catch (err) {
      console.error('Failed to get profile:', err);
    }
  };

  // Loading screen
  if (isLoading) {
    return (
      <div className="app-container flex items-center justify-center bg-ai-mesh">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center"
        >
          <div className="flex gap-4 mb-6 justify-center">
            <motion.div
              animate={{ scale: [1, 1.1, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: 0 }}
              className="w-12 h-12 rounded-full overflow-hidden border-2"
              style={{ borderColor: AGENTS.instinct.color }}
            >
              <img src={AGENTS.instinct.avatar} alt="Instinct" className="w-full h-full object-cover" />
            </motion.div>
            <motion.div
              animate={{ scale: [1, 1.1, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: 0.3 }}
              className="w-12 h-12 rounded-full overflow-hidden border-2"
              style={{ borderColor: AGENTS.logic.color }}
            >
              <img src={AGENTS.logic.avatar} alt="Logic" className="w-full h-full object-cover" />
            </motion.div>
            <motion.div
              animate={{ scale: [1, 1.1, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: 0.6 }}
              className="w-12 h-12 rounded-full overflow-hidden border-2"
              style={{ borderColor: AGENTS.psyche.color }}
            >
              <img src={AGENTS.psyche.avatar} alt="Psyche" className="w-full h-full object-cover" />
            </motion.div>
          </div>
          <p className="text-ash font-mono text-sm">Loading...</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Chat window is always visible */}
      <ChatWindow 
        onOpenSettings={() => setSettingsOpen(true)} 
        recoveryNeeded={recoveryNeeded}
        onRecoveryComplete={() => setRecoveryNeeded(null)}
      />

      {/* API Key modal overlays the chat when needed */}
      <ApiKeyModal 
        isOpen={needsApiKey} 
        onComplete={handleApiKeyComplete} 
      />

      <Settings
        isOpen={isSettingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

    </div>
  );
}

export default App;
