import { useState, useCallback } from 'react'
import { useScribe, CommitStrategy, type ScribeStatus } from '@elevenlabs/react'
import { fetchToken } from '../lib/token'

export interface UseScribeTranscriptionOptions {
  apiKey: string
  onError?: (error: Error) => void
}

export interface UseScribeTranscriptionReturn {
  status: ScribeStatus
  isConnected: boolean
  isTranscribing: boolean
  transcript: string
  partialTranscript: string
  error: string | null
  start: () => Promise<void>
  stop: () => void
  clearTranscript: () => void
}

export function useScribeTranscription({
  apiKey,
  onError,
}: UseScribeTranscriptionOptions): UseScribeTranscriptionReturn {
  const [segments, setSegments] = useState<string[]>([])
  const [tokenError, setTokenError] = useState<string | null>(null)
  // Track processed texts to prevent duplicates from multiple callbacks
  const [processedTexts] = useState(() => new Set<string>())

  const scribe = useScribe({
    modelId: 'scribe_v2_realtime',
    languageCode: 'en',
    includeTimestamps: true,
    // VAD-based commit for natural sentence boundaries with punctuation
    commitStrategy: CommitStrategy.VAD,
    vadSilenceThresholdSecs: 1.0, // Wait for 1 second pause to commit
    vadThreshold: 0.5, // Standard threshold for voice detection
    minSpeechDurationMs: 100, // Quick response
    minSilenceDurationMs: 300, // Standard silence
    microphone: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    onCommittedTranscriptWithTimestamps: (data) => {
      const text = data.text.trim()
      if (!text) return
      
      // Create a unique key for this segment to prevent duplicates
      const firstWord = data.words?.[0] as { start?: number } | undefined
      const segmentKey = `${text}-${firstWord?.start || Date.now()}`
      if (processedTexts.has(segmentKey)) return
      processedTexts.add(segmentKey)

      setSegments(prev => [...prev, text])
    },
    onPartialTranscript: () => {
      // For partial transcripts, we track via scribe.partialTranscript
    },
    onError: (error) => {
      console.error('Scribe error:', error)
      if (onError && error instanceof Error) {
        onError(error)
      }
    },
    onAuthError: (data) => {
      console.error('Auth error:', data.error)
      setTokenError(data.error)
    },
    onQuotaExceededError: (data) => {
      console.error('Quota exceeded:', data.error)
      setTokenError('Quota exceeded. Please check your ElevenLabs plan.')
    },
    onDisconnect: () => {
      console.log('Scribe disconnected')
    },
  })

  // Compute full transcript from segments
  const transcript = segments.join(' ')

  const start = useCallback(async () => {
    if (!apiKey) {
      console.error('No API key provided')
      setTokenError('API key is required')
      throw new Error('API key is required')
    }

    setTokenError(null)

    try {
      console.log('Fetching token with API key...')
      const token = await fetchToken(apiKey)
      console.log('Token received, connecting to scribe...')
      await scribe.connect({ token })
      console.log('Scribe connected, status:', scribe.status)
    } catch (error) {
      console.error('Start transcription error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to start transcription'
      setTokenError(errorMessage)
      if (onError && error instanceof Error) {
        onError(error)
      }
      throw error
    }
  }, [apiKey, scribe, onError])

  const stop = useCallback(() => {
    // Commit any partial transcript as a final segment before stopping
    const partial = scribe.partialTranscript?.trim()
    if (partial) {
      const segmentKey = `${partial}-stop-${Date.now()}`
      if (!processedTexts.has(segmentKey)) {
        processedTexts.add(segmentKey)
        setSegments(prev => [...prev, partial])
      }
      scribe.clearTranscripts()
    }
    scribe.disconnect()
  }, [scribe, processedTexts])

  const clearTranscript = useCallback(() => {
    setSegments([])
    processedTexts.clear()
    scribe.clearTranscripts()
    setTokenError(null)
  }, [scribe, processedTexts])

  // Combine errors
  const combinedError = tokenError || scribe.error

  return {
    status: scribe.status,
    isConnected: scribe.isConnected,
    isTranscribing: scribe.isTranscribing,
    transcript,
    partialTranscript: scribe.partialTranscript,
    error: combinedError,
    start,
    stop,
    clearTranscript,
  }
}

