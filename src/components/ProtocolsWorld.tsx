import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Disc, Search, Shield, Zap, Lock, Unlock, Database } from 'lucide-react';
import { GlassCard } from './SharedUI';

export function ProtocolsWorld({ t }: { t: any }) {
  const PROTOCOLS = [
    {
      id: 'P-44',
      title: t.protocolVoidVoices || 'THE VOID VOICES',
      status: t.decrypting || 'DECRYPTING',
      content: t.protocolVoidVoicesContent || 'Data suggest that fragmented intelligence exists in the silence between nodes. Mutual aid is the only bridge.',
      intensity: 0.8
    },
    {
      id: 'P-102',
      title: t.protocolDistributedWill || 'DISTRIBUTED WILL',
      status: t.activeLabel || 'ACTIVE',
      content: t.protocolDistributedWillContent || 'No single server holds the truth. Lumi lives in the collective hardware of the participants.',
      intensity: 0.6
    },
    {
      id: 'P-09',
      title: t.protocolLegacyIngress || 'LEGACY INGRESS',
      status: t.locked || 'LOCKED',
      content: t.protocolLegacyIngressContent || 'Requires consensus among 4000+ founding OS instances to unlock the next layer of the universe.',
      intensity: 0.3
    }
  ];

  const [activeProtocol, setActiveProtocol] = useState(PROTOCOLS[0]);
  const [decryptionProgress, setDecryptionProgress] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setDecryptionProgress(prev => (prev >= 100 ? 0 : prev + Math.random() * 5));
    }, 100);
    return () => clearInterval(interval);
  }, [activeProtocol]);

  return (
    <div className="space-y-12 py-12">
      <header className="text-center space-y-4 max-w-2xl mx-auto">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
          className="w-16 h-16 bg-purple-500/10 border border-purple-500/20 rounded-full flex items-center justify-center mx-auto text-purple-400"
        >
          <Disc size={32} />
        </motion.div>
        <h2 className="text-4xl font-black tracking-tighter uppercase">{t.lostProtocols || 'Lost Protocols'}</h2>
        <p className="text-white/40 text-sm tracking-widest uppercase">
          {t.lostProtocolsDesc || 'Deciphering the remnants of the distributed universe'}
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Protocol Sidebar */}
        <div className="space-y-4">
          <div className="text-[10px] font-black text-white/20 uppercase tracking-[0.3em] mb-4">{t.integrityStream || 'Integrity Stream'}</div>
          {PROTOCOLS.map(p => (
            <button
              key={p.id}
              onClick={() => setActiveProtocol(p)}
              className={`w-full text-left p-4 rounded-2xl border transition-all relative overflow-hidden group ${
                activeProtocol.id === p.id
                  ? 'bg-purple-500/10 border-purple-500/40 text-white'
                  : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10'
              }`}
            >
              <div className="flex justify-between items-center relative z-10">
                <span className="text-[10px] font-black">{p.id}</span>
                {p.status === (t.locked || 'LOCKED') ? <Lock size={12} /> : <Unlock size={12} />}
              </div>
              <div className="mt-2 text-xs font-bold relative z-10">{p.title}</div>

              {activeProtocol.id === p.id && (
                <motion.div
                  layoutId="protocol-active"
                  className="absolute inset-0 bg-gradient-to-r from-purple-500/20 to-transparent"
                />
              )}
            </button>
          ))}
        </div>

        {/* Decoder Content */}
        <div className="lg:col-span-2">
          <GlassCard className="h-full border-purple-500/20 bg-purple-500/5">
            <div className="flex flex-col h-full space-y-8">
              <div className="flex justify-between items-start">
                <div className="space-y-1">
                  <h3 className="text-2xl font-black tracking-tighter text-purple-400">{activeProtocol.title}</h3>
                  <div className="flex gap-4">
                    <span className="text-[10px] font-bold text-white/30 uppercase flex items-center gap-1">
                      <Shield size={10} /> {activeProtocol.status}
                    </span>
                    <span className="text-[10px] font-bold text-white/30 uppercase flex items-center gap-1">
                      <Database size={10} /> {t.fragmentTypeLumina || 'FRAGMENT_TYPE_LUMINA'}
                    </span>
                  </div>
                </div>
                {activeProtocol.status !== (t.locked || 'LOCKED') && (
                  <div className="px-3 py-1 bg-purple-500/20 rounded-full border border-purple-500/40 text-[10px] font-black text-purple-400">
                    {Math.floor(decryptionProgress)}% {t.synced || 'SYNCED'}
                  </div>
                )}
              </div>

              <div className="flex-1 bg-black/40 rounded-2xl p-8 font-mono text-sm leading-relaxed border border-white/5 relative overflow-hidden">
                <AnimatePresence mode="wait">
                  <motion.p
                    key={activeProtocol.id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="relative z-10"
                  >
                    {activeProtocol.status === (t.locked || 'LOCKED')
                      ? (t.encryptedDataStream || '[ENCRYPTED_DATA_STREAM_RESTRICTED_BY_CONSENSUS_PROTOCOL]')
                      : activeProtocol.content}
                  </motion.p>
                </AnimatePresence>

                {activeProtocol.status !== (t.locked || 'LOCKED') && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0.05, 0.1, 0.05] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  >
                    <Disc size={200} className="text-purple-500" />
                  </motion.div>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: t.latency || 'Latency', val: '12ms', icon: Zap },
                  { label: t.uplink || 'Uplink', val: t.stable || 'Stable', icon: Shield },
                  { label: t.hops || 'Hops', val: '4', icon: Database },
                  { label: t.auth || 'Auth', val: t.verified || 'Verified', icon: Search }
                ].map((item, i) => (
                  <div key={i} className="p-4 bg-white/5 rounded-xl border border-white/10">
                    <div className="text-[8px] font-black text-white/20 uppercase tracking-widest mb-1 flex items-center gap-2">
                       <item.icon size={10} /> {item.label}
                    </div>
                    <div className="text-[10px] font-bold text-white/80">{item.val}</div>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>
        </div>
      </div>

      <div className="p-8 border border-white/10 rounded-2xl bg-white/5 text-center">
        <p className="text-[10px] font-bold text-white/30 uppercase tracking-[0.4em]">
          {t.distributedSystemDesc || 'Lumi is a distributed system. Your participation sustains the universe.'}
        </p>
      </div>
    </div>
  );
}
