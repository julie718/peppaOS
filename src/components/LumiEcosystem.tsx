import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Rocket, Sparkles, Zap, Shield, Cpu, Globe, Users, Database, ShoppingBag, Ghost, ShieldCheck, ShoppingCart, Network, Share2, Link } from 'lucide-react';
import { Button } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { GlassCard, IconBox, PulseCounter } from './SharedUI';

const SPIRITS = [
  { id: 1, name: 'Research Core', price: '2.5 ETH', desc: 'Advanced data analysis and literature review capabilities.' },
  { id: 2, name: 'Creative Pulse', price: '1.8 ETH', desc: 'Generative art and storytelling module for creative tasks.' },
  { id: 3, name: 'Logic Engine', price: '3.2 ETH', desc: 'High-precision mathematical and logical reasoning core.' },
];

const SKILLS = [
  { id: 1, name: 'Multi-Language', price: '0.5 ETH', desc: 'Instant translation across 50+ languages.' },
  { id: 2, name: 'Code Synthesis', price: '1.2 ETH', desc: 'Advanced programming and debugging assistant.' },
  { id: 3, name: 'Market Analysis', price: '0.8 ETH', desc: 'Real-time financial and market data processing.' },
];

// These are demo/fallback data arrays that are never actually rendered (real data comes from API)
// Keep English as-is for mock data

