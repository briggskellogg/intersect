import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useAppStore } from './store';
import { ApiKeyModal } from './components/ApiKeyModal';
import { ChatWindow } from './components/ChatWindow';
import { Settings } from './components/Settings';
import { ReportModal } from './components/ReportModal';
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
  const [isReportOpen, setReportOpen] = useState(false);
  const [showApiModalFromReport, setShowApiModalFromReport] = useState(false);
  const [recoveryNeeded, setRecoveryNeeded] = useState<InitResult | null>(null);

  // Open report modal (closes settings first)
  const handleOpenReport = () => {
    setSettingsOpen(false);
    setReportOpen(true);
  };

  // Initialize app
  useEffect(() => {
    async function init() {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'App.tsx:init-start',message:'Init started',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      try {
        const initResult = await initApp();
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'App.tsx:after-initApp',message:'initApp completed',data:{initResult},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        // Check if recovery is needed from a previous crash/force-quit
        if (initResult.status === 'recovery_needed') {
          setRecoveryNeeded(initResult);
        }
        
        const profile = await getUserProfile();
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'App.tsx:after-getUserProfile',message:'getUserProfile completed',data:{hasApiKey:!!profile.apiKey,hasAnthropicKey:!!profile.anthropicKey},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        setUserProfile(profile);
        
        // Check if BOTH API keys are needed (require OpenAI AND Anthropic)
        if (!profile.apiKey || !profile.anthropicKey) {
          setNeedsApiKey(true);
        } else {
          // Load active persona profile (3 profiles are auto-created on init)
          const activePersona = await getActivePersonaProfile();
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'App.tsx:after-getActivePersona',message:'getActivePersonaProfile completed',data:{hasPersona:!!activePersona},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          if (activePersona) {
            setActivePersonaProfile(activePersona);
          }
        }
      } catch (err) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'App.tsx:init-error',message:'Init error',data:{error:String(err)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        console.error('Failed to initialize:', err);
        setNeedsApiKey(true);
      } finally {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/962f7550-5ed1-4eac-a6be-f678c82650b8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'App.tsx:init-finally',message:'Init finally block',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
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
        onOpenReport={handleOpenReport}
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

      <ReportModal
        isOpen={isReportOpen}
        onClose={() => setReportOpen(false)}
        onOpenApiModal={() => setShowApiModalFromReport(true)}
      />

      {/* API Key modal from Report */}
      <ApiKeyModal 
        isOpen={showApiModalFromReport} 
        onComplete={() => {
          setShowApiModalFromReport(false);
          handleApiKeyComplete();
        }}
      />
    </div>
  );
}

export default App;
