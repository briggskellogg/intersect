import { useEffect, useRef } from 'react';

interface WaveformVisualizerProps {
  isActive: boolean;
  mode: 'input' | 'output' | 'idle';
  color?: string;
  className?: string;
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
}: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
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
        
        // Draw smooth wave with edge fading
        ctx.beginPath();
        let lastY = height / 2;
        
        for (let x = 0; x < width; x++) {
          const normalizedX = x / width;
          const alpha = getEdgeAlpha(x, width, fadeWidth);
          
          // Multiple sine waves for organic look, modulated by edge alpha
          const amplitude = alpha;
          const y = height / 2 + 
            Math.sin(normalizedX * 10 + time * 4) * 12 * amplitude +
            Math.sin(normalizedX * 20 + time * 6) * 6 * amplitude +
            Math.sin(normalizedX * 5 + time * 2) * 4 * amplitude;
          
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            // Smooth curve
            const cpX = (x + (x - 1)) / 2;
            ctx.quadraticCurveTo(x - 1, lastY, cpX, (lastY + y) / 2);
          }
          lastY = y;
        }
        
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        
        // Subtle glow
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.globalAlpha = 0.4;
        ctx.stroke();
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
  }, [isActive, mode, color]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
