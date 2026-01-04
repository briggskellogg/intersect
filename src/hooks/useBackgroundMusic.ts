import { useState, useEffect, useRef, useCallback } from 'react';

interface Track {
  id: string;
  name: string;
  dataUrl: string;
}

interface UseBackgroundMusicOptions {
  tracks: Track[];
  enabled: boolean;
  volume: number;
  crossfadeDuration?: number; // in milliseconds
}

interface UseBackgroundMusicReturn {
  isPlaying: boolean;
  currentTrack: Track | null;
  start: () => void;
  stop: () => void;
}

export function useBackgroundMusic({
  tracks,
  enabled,
  volume,
  crossfadeDuration = 3000,
}: UseBackgroundMusicOptions): UseBackgroundMusicReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  
  // All refs to avoid dependency issues
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const nextAudioRef = useRef<HTMLAudioElement | null>(null);
  const fadeIntervalRef = useRef<number | null>(null);
  const shuffledTracksRef = useRef<Track[]>([]);
  const currentIndexRef = useRef(0);
  const isPlayingRef = useRef(false);
  const volumeRef = useRef(volume);
  const tracksRef = useRef(tracks);
  const crossfadeDurationRef = useRef(crossfadeDuration);
  const isStartingRef = useRef(false);
  
  // Keep refs in sync
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);
  
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);
  
  useEffect(() => {
    crossfadeDurationRef.current = crossfadeDuration;
  }, [crossfadeDuration]);

  // Shuffle array using Fisher-Yates
  const shuffleTracks = useCallback(() => {
    const shuffled = [...tracksRef.current];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffledTracksRef.current = shuffled;
    currentIndexRef.current = 0;
  }, []);

  // Get next track in shuffled order
  const getNextTrack = useCallback((): Track | null => {
    if (shuffledTracksRef.current.length === 0) return null;
    
    currentIndexRef.current++;
    if (currentIndexRef.current >= shuffledTracksRef.current.length) {
      // Reshuffle when we've played all tracks
      shuffleTracks();
    }
    
    return shuffledTracksRef.current[currentIndexRef.current] || null;
  }, [shuffleTracks]);

  // Crossfade to next track
  const crossfadeToNext = useCallback(() => {
    if (!isPlayingRef.current || shuffledTracksRef.current.length === 0) return;
    
    const nextTrack = getNextTrack();
    if (!nextTrack) return;
    
    // Create next audio element
    const nextAudio = new Audio(nextTrack.dataUrl);
    nextAudio.volume = 0;
    nextAudio.loop = false;
    nextAudioRef.current = nextAudio;
    
    // Start playing next track
    nextAudio.play().catch(console.error);
    
    const currentAudio = currentAudioRef.current;
    const duration = crossfadeDurationRef.current;
    const vol = volumeRef.current;
    const steps = duration / 50; // 50ms intervals
    const volumeStep = vol / steps;
    let step = 0;
    
    // Clear any existing fade
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
    }
    
    // Crossfade
    fadeIntervalRef.current = window.setInterval(() => {
      step++;
      
      // Fade out current
      if (currentAudio) {
        const newVol = Math.max(0, vol - (volumeStep * step));
        currentAudio.volume = newVol;
      }
      
      // Fade in next
      if (nextAudio) {
        const newVol = Math.min(vol, volumeStep * step);
        nextAudio.volume = newVol;
      }
      
      // Complete crossfade
      if (step >= steps) {
        if (fadeIntervalRef.current) {
          clearInterval(fadeIntervalRef.current);
          fadeIntervalRef.current = null;
        }
        
        // Clean up old audio
        if (currentAudio) {
          currentAudio.pause();
          currentAudio.src = '';
        }
        
        // Swap references
        currentAudioRef.current = nextAudio;
        nextAudioRef.current = null;
        setCurrentTrack(nextTrack);
        
        // Set up ended listener for next crossfade
        nextAudio.onended = crossfadeToNext;
      }
    }, 50);
  }, [getNextTrack]);

  // Stop playback
  const stop = useCallback(() => {
    // Clear fade interval
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }
    
    // Stop current audio
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.src = '';
      currentAudioRef.current = null;
    }
    
    // Stop next audio if crossfading
    if (nextAudioRef.current) {
      nextAudioRef.current.pause();
      nextAudioRef.current.src = '';
      nextAudioRef.current = null;
    }
    
    setIsPlaying(false);
    isPlayingRef.current = false;
    isStartingRef.current = false;
    setCurrentTrack(null);
  }, []);

  // Start playback
  const start = useCallback(() => {
    // Prevent multiple simultaneous starts
    if (isStartingRef.current || isPlayingRef.current) return;
    if (tracksRef.current.length === 0) return;
    
    isStartingRef.current = true;
    
    // Stop any existing playback first
    stop();
    
    // Initialize shuffle
    shuffleTracks();
    
    const track = shuffledTracksRef.current[0];
    if (!track) {
      isStartingRef.current = false;
      return;
    }
    
    // Create and start audio
    const audio = new Audio(track.dataUrl);
    audio.volume = volumeRef.current;
    audio.loop = false;
    audio.onended = crossfadeToNext;
    
    currentAudioRef.current = audio;
    setCurrentTrack(track);
    
    audio.play()
      .then(() => {
        setIsPlaying(true);
        isPlayingRef.current = true;
        isStartingRef.current = false;
      })
      .catch((err) => {
        console.error('Failed to start background music:', err);
        isStartingRef.current = false;
      });
  }, [stop, shuffleTracks, crossfadeToNext]);

  // Update volume on current playing audio
  useEffect(() => {
    if (currentAudioRef.current && !fadeIntervalRef.current) {
      currentAudioRef.current.volume = volume;
    }
  }, [volume]);

  // Handle enabled/disabled - stable effect that doesn't depend on changing callbacks
  useEffect(() => {
    if (enabled && tracksRef.current.length > 0 && !isPlayingRef.current && !isStartingRef.current) {
      // Delay start to debounce rapid track additions
      const timeoutId = setTimeout(() => {
        if (enabled && !isPlayingRef.current && !isStartingRef.current && tracksRef.current.length > 0) {
          start();
        }
      }, 300);
      return () => clearTimeout(timeoutId);
    } else if (!enabled && (isPlayingRef.current || isStartingRef.current)) {
      stop();
    }
  }, [enabled, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    isPlaying,
    currentTrack,
    start,
    stop,
  };
}