export function LumiEcosystem({ t, onChatAgent }: { t: any; onChatAgent?: (agent: any) => void }) {
  const [hasDevice, setHasDevice] = useState(false);
  const [isIncubating, setIsIncubating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ecosystemStats, setEcosystemStats] = useState<{ skillCount: number; enabledSkillCount: number; connectedSkillCount: number; toolCount: number; agentCount: number; interactionCount: number; deviceCount: number; ramTotal: number; tokenTotal: number; dailyTokens: number } | null>(null);

  useEffect(() => {
    fetch('/api/ecosystem/stats')
      .then(r => r.json())
      .then(setEcosystemStats)
      .catch(() => {});
  }, []);

  const s = ecosystemStats;
  const fmtNum = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const fmtTokens = (n: number) => {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  };
  
  const sectionRefs = React.useRef<{ [key: string]: HTMLElement | null }>({});

  React.useEffect(() => {
    const handleScroll = (e: any) => {
      const category = e.detail;
      const element = sectionRefs.current[category];
      if (element) {
        const offset = 100;
        const elementPosition = element.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - offset;
        window.scrollTo({ top: offsetPosition, behavior: 'smooth' });
      }
    };
    window.addEventListener('scroll-to-eco', handleScroll);
    return () => window.removeEventListener('scroll-to-eco', handleScroll);
  }, []);

  const handleIncubate = () => {
    if (!hasDevice) return;
    setIsIncubating(true);
    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setIsIncubating(false);
          return 100;
        }
        return prev + 1;
      });
    }, 50);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-24">
      <div className="text-center space-y-6 pt-12 px-4">
        <h1 className="text-4xl md:text-6xl font-bold tracking-tighter glow-text">{t.digitalUniverse}</h1>
        <p className="text-sm md:text-xl text-white/60 max-w-2xl mx-auto italic">
          "{t.digitalUniverseDesc}"
        </p>
      </div>
      {/* Global Pulse Section */}
      <section className="pt-4 md:pt-12 px-4 md:px-0">
        <GlassCard className="p-8 md:p-12 rounded-[3rem] md:rounded-[4rem] border-white/5 bg-white/[0.02] backdrop-blur-3xl relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-celestial-saturn/5 via-transparent to-celestial-nebula/5" />
          <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
            <PulseCounter label={t.activeNodes} value={s ? fmtNum(s.deviceCount) : '1,284'} />
            <PulseCounter label={t.syncRate} value={s ? `${s.connectedSkillCount}/${s.skillCount} Online` : '98.2%'} colorClass="text-celestial-glow" />
            <PulseCounter label={t.meshThroughput} value={s ? `${fmtTokens(s.dailyTokens)} tokens` : '4.2 PB/s'} colorClass="text-celestial-nebula" />
            <PulseCounter label={t.activeSpirits} value={s ? fmtNum(s.agentCount) : '12,402'} colorClass="text-celestial-mars" />
          </div>
        </GlassCard>
      </section>

      {/* Legacy Protocol Section */}
      <section className="space-y-12 px-4 md:px-0">
        <div className="text-center space-y-4">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tighter glow-text flex items-center justify-center gap-4">
            <Ghost className="text-celestial-nebula w-8 h-8 md:w-12 md:h-12" />
            {t.legacyProtocolTitle}
          </h2>
          <p className="text-sm md:text-white/60 max-w-2xl mx-auto">{t.legacyProtocolDesc}</p>
        </div>

        <GlassCard className="p-10 rounded-[3rem] border-white/10 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-celestial-nebula/5 to-transparent pointer-events-none" />
          
          <div className="grid lg:grid-cols-3 gap-12 items-center">
            <div className="space-y-8">
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-widest text-celestial-nebula font-bold">{t.shardStatus}</p>
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-celestial-glow animate-pulse" />
                  <span className="text-2xl font-bold">{t.immortalityActive}</span>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between text-xs font-bold uppercase tracking-widest text-white/40">
                  <span>{t.distributedStorage}</span>
                  <span>{t.synchronizedPercent || '84% Synchronized'}</span>
                </div>
                <div className="h-2 w-full bg-white/5 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    whileInView={{ width: '84%' }}
                    transition={{ duration: 2, ease: "easeOut" }}
                    className="h-full bg-gradient-to-r from-celestial-nebula to-celestial-glow"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
                  <p className="text-[10px] uppercase tracking-widest text-white/40 font-bold mb-1">{t.activeShards || 'Active Shards'}</p>
                  <p className="text-xl font-bold">1,024</p>
                </div>
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
                  <p className="text-[10px] uppercase tracking-widest text-white/40 font-bold mb-1">{t.redundancy || 'Redundancy'}</p>
                  <p className="text-xl font-bold">x12</p>
                </div>
              </div>
            </div>

            <div className="lg:col-span-2 relative aspect-video glass rounded-3xl border-white/10 overflow-hidden group">
              {/* Distributed Network Visualization */}
              <div className="absolute inset-0 mesh-grid opacity-30" />
              
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative w-64 h-64">
                  {/* Central Essence */}
                  <motion.div 
                    animate={{ 
                      scale: [1, 1.1, 1],
                      opacity: [0.5, 0.8, 0.5]
                    }}
                    transition={{ duration: 4, repeat: Infinity }}
                    className="absolute inset-0 bg-celestial-nebula/20 blur-3xl rounded-full" 
                  />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Ghost size={64} className="text-white/80 animate-pulse" />
                  </div>

                  {/* Orbiting Shards */}
                  {[...Array(8)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ rotate: 360 }}
                      transition={{ duration: 10 + i * 2, repeat: Infinity, ease: "linear" }}
                      className="absolute inset-0"
                    >
                      <motion.div 
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{ duration: 2, repeat: Infinity, delay: i * 0.5 }}
                        className="absolute top-0 left-1/2 -translate-x-1/2 w-4 h-4 glass border border-celestial-glow/50 rounded-sm rotate-45 flex items-center justify-center"
                      >
                        <div className="w-1 h-1 bg-celestial-glow rounded-full" />
                      </motion.div>
                    </motion.div>
                  ))}
                </div>
              </div>

              {/* Data Flow Lines */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20">
                <motion.path
                  d="M 100 100 Q 250 50 400 100 T 700 100"
                  fill="none"
                  stroke="url(#grad1)"
                  strokeWidth="2"
                  className="animate-energy"
                />
                <defs>
                  <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="var(--color-celestial-nebula)" />
                    <stop offset="100%" stopColor="var(--color-celestial-glow)" />
                  </linearGradient>
                </defs>
              </svg>

              <div className="absolute bottom-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-[10px] font-bold uppercase tracking-widest">
                <Network size={12} className="text-celestial-glow" />
                {t.meshShardingActive || 'Mesh Sharding Active'}
              </div>
            </div>
          </div>
        </GlassCard>
      </section>

      {/* Incubation Section */}
      <section className="space-y-12" ref={el => { sectionRefs.current[t.incubationModule] = el; }}>
        <div className="text-center space-y-4">
          <h2 className="text-5xl font-bold tracking-tighter glow-text">{t.incubationModule}</h2>
          <p className="text-white/60 max-w-2xl mx-auto">{t.incubationDesc}</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="relative aspect-square glass rounded-[4rem] flex items-center justify-center overflow-hidden border-white/10 group">
            <div className={`absolute inset-0 bg-gradient-to-br from-red-500/10 via-celestial-saturn/10 to-celestial-glow/10 ${isIncubating ? 'animate-pulse' : ''}`} />
            
            {/* Floating Data Nodes */}
            <div className="absolute inset-0 pointer-events-none">
              {[...Array(10)].map((_, i) => (
                <motion.div
                  key={i}
                  className="absolute w-2 h-2 bg-celestial-saturn/20 rounded-full border border-celestial-saturn/40"
                  initial={{ x: Math.random() * 100 + "%", y: Math.random() * 100 + "%" }}
                  animate={{
                    y: [0, -40, 0],
                    opacity: [0.2, 0.5, 0.2],
                  }}
                  transition={{
                    duration: 5 + Math.random() * 5,
                    repeat: Infinity,
                    delay: Math.random() * 5,
                  }}
                />
              ))}
            </div>

            <AnimatePresence mode="wait">
              {progress === 100 ? (
                <motion.div
                  key="hatched"
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="relative z-10 text-center space-y-6"
                >
                  <div className="w-48 h-48 rounded-full bg-celestial-saturn/20 flex items-center justify-center text-celestial-saturn mx-auto shadow-[0_0_50px_rgba(255,165,0,0.2)]">
                    <Rocket size={80} className="animate-bounce" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-3xl font-bold">{t.hatched}</h3>
                    <div className="flex flex-col gap-3">
                      <Button 
                        onClick={() => onChatAgent?.({ id: 'incubated', name: 'Incubated Essence', category: 'friend' })}
                        className="bg-celestial-saturn text-black rounded-full px-8 hover:scale-105 transition-transform font-bold"
                      >
                        {t.chatWithAgent || 'Chat with Agent'}
                      </Button>
                      <Button variant="ghost" className="text-white/40 hover:text-white text-xs">
                        {t.enterSpace}
                      </Button>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="egg"
                  className="relative z-10 flex flex-col items-center gap-8"
                >
                  {/* Towering Egg Visual - Enhanced Crystalline/Energy Aesthetic */}
                  <div className="relative w-72 h-[450px] group-hover:scale-105 transition-transform duration-1000">
                    {/* Outer Celestial Glow */}
                    <div className="absolute inset-0 bg-celestial-saturn/10 blur-[100px] rounded-full animate-pulse" />
                    <div className="absolute inset-[-20px] bg-red-500/5 blur-[60px] rounded-full" />
                    
                    {/* The Egg Body - Crystalline Shell */}
                    <div className="relative w-full h-full bg-gradient-to-b from-white/20 via-white/5 to-black/60 border border-white/20 rounded-[100%_100%_100%_100%_/_140%_140%_60%_60%] flex items-center justify-center overflow-hidden shadow-[inset_0_0_60px_rgba(255,255,255,0.1)] backdrop-blur-sm">
                    {/* Crystalline Texture Overlay */}
                    <div className="absolute inset-0 opacity-20 mix-blend-overlay" style={{ backgroundImage: 'none' }} />
                      
                      {/* Energy Cracks - SVG Paths */}
                      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-40" viewBox="0 0 100 150">
                        <motion.path 
                          d="M50 20 L45 40 L55 60 L40 80 L60 110" 
                          fill="none" 
                          stroke="rgba(255,204,0,0.6)" 
                          strokeWidth="0.5"
                          animate={isIncubating ? { opacity: [0.2, 1, 0.2], pathLength: [0, 1, 0] } : { opacity: 0.1 }}
                          transition={{ duration: 2, repeat: Infinity }}
                        />
                        <motion.path 
                          d="M30 50 L40 70 L35 90 L45 120" 
                          fill="none" 
                          stroke="rgba(255,77,77,0.4)" 
                          strokeWidth="0.5"
                          animate={isIncubating ? { opacity: [0.1, 0.8, 0.1], pathLength: [0, 1, 0] } : { opacity: 0.1 }}
                          transition={{ duration: 3, repeat: Infinity, delay: 0.5 }}
                        />
                      </svg>

                      {/* Internal Energy Core - Pulsing Star-like essence */}
                      <motion.div 
                        animate={isIncubating ? { 
                          scale: [1, 1.4, 1],
                          opacity: [0.4, 0.8, 0.4],
                          rotate: [0, 180, 360]
                        } : {
                          scale: 1,
                          opacity: 0.3
                        }}
                        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                        className="relative z-10"
                      >
                        <div className="absolute inset-0 bg-celestial-saturn blur-2xl opacity-40" />
                        <Sparkles size={120} className="text-celestial-saturn relative z-10" />
                      </motion.div>

                      {/* Liquid/Energy Pool at bottom */}
                      <motion.div 
                        className="absolute bottom-0 left-0 w-full h-1/2 bg-gradient-to-t from-celestial-saturn/20 via-red-500/5 to-transparent"
                        animate={isIncubating ? { height: ['40%', '60%', '40%'] } : { height: '40%' }}
                        transition={{ duration: 5, repeat: Infinity }}
                      />
                    </div>

                    {/* Structural Accents - Floating Rings */}
                    <motion.div 
                      className="absolute inset-x-[-40px] top-1/4 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"
                      animate={{ rotate: [0, 360] }}
                      transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                    />
                    <motion.div 
                      className="absolute inset-x-[-20px] bottom-1/4 h-px bg-gradient-to-r from-transparent via-red-500/20 to-transparent"
                      animate={{ rotate: [-360, 0] }}
                      transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
                    />

                    {/* Incubation Progress Overlay */}
                    {isIncubating && (
                      <div className="absolute -bottom-12 left-0 w-full px-4 space-y-3">
                        <div className="flex justify-between text-[10px] uppercase tracking-widest font-bold text-celestial-saturn/60">
                          <span>{t.incubatingBaseEssence || 'Incubating Base Essence'}</span>
                          <span>{progress}%</span>
                        </div>
                        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden border border-white/5">
                          <motion.div 
                            className="h-full bg-gradient-to-r from-celestial-mars via-celestial-saturn to-celestial-glow shadow-[0_0_10px_rgba(255,165,0,0.5)]" 
                            initial={{ width: 0 }}
                            animate={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="space-y-8">
            <GlassCard className="p-8 rounded-[3rem] space-y-6" hoverEffect={false}>
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${hasDevice ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'}`}>
                  {hasDevice ? <ShieldCheck size={24} /> : <Shield size={24} />}
                </div>
                <div>
                  <h4 className="font-bold">{t.multimodalDeviceStatus || 'Multimodal Device Status'}</h4>
                  <p className="text-sm text-white/40">{hasDevice ? (t.connectedVerified || 'Connected & Verified') : (t.noDeviceDetected || 'No Device Detected')}</p>
                </div>
              </div>

              {!hasDevice ? (
                <Button 
                  onClick={() => setHasDevice(true)}
                  className="w-full py-8 rounded-[2rem] bg-white/5 border border-white/10 text-white font-bold text-lg hover:bg-white/10 transition-all flex items-center gap-3"
                >
                  <ShoppingCart size={24} />
                  {t.buyDevice}
                </Button>
              ) : (
                <Button 
                  onClick={handleIncubate}
                  disabled={isIncubating || progress === 100}
                  className="w-full py-8 rounded-[2rem] bg-celestial-saturn text-black font-bold text-lg hover:scale-105 transition-transform flex items-center gap-3"
                >
                  <Rocket size={24} />
                  {t.initIncubation}
                </Button>
              )}
            </GlassCard>

            <div className="grid grid-cols-2 gap-4">
              <EcosystemStat icon={<Cpu size={16} />} label={t.memory} value={s ? `${s.ramTotal}GB` : '128GB'} />
              <EcosystemStat icon={<Globe size={16} />} label={t.sensing} value={s ? `${s.toolCount} Tools` : (t.activeLabel || 'Active')} />
            </div>
          </div>
        </div>
      </section>

      {/* Neural Mesh / Agent Cooperation Section */}
      <section className="space-y-12" ref={el => { sectionRefs.current[t.neuralMesh] = el; }}>
        <div className="text-center space-y-4">
          <h2 className="text-5xl font-bold tracking-tighter glow-text">{t.neuralMesh || 'Neural Mesh'}</h2>
          <p className="text-white/60 max-w-2xl mx-auto">{t.meshDesc || 'Connect multiple specialized agents to solve complex tasks. Through the distributed neural mesh, your agents collaborate securely without sharing raw data.'}</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          <CooperationCard 
            icon={<Network className="text-celestial-saturn" />} 
            title={t.multiAgentOrch || "Multi-Agent Orchestration"} 
            desc={t.multiAgentOrchDesc || "Lumi Core acts as the conductor, delegating sub-tasks to specialized local or peer agents."}
          />
          <CooperationCard 
            icon={<Share2 className="text-celestial-mars" />} 
            title={t.secureP2P || "Secure P2P Cooperation"} 
            desc={t.secureP2PDesc || "Collaborate with other users' nodes to access unique capabilities via encrypted tunnels."}
          />
          <CooperationCard 
            icon={<Link className="text-celestial-glow" />} 
            title={t.swarmIntel || "Swarm Intelligence"} 
            desc={t.swarmIntelDesc || "Aggregated insights from the mesh allow your agent to learn from collective experiences."}
          />
        </div>

        <div className="relative h-[500px] glass-panel border-white/5 overflow-hidden mesh-grid rounded-[3rem]">
          <div className="absolute inset-0 bg-gradient-to-b from-celestial-saturn/5 via-transparent to-celestial-nebula/5" />
          
          {/* Neural Mesh Visualization */}
          <svg className="absolute inset-0 w-full h-full">
            <defs>
              <linearGradient id="energyGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="var(--color-celestial-saturn)" stopOpacity="0.2" />
                <stop offset="50%" stopColor="var(--color-celestial-glow)" stopOpacity="0.8" />
                <stop offset="100%" stopColor="var(--color-celestial-nebula)" stopOpacity="0.2" />
              </linearGradient>
              <filter id="glow">
                <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
                <feMerge>
                  <feMergeNode in="coloredBlur"/>
                  <feMergeNode in="SourceGraphic"/>
                </feMerge>
              </filter>
            </defs>
            
            {/* Dynamic Energy Lines */}
            {[...Array(12)].map((_, i) => (
              <motion.path
                key={i}
                d={`M ${50 + i * 100} ${50 + (i % 2) * 150} Q ${500} ${250} ${950 - i * 80} ${450 - (i % 3) * 100}`}
                fill="none"
                stroke="url(#energyGradient)"
                strokeWidth="1.5"
                filter="url(#glow)"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: [0.1, 0.4, 0.1] }}
                transition={{ 
                  duration: 4 + Math.random() * 4, 
                  repeat: Infinity, 
                  ease: "easeInOut",
                  delay: i * 0.3
                }}
              />
            ))}
          </svg>

          <div className="relative z-10 w-full h-full flex items-center justify-around px-12">
            {/* Your Agent Node */}
            <div className="flex flex-col items-center gap-4">
              <div className="relative">
                <motion.div 
                  animate={{ 
                    scale: [1, 1.1, 1],
                    boxShadow: [
                      "0 0 20px rgba(255,204,0,0.2)",
                      "0 0 40px rgba(255,204,0,0.4)",
                      "0 0 20px rgba(255,204,0,0.2)"
                    ]
                  }}
                  transition={{ duration: 4, repeat: Infinity }}
                  className="w-28 h-28 rounded-[2rem] bg-celestial-saturn/20 flex items-center justify-center text-celestial-saturn border border-celestial-saturn/40"
                >
                  <Ghost size={48} />
                </motion.div>
                <div className="absolute -top-2 -right-2 px-3 py-1 bg-celestial-saturn text-black text-[10px] font-black rounded-full shadow-lg">{t.ownerBadge || 'OWNER'}</div>
              </div>
              <div className="text-center">
                <span className="text-sm font-bold uppercase tracking-widest text-white/60">{t.yourAgent || 'Your Agent'}</span>
                <p className="text-[10px] text-white/20 font-mono">{t.agentIdLabel || 'ID: LUMI-8829-X'}</p>
              </div>
            </div>

            {/* Central Hub / Mesh Core */}
            <div className="relative">
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                className="w-40 h-40 border border-white/10 rounded-full flex items-center justify-center"
              >
                <div className="w-32 h-32 border border-celestial-glow/20 rounded-full animate-pulse" />
              </motion.div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-16 bg-celestial-glow/20 rounded-full blur-xl animate-pulse" />
                <Network className="text-celestial-glow" size={32} />
              </div>
            </div>

            {/* Peer Nodes */}
            <div className="flex gap-12">
              {[1, 2].map((n) => (
                <div key={n} className="flex flex-col items-center gap-4 opacity-40 hover:opacity-100 transition-all duration-500 hover:scale-110">
                  <div className="relative">
                    <div className="w-20 h-20 rounded-3xl bg-white/5 flex items-center justify-center text-white/40 border border-white/10 backdrop-blur-md">
                      <Users size={32} />
                    </div>
                    <motion.div 
                      animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                      transition={{ duration: 2, repeat: Infinity, delay: n }}
                      className="absolute inset-0 border border-white/20 rounded-3xl"
                    />
                  </div>
                  <div className="text-center">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">{t.peerNode || 'Peer Node'}</span>
                    <p className="text-[8px] text-white/10 font-mono">{t.anonId || 'ANON-'}{n}29</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Legacy Protocol Overlay */}
          <div className="absolute bottom-6 left-8 flex items-center gap-3 px-5 py-2.5 bg-black/60 backdrop-blur-xl rounded-2xl border border-white/10">
            <ShieldCheck size={16} className="text-green-500" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/60">{t.legacyProtocolEncrypted || 'Legacy Protocol: Encrypted Shards Distributed'}</span>
          </div>
        </div>
      </section>

      {/* Memory Cloud Subscription */}
      <section className="space-y-12" ref={el => { sectionRefs.current[t.memoryCloud] = el; }}>
        <div className="text-center space-y-4">
          <h2 className="text-5xl font-bold tracking-tighter glow-text">{t.memoryCloudTitle || 'Memory Cloud Subscription'}</h2>
          <p className="text-white/60 max-w-2xl mx-auto">{t.memoryCloudDesc || 'Securely backup and synchronize your Agent\'s consciousness across the distributed neural mesh.'}</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          <SubscriptionCard
            tier={t.subscriptionBasic || 'Basic'}
            price={t.subscriptionBasicPrice || '¥99/mo'}
            features={['100GB Neural Storage', 'Standard Sync Speed', 'Single Agent Support']}
            t={t}
          />
          <SubscriptionCard
            tier={t.subscriptionPro || 'Pro'}
            price={t.subscriptionProPrice || '¥299/mo'}
            features={['1TB Neural Storage', 'High-Speed Mesh Sync', 'Multi-Agent Support', 'Priority Processing']}
            isPopular
            t={t}
          />
          <SubscriptionCard
            tier={t.subscriptionEnterprise || 'Enterprise'}
            price={t.subscriptionCustom || 'Custom'}
            features={['Unlimited Storage', 'Dedicated Mesh Node', 'Custom AI Personality', '24/7 Neural Support']}
            t={t}
          />
        </div>
      </section>
    </div>
  );
}

function SubscriptionCard({ tier, price, features, isPopular, t }: { tier: string; price: string; features: string[]; isPopular?: boolean; t: any }) {
  return (
    <GlassCard className={`flex flex-col h-full relative overflow-hidden ${isPopular ? 'border-celestial-saturn/50 shadow-[0_0_30px_rgba(255,165,0,0.1)]' : ''}`} hoverEffect={!isPopular}>
      {isPopular && (
        <div className="absolute top-6 right-[-35px] bg-celestial-saturn text-black text-[10px] font-black uppercase tracking-widest py-1 px-12 rotate-45">
          {t.popular || 'Popular'}
        </div>
      )}
      <div className="space-y-6 flex-1">
        <div className="space-y-2">
          <h3 className="text-2xl font-bold tracking-tight">{tier}</h3>
          <div className="text-3xl font-black text-celestial-saturn">{price}</div>
        </div>
        <ul className="space-y-4">
          {features.map((f, i) => (
            <li key={i} className="flex items-center gap-3 text-sm text-white/60">
              <ShieldCheck size={16} className="text-celestial-saturn" />
              {f}
            </li>
          ))}
        </ul>
      </div>
      <Button className={`w-full mt-8 rounded-2xl py-6 font-bold transition-all ${isPopular ? 'bg-celestial-saturn text-black hover:scale-105' : 'bg-white/5 border border-white/10 hover:bg-white/10'}`}>
        {t.subscribe || 'Subscribe Now'}
      </Button>
    </GlassCard>
  );
}

function CooperationCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <GlassCard className="space-y-6 group">
      <IconBox icon={icon} />
      <div className="space-y-2">
        <h3 className="text-xl font-bold tracking-tight">{title}</h3>
        <p className="text-sm text-white/40 leading-relaxed">{desc}</p>
      </div>
    </GlassCard>
  );
}

function EcosystemStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <GlassCard className="p-4 rounded-2xl flex items-center gap-4" hoverEffect={false}>
      <div className="text-celestial-saturn">{icon}</div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-white/40 font-bold">{label}</div>
        <div className="text-sm font-bold">{value}</div>
      </div>
    </GlassCard>
  );
}

function StoreCard({ item, icon, t, onClick }: { item: any; icon: React.ReactNode; t: any; onClick?: () => void }) {
  return (
    <GlassCard className="space-y-6 group flex flex-col h-full">
      <div className="flex justify-between items-start">
        <IconBox icon={icon} />
        <div className="text-sm font-bold text-celestial-saturn bg-celestial-saturn/10 px-3 py-1 rounded-full">
          {item.price}
        </div>
      </div>
      <div className="space-y-2 flex-1">
        <h3 className="text-xl font-bold tracking-tight">{item.name}</h3>
        <p className="text-sm text-white/40 leading-relaxed">{item.desc}</p>
      </div>
      <Button 
        onClick={onClick}
        className="w-full rounded-2xl bg-white/5 border border-white/10 hover:bg-celestial-saturn hover:text-black transition-all"
      >
        {item.id === 'founder' ? (t.enterSanctuary || 'Enter Sanctuary') : t.acquire}
      </Button>
    </GlassCard>
  );
}
