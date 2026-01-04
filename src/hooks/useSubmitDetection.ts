import { useCallback, useRef, useEffect } from 'react';

export interface SubmitDetectionOptions {
  apiKey: string | null;
  onSubmitDetected: (transcript: string) => void;
  onError?: (error: Error) => void;
}

export interface SubmitDetectionReturn {
  processTranscript: (transcript: string, partialTranscript: string) => void;
  reset: () => void;
  isPendingLLM: boolean;
}

// Fast local detection - optimized for instant response
function detectSubmit(text: string): boolean {
  const lower = text.toLowerCase().trim();
  
  // Must contain "submit" somewhere
  if (!lower.includes('submit')) {
    return false;
  }
  
  // Fast path: ends with "submit" (with optional punctuation/whitespace)
  if (/submit[.!?,\s]*$/.test(lower)) {
    // Check it's NOT part of a phrase like "submit a", "submit the", etc.
    const beforeSubmit = lower.slice(0, lower.lastIndexOf('submit')).trim();
    
    // If "submit" is preceded by "to", "will", "can", "should", "must" - it's in-sentence
    if (/\b(to|will|can|should|must|could|would|want to|going to|need to)\s*$/.test(beforeSubmit)) {
      return false;
    }
    
    return true;
  }
  
  // Check for in-sentence patterns (definitely not a command)
  const inSentencePatterns = [
    /submit\s+(a|the|my|your|this|that|it|an)\b/i,
    /submitted/i,
    /submitting/i,
    /submission/i,
  ];
  
  for (const pattern of inSentencePatterns) {
    if (pattern.test(lower)) {
      return false;
    }
  }
  
  return false;
}

export function useSubmitDetection({
  onSubmitDetected,
}: SubmitDetectionOptions): SubmitDetectionReturn {
  const lastTextRef = useRef<string>('');
  const submitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasTriggeredRef = useRef(false);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (submitTimerRef.current) clearTimeout(submitTimerRef.current);
    };
  }, []);

  const processTranscript = useCallback(
    (transcript: string, partialTranscript: string) => {
      const fullText = `${transcript} ${partialTranscript}`.trim();
      
      // Skip if already triggered or same text
      if (hasTriggeredRef.current || fullText === lastTextRef.current) {
        return;
      }
      lastTextRef.current = fullText;

      // Clear any pending timer
      if (submitTimerRef.current) {
        clearTimeout(submitTimerRef.current);
        submitTimerRef.current = null;
      }

      // Check for submit immediately
      if (detectSubmit(fullText)) {
        // Very short confirmation delay - just enough to catch continued speech
        submitTimerRef.current = setTimeout(() => {
          if (hasTriggeredRef.current) return;
          hasTriggeredRef.current = true;
          
          // Clean the transcript - remove "submit" from the end
          const cleanTranscript = transcript
            .replace(/\s*submit[.!?,\s]*$/i, '')
            .trim();
          
          onSubmitDetected(cleanTranscript || transcript);
        }, 150); // 150ms - fast enough to feel instant, long enough to catch "submit a..."
      }
    },
    [onSubmitDetected]
  );

  const reset = useCallback(() => {
    lastTextRef.current = '';
    hasTriggeredRef.current = false;
    if (submitTimerRef.current) {
      clearTimeout(submitTimerRef.current);
      submitTimerRef.current = null;
    }
  }, []);

  return {
    processTranscript,
    reset,
    isPendingLLM: false, // No longer using LLM for speed
  };
}
