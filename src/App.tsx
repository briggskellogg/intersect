import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useAppStore, loadBackgroundMusicFromTauri } from './store';
import { ApiKeyModal } from './components/ApiKeyModal';
import { ChatWindow } from './components/ChatWindow';
import { Settings } from './components/Settings';
import { initApp, getUserProfile, getActivePersonaProfile, InitResult } from './hooks/useTauri';
import { GOVERNOR } from './constants/agents';
import governorIcon from './assets/governor.png';

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
        
        // Load background music tracks from Tauri storage
        await loadBackgroundMusicFromTauri();
        
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

  // Loading screen - clean, minimal
  if (isLoading) {
    return (
      <div className="app-container flex items-center justify-center bg-void">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-6"
        >
          {/* Governor icon with subtle glow */}
          <div className="relative">
            <motion.div
              className="w-16 h-16 rounded-full overflow-hidden"
              animate={{ opacity: [0.6, 1, 0.6] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            >
              <img src={governorIcon} alt="Governor" className="w-full h-full object-cover" />
            </motion.div>
            {/* Subtle ring */}
            <motion.div
              className="absolute inset-[-4px] rounded-full border"
              style={{ borderColor: `${GOVERNOR.color}40` }}
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>
          
          {/* Minimal loading dots */}
          <div className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="w-1 h-1 rounded-full bg-ash/50"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
              />
            ))}
          </div>
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
