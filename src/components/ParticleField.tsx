import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  size: number;
  opacity: number;
  speedY: number;
  speedX: number;
  drift: number;
  driftSpeed: number;
  blur: number;
}

interface ParticleFieldProps {
  particleCount?: number;
  speed?: number;        // Speed multiplier (default 1.0)
  color?: string;        // CSS color string (default undefined = auto)
  className?: string;
}

export function ParticleField({ 
  particleCount = 40,
  speed = 1.0,
  color,
  className = '' 
}: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationFrameRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let width = 0;
    let height = 0;

    // Initialize particles
    const initParticles = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      particlesRef.current = [];
      for (let i = 0; i < particleCount; i++) {
        particlesRef.current.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: 0.5 + Math.random() * 1.5, // 0.5-2px
          opacity: 0.1 + Math.random() * 0.25, // 0.1-0.35
          speedY: (-0.05 - Math.random() * 0.15) * speed, // Slow upward drift, scaled by speed
          speedX: 0,
          drift: Math.random() * Math.PI * 2, // Phase offset for horizontal sway
          driftSpeed: (0.0005 + Math.random() * 0.001) * speed, // Very slow sway, scaled by speed
          blur: Math.random() > 0.7 ? 1 : 0, // 30% are slightly blurred (depth)
        });
      }
    };

    initParticles();

    // Handle resize
    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width !== width || rect.height !== height) {
        width = rect.width;
        height = rect.height;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

    window.addEventListener('resize', handleResize);

    // Animation loop
    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      particlesRef.current.forEach((particle) => {
        // Update position
        particle.drift += particle.driftSpeed;
        particle.speedX = Math.sin(particle.drift) * 0.1; // Gentle horizontal sway
        
        particle.x += particle.speedX;
        particle.y += particle.speedY;

        // Wrap around
        if (particle.y < -10) {
          particle.y = height + 10;
          particle.x = Math.random() * width;
        }
        if (particle.x < -10) particle.x = width + 10;
        if (particle.x > width + 10) particle.x = -10;

        // Draw particle
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        
        // Use provided color or default to slight color variation - warm whites to cool grays
        if (color) {
          ctx.fillStyle = color;
        } else {
          const colorVariant = Math.random() > 0.5 ? '200, 210, 220' : '180, 175, 190';
          ctx.fillStyle = `rgba(${colorVariant}, ${particle.opacity})`;
        }
        
        if (particle.blur > 0) {
          ctx.shadowBlur = particle.blur;
          ctx.shadowColor = `rgba(200, 200, 220, ${particle.opacity * 0.5})`;
        } else {
          ctx.shadowBlur = 0;
        }
        
        ctx.fill();
      });

      ctx.shadowBlur = 0;
      animationFrameRef.current = requestAnimationFrame(draw);
    };

    animationFrameRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [particleCount, speed, color]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 pointer-events-none rounded-xl ${className}`}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
