import React, { Suspense, useState, useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { StarField } from './StarField';
import { ParticleGlobe } from './ParticleGlobe';
import { NeuralNetwork } from './NeuralNetwork';
import { type PeppaNode, type PeppaConnection } from './mockData';

interface NexusGlobeProps {
  theme: 'celestial' | 'nebula' | 'cyber';
  syncRate: number;
}

const THEME_COLORS: Record<string, { primary: string; accent: string }> = {
  celestial: { primary: '#ffcc00', accent: '#ffffff' },
  nebula: { primary: '#a855f7', accent: '#e2b0ff' },
  cyber: { primary: '#10b981', accent: '#a7f3d0' },
};

function hashLat(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h) + id.charCodeAt(i);
  return (Math.abs(h) % 160) - 80;
}

function hashLng(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h) + (id.charCodeAt(i) || 0);
  return (Math.abs(h) % 360) - 180;
}

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center w-full h-full">
      <div className="text-white/45 text-xs font-mono animate-pulse">INITIALIZING NEXUS...</div>
    </div>
  );
}

export function NexusGlobe({ theme, syncRate }: NexusGlobeProps) {
  const colors = THEME_COLORS[theme] || THEME_COLORS.celestial;
  const [agents, setAgents] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.ok ? r.json() : [])
      .then(d => setAgents(Array.isArray(d) ? d : d.agents || []))
      .catch(() => {});
  }, []);

  const { nodes, connections } = useMemo(() => {
    if (agents.length === 0) return { nodes: undefined, connections: undefined };

    const nodes: PeppaNode[] = agents.map(a => ({
      id: a.id,
      lat: hashLat(a.id),
      lng: hashLng(a.id),
      altitude: 0.02 + Math.random() * 0.1,
      label: a.name,
      active: a.status === 'active',
    }));

    // Connections: agents sharing the same personality get linked
    const connections: PeppaConnection[] = [];
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        if (agents[i].personalityId === agents[j].personalityId && agents[i].personalityId) {
          connections.push({
            from: agents[i].id,
            to: agents[j].id,
            bandwidth: 0.4 + Math.random() * 0.3,
          });
        }
      }
    }
    // If no shared-personality connections, link by category
    if (connections.length === 0) {
      for (let i = 0; i < Math.min(agents.length, 8); i++) {
        const j = (i + 1) % agents.length;
        connections.push({ from: agents[i].id, to: agents[j].id, bandwidth: 0.3 });
      }
    }

    return { nodes, connections };
  }, [agents]);

  return (
    <div className="w-full h-full">
      <Suspense fallback={<LoadingFallback />}>
        <Canvas
          dpr={[1, 1.5]}
          gl={{ antialias: true, alpha: true }}
          camera={{ position: [0, 0.6, 5.5], fov: 42, near: 0.1, far: 80 }}
          style={{ background: 'transparent' }}
        >
          <OrbitControls
            enablePan={false}
            enableZoom={true}
            minDistance={3.2}
            maxDistance={9}
            autoRotate={true}
            autoRotateSpeed={0.25 * syncRate}
            maxPolarAngle={Math.PI * 0.75}
            minPolarAngle={Math.PI * 0.25}
          />

          <StarField color={colors.primary} syncRate={syncRate} />
          <ParticleGlobe color={colors.primary} syncRate={syncRate} />
          <NeuralNetwork
            color={colors.primary}
            syncRate={syncRate}
            accentColor={colors.accent}
            nodes={nodes}
            connections={connections}
          />
        </Canvas>
      </Suspense>
    </div>
  );
}
