import { useEffect, useRef, useCallback } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  alpha: number;
  life: number;
  maxLife: number;
}

interface ParticleSource {
  x: number;
  y: number;
  color: string;
}

interface ParticleEffectProps {
  sources: ParticleSource[];
  targetX: number;
  targetY: number;
  isActive: boolean;
  intensity?: number; // 0-1, controls particle spawn rate
  className?: string;
}

export function ParticleEffect({
  sources,
  targetX,
  targetY,
  isActive,
  intensity = 0.5,
  className = '',
}: ParticleEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationFrameRef = useRef<number>(0);
  const lastSpawnTimeRef = useRef<number>(0);

  const spawnParticle = useCallback(
    (source: ParticleSource) => {
      const angle = Math.atan2(targetY - source.y, targetX - source.x);
      const speed = 2 + Math.random() * 3;
      
      // Add some spread to the angle
      const spreadAngle = angle + (Math.random() - 0.5) * 0.5;
      
      return {
        x: source.x + (Math.random() - 0.5) * 20,
        y: source.y + (Math.random() - 0.5) * 20,
        vx: Math.cos(spreadAngle) * speed,
        vy: Math.sin(spreadAngle) * speed,
        size: 2 + Math.random() * 4,
        color: source.color,
        alpha: 0.8 + Math.random() * 0.2,
        life: 0,
        maxLife: 60 + Math.random() * 40, // frames
      };
    },
    [targetX, targetY]
  );

  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Spawn new particles
    if (isActive && sources.length > 0) {
      const now = Date.now();
      const spawnInterval = Math.max(20, 100 - intensity * 80); // 20-100ms based on intensity
      
      if (now - lastSpawnTimeRef.current > spawnInterval) {
        // Spawn from random source
        const source = sources[Math.floor(Math.random() * sources.length)];
        particlesRef.current.push(spawnParticle(source));
        lastSpawnTimeRef.current = now;
      }
    }

    // Update and draw particles
    particlesRef.current = particlesRef.current.filter((particle) => {
      particle.life++;
      
      // Move toward target with acceleration
      const dx = targetX - particle.x;
      const dy = targetY - particle.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Accelerate toward target as particle gets closer
      const accel = 0.05 + (1 - dist / 500) * 0.1;
      particle.vx += (dx / dist) * accel;
      particle.vy += (dy / dist) * accel;
      
      // Apply velocity with damping
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vx *= 0.98;
      particle.vy *= 0.98;
      
      // Fade out as life increases
      const lifeRatio = particle.life / particle.maxLife;
      particle.alpha = (1 - lifeRatio) * 0.8;
      particle.size *= 0.995;
      
      // Draw particle
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      ctx.fillStyle = particle.color;
      ctx.globalAlpha = particle.alpha;
      ctx.fill();
      
      // Draw glow
      const gradient = ctx.createRadialGradient(
        particle.x,
        particle.y,
        0,
        particle.x,
        particle.y,
        particle.size * 3
      );
      gradient.addColorStop(0, particle.color);
      gradient.addColorStop(1, 'transparent');
      ctx.fillStyle = gradient;
      ctx.globalAlpha = particle.alpha * 0.3;
      ctx.fill();
      
      ctx.globalAlpha = 1;
      
      // Remove if reached target or expired
      return dist > 30 && particle.life < particle.maxLife;
    });

    animationFrameRef.current = requestAnimationFrame(animate);
  }, [isActive, sources, targetX, targetY, intensity, spawnParticle]);

  // Handle resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Animation loop
  useEffect(() => {
    animationFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [animate]);

  // Clear particles when becoming inactive
  useEffect(() => {
    if (!isActive) {
      // Let existing particles finish their animation
      // Don't spawn new ones (handled by isActive check in animate)
    }
  }, [isActive]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none ${className}`}
      style={{ position: 'absolute', inset: 0 }}
    />
  );
}
