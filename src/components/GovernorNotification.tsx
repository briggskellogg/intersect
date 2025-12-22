import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { GOVERNOR } from '../constants/agents';

interface GovernorNotificationProps {
  message: string;
  isVisible: boolean;
  onDismiss: () => void;
}

export function GovernorNotification({ message, isVisible, onDismiss }: GovernorNotificationProps) {
  const [phase, setPhase] = useState<'thinking' | 'showing'>('thinking');

  useEffect(() => {
    if (!isVisible) {
      setPhase('thinking');
      return;
    }

    // Governor thinks for 1.5 seconds
    const thinkingTimer = setTimeout(() => {
      setPhase('showing');
    }, 1500);

    return () => clearTimeout(thinkingTimer);
  }, [isVisible]);

  useEffect(() => {
    if (phase !== 'showing') return;

    // Auto-dismiss after 4 seconds
    const dismissTimer = setTimeout(() => {
      onDismiss();
    }, 4000);

    return () => clearTimeout(dismissTimer);
  }, [phase, onDismiss]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed top-16 right-4 z-50 max-w-xs"
        >
          <div 
            className="bg-obsidian/95 backdrop-blur-xl border border-smoke/50 rounded-xl shadow-2xl overflow-hidden"
          >
            {/* Header with Governor avatar */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-smoke/30">
              <div 
                className="w-6 h-6 rounded-full overflow-hidden"
                style={{ boxShadow: `0 0 8px ${GOVERNOR.color}66` }}
              >
                <img 
                  src={GOVERNOR.avatar} 
                  alt={GOVERNOR.name}
                  className="w-full h-full object-cover"
                />
              </div>
              <span 
                className="text-xs font-sans font-medium"
                style={{ color: GOVERNOR.color }}
              >
                {GOVERNOR.name}
              </span>
              {phase === 'thinking' && (
                <div className="flex items-center gap-1 ml-auto">
                  {[0, 1, 2].map((i) => (
                    <motion.div
                      key={i}
                      className="w-1 h-1 rounded-full"
                      style={{ backgroundColor: GOVERNOR.color }}
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
                    />
                  ))}
                </div>
              )}
              {phase === 'showing' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismiss();
                  }}
                  className="ml-auto p-0.5 rounded text-ash/50 hover:text-ash transition-colors"
                >
                  <X className="w-3 h-3" strokeWidth={2} />
                </button>
              )}
            </div>

            {/* Content */}
            <div className="px-3 py-2">
              {phase === 'thinking' ? (
                <p className="text-[11px] text-ash/60 font-mono">Thinking...</p>
              ) : (
                <p className="text-[11px] text-pearl/90 font-mono leading-relaxed">
                  {message}
                </p>
              )}
            </div>

            {/* Progress bar for auto-dismiss */}
            {phase === 'showing' && (
              <motion.div
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: 4, ease: 'linear' }}
                className="h-0.5 origin-left"
                style={{ backgroundColor: GOVERNOR.color }}
              />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

