import { useEffect } from 'react';
import { User } from './icons';
import { useAppStore } from '../store';
import { 
  getAllPersonaProfiles, 
  getActivePersonaProfile,
} from '../hooks/useTauri';

interface ProfileSwitcherProps {
  onOpenProfileModal: () => void;
}

export function ProfileSwitcher({ onOpenProfileModal }: ProfileSwitcherProps) {
  const { activePersonaProfile, setAllPersonaProfiles, setActivePersonaProfile } = useAppStore();

  // Load profiles on mount
  useEffect(() => {
    async function loadProfiles() {
      try {
        const profiles = await getAllPersonaProfiles();
        setAllPersonaProfiles(profiles);
        
        // If we don't have an active profile set, get it
        if (!activePersonaProfile && profiles.length > 0) {
          const active = await getActivePersonaProfile();
          if (active) {
            setActivePersonaProfile(active);
          }
        }
      } catch (err) {
        console.error('Failed to load profiles:', err);
      }
    }
    loadProfiles();
  }, [setAllPersonaProfiles, setActivePersonaProfile, activePersonaProfile]);

  const getTraitColor = (trait: string) => {
    switch (trait) {
      case 'logic': return '#00D4FF';
      case 'instinct': return '#EF4444';
      case 'psyche': return '#E040FB';
      default: return '#888';
    }
  };

  if (!activePersonaProfile) {
    return null;
  }

  return (
    <button
      onClick={onOpenProfileModal}
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-ash hover:text-pearl hover:bg-smoke/20 transition-all cursor-pointer group"
      title="Profile (⌘P)"
    >
      <User className="w-4 h-4" strokeWidth={1.5} />
      <span 
        className="text-xs font-sans max-w-[100px] truncate"
        style={{ color: getTraitColor(activePersonaProfile.dominantTrait) }}
      >
        {activePersonaProfile.name}
      </span>
      <kbd className="p-1 bg-smoke/30 rounded text-[10px] font-sans text-ash/60 border border-smoke/40 leading-none aspect-square flex items-center justify-center">⌘P</kbd>
    </button>
  );
}
