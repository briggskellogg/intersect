import { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useAppStore, loadBackgroundMusicFromTauri } from './store';
import { ApiKeyModal } from './components/ApiKeyModal';
import { ChatWindow } from './components/ChatWindow';
import { Settings } from './components/Settings';
import { initApp, getUserProfile, getActivePersonaProfile, InitResult } from './hooks/useTauri';
import governorLoadingVideo from './assets/governor-loading.mp4';

// Floating particle for loading screen
interface LoadingParticle {
  id: number;
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  opacity: number;
  hue: number;
}

// Loading screen particle canvas
function LoadingParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<LoadingParticle[]>([]);
  const animationRef = useRef<number>(0);
  const centerRef = useRef({ x: 0, y: 0 });

  const initParticles = useCallback((width: number, height: number) => {
    const particles: LoadingParticle[] = [];
    const centerX = width / 2;
    const centerY = height / 2;
    centerRef.current = { x: centerX, y: centerY };

    for (let i = 0; i < 60; i++) {
      // Spawn particles in a ring around the center
      const angle = Math.random() * Math.PI * 2;
      const distance = 80 + Math.random() * 150;
      particles.push({
        id: i,
        x: centerX + Math.cos(angle) * distance,
        y: centerY + Math.sin(angle) * distance,
        size: 1 + Math.random() * 2.5,
        speedX: (Math.random() - 0.5) * 0.3,
        speedY: (Math.random() - 0.5) * 0.3,
        opacity: 0.2 + Math.random() * 0.5,
        hue: 200 + Math.random() * 40, // Blue-cyan range
      });
    }
    particlesRef.current = particles;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initParticles(canvas.width, canvas.height);
    };

    resize();
    window.addEventListener('resize', resize);

    let time = 0;
    const animate = () => {
      time += 0.01;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const { x: cx, y: cy } = centerRef.current;

      particlesRef.current.forEach((p) => {
        // Gentle orbital motion
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        
        // Slow orbital drift
        const orbitSpeed = 0.002 / (dist / 100);
        const newAngle = angle + orbitSpeed;
        
        // Slight breathing in distance
        const breathe = Math.sin(time + p.id * 0.1) * 2;
        
        p.x = cx + Math.cos(newAngle) * (dist + breathe) + p.speedX;
        p.y = cy + Math.sin(newAngle) * (dist + breathe) + p.speedY;

        // Draw particle with glow
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3);
        gradient.addColorStop(0, `hsla(${p.hue}, 70%, 60%, ${p.opacity})`);
        gradient.addColorStop(0.5, `hsla(${p.hue}, 70%, 50%, ${p.opacity * 0.3})`);
        gradient.addColorStop(1, `hsla(${p.hue}, 70%, 40%, 0)`);

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Core
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 80%, 80%, ${p.opacity})`;
        ctx.fill();
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationRef.current);
    };
  }, [initParticles]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ width: '100%', height: '100%' }}
    />
  );
}

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

  // Loading screen - immersive with particles and circular Governor
  if (isLoading) {
    return (
      <div className="app-container flex items-center justify-center overflow-hidden"
        style={{
          background: 'radial-gradient(ellipse 80% 60% at 50% 50%, #0a1628 0%, #050a14 50%, #020408 100%)',
        }}
      >
        {/* Particle field */}
        <LoadingParticles />

        {/* Main Governor container - everything centered here */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.25, 0.1, 0.25, 1] }}
          className="relative flex items-center justify-center z-10"
        >
          {/* Outer glow rings - centered on video */}
          {[0, 1, 2].map((i) => {
            const size = 280 + i * 60;
            return (
              <motion.div
                key={i}
                className="absolute rounded-full"
                style={{
                  width: size,
                  height: size,
                  background: `radial-gradient(circle, transparent 40%, rgba(59, 130, 246, ${0.08 - i * 0.02}) 60%, transparent 80%)`,
                }}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{
                  opacity: [0.6, 1, 0.6],
                  scale: [1, 1.05, 1],
                }}
                transition={{
                  duration: 4 + i * 0.5,
                  repeat: Infinity,
                  ease: 'easeInOut',
                  delay: i * 0.3,
                }}
              />
            );
          })}

          {/* Spinning ethereal ring - centered */}
          <motion.div
            className="absolute rounded-full"
            style={{
              width: 220,
              height: 220,
              background: 'conic-gradient(from 0deg, transparent 0%, rgba(59, 130, 246, 0.3) 25%, transparent 50%, rgba(147, 51, 234, 0.2) 75%, transparent 100%)',
              filter: 'blur(8px)',
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 12, repeat: Infinity, ease: 'linear' }}
          />

          {/* Inner glow - centered */}
          <motion.div
            className="absolute rounded-full"
            style={{
              width: 200,
              height: 200,
              background: 'radial-gradient(circle, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.05) 50%, transparent 70%)',
            }}
            animate={{
              scale: [1, 1.1, 1],
              opacity: [0.5, 0.8, 0.5],
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />

          {/* Circular video container with glow border */}
          <div className="relative">
            {/* Animated border glow */}
            <motion.div
              className="absolute -inset-1 rounded-full"
              style={{
                background: 'conic-gradient(from 0deg, #3B82F6 0%, #8B5CF6 25%, #3B82F6 50%, #06B6D4 75%, #3B82F6 100%)',
                filter: 'blur(4px)',
              }}
              animate={{ rotate: -360 }}
              transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
            />
            
            {/* Dark inner ring */}
            <div className="absolute inset-0.5 rounded-full bg-[#0a0e18]" />

            {/* Governor video */}
            <div 
              className="relative w-48 h-48 rounded-full overflow-hidden"
              style={{
                boxShadow: '0 0 40px rgba(59, 130, 246, 0.3), inset 0 0 20px rgba(0, 0, 0, 0.5)',
              }}
            >
              <video
                src={governorLoadingVideo}
                autoPlay
                loop
                muted
                playsInline
                className="w-full h-full object-cover scale-110"
              />
              
              {/* Subtle inner vignette */}
              <div 
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                  background: 'radial-gradient(circle, transparent 50%, rgba(5, 10, 20, 0.4) 100%)',
                }}
              />
            </div>
          </div>

        </motion.div>

        {/* Subtle radial vignette */}
        <div 
          className="absolute inset-0 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse 60% 50% at 50% 50%, transparent 0%, rgba(2, 4, 8, 0.6) 100%)',
          }}
        />
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
