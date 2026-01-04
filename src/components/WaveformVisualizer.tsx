import { useEffect, useRef } from 'react';

interface WaveformVisualizerProps {
  isActive: boolean;
  mode: 'input' | 'output' | 'idle';
  color?: string;
  className?: string;
  outputAnalyser?: AnalyserNode | null; // For audio-reactive output
}

// Calculate alpha for edge fading (0 at edges, 1 in middle)
function getEdgeAlpha(x: number, width: number, fadeWidth: number = 80): number {
  if (x < fadeWidth) {
    return x / fadeWidth;
  }
  if (x > width - fadeWidth) {
    return (width - x) / fadeWidth;
  }
  return 1;
}

export function WaveformVisualizer({
  isActive,
  mode,
  color = '#94A3B8',
  className = '',
  outputAnalyser,
}: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const outputDataArrayRef = useRef<Uint8Array | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Setup audio analysis for input mode
  useEffect(() => {
    if (mode !== 'input' || !isActive) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      analyserRef.current = null;
      dataArrayRef.current = null;
      return;
    }

    const setupAudio = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;
        
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        analyserRef.current = analyser;
        
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        
        const bufferLength = analyser.frequencyBinCount;
        dataArrayRef.current = new Uint8Array(bufferLength);
      } catch (err) {
        console.error('Failed to setup audio analysis:', err);
      }
    };

    setupAudio();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, [mode, isActive]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let lastWidth = 0;
    let lastHeight = 0;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const fadeWidth = width * 0.15; // 15% fade on each edge
      
      // Resize canvas if needed
      if (width !== lastWidth || height !== lastHeight) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lastWidth = width;
        lastHeight = height;
      }
      
      ctx.clearRect(0, 0, width, height);
      
      if (!isActive) {
        // Draw idle state - flat line with subtle pulse and edge fade
        const time = Date.now() / 1000;
        
        for (let x = 0; x < width; x++) {
          const alpha = getEdgeAlpha(x, width, fadeWidth);
          const y = height / 2 + Math.sin(x * 0.02 + time * 2) * 2;
          
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.globalAlpha = alpha * 0.3;
          ctx.fill();
        }
        
        ctx.globalAlpha = 1;
        animationFrameRef.current = requestAnimationFrame(draw);
        return;
      }

      if (mode === 'input' && analyserRef.current && dataArrayRef.current) {
        analyserRef.current.getByteFrequencyData(dataArrayRef.current);
        
        // Use only the meaningful low-frequency portion (voice range)
        const usableData = dataArrayRef.current.slice(0, 32);
        const barCount = 30; // bars per side (60 total, mirrored from center)
        const centerX = width / 2;
        const barSpacing = (width / 2) / barCount;
        
        // Draw mirrored from center outward
        for (let i = 0; i < barCount; i++) {
          const dataIndex = Math.floor((i / barCount) * usableData.length);
          const value = usableData[dataIndex] / 255;
          const barHeight = value * (height / 2) * 0.8;
          
          // Right side bar
          const xRight = centerX + i * barSpacing + barSpacing / 2;
          const alphaRight = getEdgeAlpha(xRight, width, fadeWidth);
          
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          
          // Right bar (top)
          ctx.beginPath();
          ctx.moveTo(xRight, height / 2);
          ctx.lineTo(xRight, height / 2 - barHeight);
          ctx.globalAlpha = alphaRight * (0.4 + value * 0.6);
          ctx.stroke();
          
          // Right bar (bottom mirror)
          ctx.beginPath();
          ctx.moveTo(xRight, height / 2);
          ctx.lineTo(xRight, height / 2 + barHeight);
          ctx.stroke();
          
          // Left side bar (mirror)
          const xLeft = centerX - i * barSpacing - barSpacing / 2;
          const alphaLeft = getEdgeAlpha(xLeft, width, fadeWidth);
          
          // Left bar (top)
          ctx.beginPath();
          ctx.moveTo(xLeft, height / 2);
          ctx.lineTo(xLeft, height / 2 - barHeight);
          ctx.globalAlpha = alphaLeft * (0.4 + value * 0.6);
          ctx.stroke();
          
          // Left bar (bottom mirror)
          ctx.beginPath();
          ctx.moveTo(xLeft, height / 2);
          ctx.lineTo(xLeft, height / 2 + barHeight);
          ctx.stroke();
        }
        
        ctx.globalAlpha = 1;
        
      } else if (mode === 'output') {
        const time = Date.now() / 1000;
        
        // Get audio data if analyser is available
        let audioIntensity = 0.3; // Default baseline intensity
        let waveformData: Uint8Array | null = null;
        
        if (outputAnalyser) {
          // Initialize data array if needed
          if (!outputDataArrayRef.current || outputDataArrayRef.current.length !== outputAnalyser.frequencyBinCount) {
            outputDataArrayRef.current = new Uint8Array(outputAnalyser.frequencyBinCount);
          }
          
          // Get frequency data for audio reactivity
          outputAnalyser.getByteFrequencyData(outputDataArrayRef.current);
          waveformData = outputDataArrayRef.current;
          
          // Calculate overall audio intensity from low frequencies (voice range)
          const voiceRange = outputDataArrayRef.current.slice(0, 32);
          const avg = voiceRange.reduce((a, b) => a + b, 0) / voiceRange.length;
          audioIntensity = 0.2 + (avg / 255) * 0.8; // 0.2 to 1.0 range - more reactive
        }
        
        // Draw wave as segments with individual opacity for edge fade
        const segmentWidth = 3;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        // Calculate all y positions first
        const yPositions: number[] = [];
        for (let x = 0; x < width; x++) {
          const normalizedX = x / width;
          
          // Get audio-reactive amplitude for this x position
          let audioModulation = 1;
          if (waveformData) {
            const dataIndex = Math.floor(normalizedX * Math.min(waveformData.length, 64));
            audioModulation = 0.4 + (waveformData[dataIndex] / 255) * 0.6;
          }
          
          // Multiple sine waves modulated by audio
          const amplitude = audioIntensity * audioModulation;
          const y = height / 2 + 
            Math.sin(normalizedX * 10 + time * 4) * 18 * amplitude +
            Math.sin(normalizedX * 20 + time * 6) * 10 * amplitude +
            Math.sin(normalizedX * 5 + time * 2) * 6 * amplitude;
          yPositions.push(y);
        }
        
        // Draw segments with edge fade opacity
        for (let x = 0; x < width - segmentWidth; x += segmentWidth) {
          const edgeAlpha = getEdgeAlpha(x + segmentWidth / 2, width, fadeWidth);
          
          ctx.beginPath();
          ctx.moveTo(x, yPositions[x]);
          
          // Draw smooth segment
          for (let sx = 1; sx <= segmentWidth && x + sx < width; sx++) {
            const px = x + sx;
            ctx.lineTo(px, yPositions[px]);
          }
          
          ctx.strokeStyle = color;
          ctx.globalAlpha = edgeAlpha * (0.5 + audioIntensity * 0.5);
          ctx.stroke();
        }
        
        // Add glow effect with edge fade
        ctx.shadowColor = color;
        ctx.shadowBlur = 10 + audioIntensity * 15;
        
        for (let x = 0; x < width - segmentWidth; x += segmentWidth) {
          const edgeAlpha = getEdgeAlpha(x + segmentWidth / 2, width, fadeWidth);
          
          ctx.beginPath();
          ctx.moveTo(x, yPositions[x]);
          
          for (let sx = 1; sx <= segmentWidth && x + sx < width; sx++) {
            const px = x + sx;
            ctx.lineTo(px, yPositions[px]);
          }
          
          ctx.globalAlpha = edgeAlpha * 0.3 * audioIntensity;
          ctx.stroke();
        }
        
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        
      } else {
        // Idle/processing state - gentle wave with edge fade
        const time = Date.now() / 1000;
        
        for (let x = 0; x < width; x += 2) {
          const normalizedX = x / width;
          const alpha = getEdgeAlpha(x, width, fadeWidth);
          const y = height / 2 + Math.sin(normalizedX * 8 + time * 3) * 4 * alpha;
          
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.globalAlpha = alpha * 0.5;
          ctx.fill();
        }
        
        ctx.globalAlpha = 1;
      }

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    animationFrameRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isActive, mode, color, outputAnalyser]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
