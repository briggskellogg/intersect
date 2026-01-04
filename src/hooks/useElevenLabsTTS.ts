import { useState, useCallback, useRef, useEffect } from 'react';

export interface TTSQueueItem {
  id: string;
  text: string;
  voiceId: string;
  agentType: 'instinct' | 'logic' | 'psyche' | 'governor';
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

export interface UseElevenLabsTTSOptions {
  apiKey: string | null;
  onError?: (error: Error) => void;
}

export interface UseElevenLabsTTSReturn {
  isSpeaking: boolean;
  currentSpeaker: string | null;
  queue: TTSQueueItem[];
  enqueue: (item: TTSQueueItem) => void;
  enqueueMultiple: (items: TTSQueueItem[]) => void;
  stop: () => void;
  clearQueue: () => void;
  error: string | null;
  analyser: AnalyserNode | null; // For audio-reactive visualizations
}

export function useElevenLabsTTS({
  apiKey,
  onError,
}: UseElevenLabsTTSOptions): UseElevenLabsTTSReturn {
  const [queue, setQueue] = useState<TTSQueueItem[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isProcessingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stoppedIntentionallyRef = useRef(false);
  
  // Audio analysis for visualizations
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  // Process the queue
  const processQueue = useCallback(async () => {
    if (isProcessingRef.current || queue.length === 0 || !apiKey) {
      return;
    }

    isProcessingRef.current = true;
    stoppedIntentionallyRef.current = false; // Reset for new item
    const item = queue[0];
    
    try {
      setCurrentSpeaker(item.agentType);
      setIsSpeaking(true);
      item.onStart?.();
      
      // Create abort controller for this request
      abortControllerRef.current = new AbortController();
      
      // Call ElevenLabs TTS API
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${item.voiceId}/stream`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
          },
          body: JSON.stringify({
            text: item.text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
          signal: abortControllerRef.current.signal,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`TTS API error: ${response.status} - ${errorText}`);
      }

      // Get audio blob and play
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      
      // Create and play audio with analyser for visualizations
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      
      // Setup audio context and analyser for waveform visualization
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }
      const audioContext = audioContextRef.current;
      
      // Create analyser node
      const newAnalyser = audioContext.createAnalyser();
      newAnalyser.fftSize = 256;
      newAnalyser.smoothingTimeConstant = 0.8;
      analyserRef.current = newAnalyser;
      setAnalyser(newAnalyser);
      
      // Connect audio element to analyser and output
      const source = audioContext.createMediaElementSource(audio);
      source.connect(newAnalyser);
      newAnalyser.connect(audioContext.destination);
      
      await new Promise<void>((resolve, reject) => {
        let resolved = false;
        
        audio.onended = () => {
          if (resolved) return;
          resolved = true;
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        
        // Also resolve on pause (when stopped intentionally)
        audio.onpause = () => {
          if (resolved) return;
          resolved = true;
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        
        audio.onerror = () => {
          if (resolved) return;
          resolved = true;
          URL.revokeObjectURL(audioUrl);
          // Don't show error for intentional stops
          if (audio.src === '') {
            resolve();
          } else {
            reject(new Error('Audio playback failed'));
          }
        };
        
        audio.play().catch((err) => {
          if (resolved) return;
          resolved = true;
          URL.revokeObjectURL(audioUrl);
          reject(err);
        });
      });
      
      // Item completed
      item.onEnd?.();
      
      // Remove from queue
      setQueue((prev) => prev.slice(1));
      
    } catch (err) {
      const error = err instanceof Error ? err : new Error('TTS failed');
      
      // Don't show error if stopped intentionally (space bar, abort, etc.)
      if (error.name === 'AbortError' || stoppedIntentionallyRef.current) {
        console.log('TTS playback stopped');
        // Still call onEnd for intentional stops so caller knows we're done
        item.onEnd?.();
      } else {
        console.error('TTS error:', err);
        setError(error.message);
        // Call per-item error callback
        item.onError?.(error);
        // Call global error callback
        onError?.(error);
      }
      // Remove failed item from queue
      setQueue((prev) => prev.slice(1));
    } finally {
      isProcessingRef.current = false;
      setIsSpeaking(false);
      setCurrentSpeaker(null);
      audioRef.current = null;
      abortControllerRef.current = null;
      analyserRef.current = null;
      setAnalyser(null);
    }
  }, [queue, apiKey, onError]);

  // Process queue when it changes
  useEffect(() => {
    if (queue.length > 0 && !isProcessingRef.current) {
      processQueue();
    }
  }, [queue, processQueue]);

  const enqueue = useCallback((item: TTSQueueItem) => {
    setQueue((prev) => [...prev, item]);
    setError(null);
  }, []);

  const enqueueMultiple = useCallback((items: TTSQueueItem[]) => {
    setQueue((prev) => [...prev, ...items]);
    setError(null);
  }, []);

  const stop = useCallback(() => {
    // Mark as intentionally stopped to suppress error messages
    stoppedIntentionallyRef.current = true;
    
    // Abort any in-flight request
    abortControllerRef.current?.abort();
    
    // Stop current audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    
    setIsSpeaking(false);
    setCurrentSpeaker(null);
    setError(null); // Clear any existing error
    isProcessingRef.current = false;
  }, []);

  const clearQueue = useCallback(() => {
    stop();
    setQueue([]);
  }, [stop]);

  return {
    isSpeaking,
    currentSpeaker,
    queue,
    enqueue,
    enqueueMultiple,
    stop,
    clearQueue,
    error,
    analyser,
  };
}
