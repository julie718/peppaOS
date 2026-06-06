import React, { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Rocket, Mail, Github, Twitter, Send, Settings, Sprout, X, Sparkles, Zap, Shield, Globe } from 'lucide-react';
import { GlassCard } from './SharedUI';
import { useApp } from '../contexts/AppContext';
import { motion, AnimatePresence } from 'motion/react';

export function JoinUs({ t }: { t: any }) {
  const { user } = useApp();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [position, setPosition] = useState('');
  const [sent, setSent] = useState(false);
  const [isGenesisMode, setIsGenesisMode] = useState(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [isEditingAdmin, setIsEditingAdmin] = useState(false);

  useEffect(() => {
    if (user?.role === 'admin') {
      fetch('/api/admin/config')
        .then(res => res.json())
        .then(data => setAdminEmail(data.adminEmail))
        .catch(err => console.error("Failed to fetch admin config", err));
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          email, 
          message, 
          type: isGenesisMode ? 'civilization_architect' : 'general',
          contact: isGenesisMode ? contact : undefined,
          position: isGenesisMode ? position : undefined
        })
      });
      if (res.ok) {
        setSent(true);
        setEmail('');
        setMessage('');
        setContact('');
        setPosition('');
      }
    } catch (error) {
      console.error("Feedback error", error);
    }
  };

  const handleUpdateAdminEmail = async () => {
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail })
      });
      if (res.ok) {
        setIsEditingAdmin(false);
      }
    } catch (error) {
      console.error("Failed to update admin email", error);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="max-w-4xl mx-auto space-y-16 pb-20"
    >
      {/* Header Section */}
      <div className="text-center space-y-6 pt-12">
        <div className="flex flex-col items-center gap-4">
          <Badge className="bg-celestial-saturn/20 text-celestial-saturn px-6 py-2 border border-celestial-saturn/30 mx-auto text-xl">
            <Sprout size={20} className="mr-2" />
            {t.genesisSeedTitle}
          </Badge>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-celestial-saturn/60 font-bold">
            <span className="w-1.5 h-1.5 rounded-full bg-celestial-saturn animate-pulse" />
            {t.phaseEcosystemGenesis || 'Phase 01: Ecosystem Genesis'}
          </div>
        </div>
        <h1 className="text-5xl font-bold tracking-tighter">
          {t.architectingCivilization}
        </h1>
        <p className="text-lg text-white/60 max-w-2xl mx-auto leading-relaxed">
          {t.civilizationDesc}
        </p>
        <div className="flex justify-center gap-4 pt-4">
          <SocialLink icon={<Twitter />} href="#" />
          <SocialLink icon={<Github />} href="#" />
          <EmailButton adminEmail={adminEmail} setAdminEmail={setAdminEmail} onUpdate={handleUpdateAdminEmail} userRole={user?.role} t={t} />
        </div>
      </div>

      {/* Mission Manifesto Section */}
      <div className="relative py-20 overflow-hidden rounded-[3rem] glass border border-white/10">
        <div className="absolute inset-0 bg-gradient-to-b from-celestial-nebula/5 to-transparent pointer-events-none" />
        <div className="absolute -top-24 -left-24 w-64 h-64 bg-celestial-nebula/10 blur-[100px] rounded-full" />
        <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-celestial-saturn/10 blur-[100px] rounded-full" />
        
        <div className="relative z-10 max-w-3xl mx-auto px-8 text-center space-y-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs font-bold uppercase tracking-[0.2em] text-celestial-nebula"
          >
            <Sparkles size={14} />
            {t.missionManifesto}
          </motion.div>

          <div className="space-y-6">
            <motion.h2 
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1.5 }}
              className="text-4xl md:text-5xl font-bold tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-white via-white/80 to-white/40 leading-tight"
            >
              {t.missionHolographic}
            </motion.h2>
            
            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.5, duration: 1 }}
              className="text-xl text-white/60 leading-relaxed font-light italic"
            >
              "{t.missionLong}"
            </motion.p>
          </div>

          <motion.div 
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 1, duration: 1.5 }}
            className="h-px w-32 bg-gradient-to-r from-transparent via-celestial-nebula to-transparent mx-auto"
          />
        </div>

        {/* Holographic Scanline Effect */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-20">
          <motion.div 
            animate={{ y: ['0%', '100%'] }}
            transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
            className="h-20 w-full bg-gradient-to-b from-transparent via-celestial-glow/20 to-transparent"
          />
        </div>
      </div>

      {/* Contributor Node Section */}
      <div className="space-y-8">
        <div className="flex items-center gap-4">
          <div className="h-px flex-1 bg-white/10" />
          <h2 className="text-2xl font-bold tracking-tight text-white/40 uppercase tracking-[0.2em]">{t.contributorNodeTitle}</h2>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          <GlassCard className="lg:col-span-2 p-10 rounded-3xl border-l-4 border-celestial-saturn relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4">
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-celestial-saturn/10 border border-celestial-saturn/20 text-xs font-bold text-celestial-saturn uppercase tracking-widest">
                <Zap size={10} />
                {t.activeNode || 'Active Node'}
              </div>
            </div>

            <div className="space-y-8">
              <div className="space-y-4">
                <h3 className="text-3xl font-bold tracking-tight">{t.contributorNodeTitle}</h3>
                <p className="text-lg text-white/60 leading-relaxed">
                  {t.contributorNodeDesc}
                </p>
              </div>
              
              <div className="grid sm:grid-cols-2 gap-8">
                <div className="space-y-4">
                  <p className="text-xs uppercase tracking-widest text-white/40 font-bold">{t.rewardProtocol || 'Reward Protocol'}</p>
                  <div className="p-6 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                    <div className="flex items-center gap-2 text-celestial-saturn font-bold text-2xl">
                      <Sparkles size={24} />
                      {t.civilizationCredits}
                    </div>
                    <p className="text-xs text-white/40">{t.soulCreditsDesc || 'Soul Credits (SC) are minted based on uptime and compute quality.'}</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <p className="text-xs uppercase tracking-widest text-white/40 font-bold">{t.globalMeshStatus || 'Global Mesh Status'}</p>
                  <div className="p-6 rounded-2xl bg-white/5 border border-white/10 space-y-2">
                    <div className="text-white font-bold text-2xl flex items-center gap-2">
                      <Globe size={24} className="text-celestial-glow" />
                      {t.meshNodeCount || '14,204 Nodes'}
                    </div>
                    <p className="text-xs text-white/40">{t.meshDistributedDesc || 'Distributed across 82 countries. Total mesh power: 4.2 PFLOPS.'}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <ContributionTypeCard
                  icon={<Globe size={20} className="text-celestial-glow" />}
                  title={t.compute || 'Compute'}
                  desc={t.computeDesc || 'Idle GPU power.'}
                />
                <ContributionTypeCard
                  icon={<Shield size={20} className="text-celestial-nebula" />}
                  title={t.ethics || 'Ethics'}
                  desc={t.ethicsDesc || 'Governance.'}
                />
                <ContributionTypeCard
                  icon={<Mail size={20} className="text-celestial-saturn" />}
                  title={t.curator || 'Curator'}
                  desc={t.curatorDesc || 'Data verification.'}
                />
                <ContributionTypeCard
                  icon={<Twitter size={20} className="text-white/60" />}
                  title={t.advocate || 'Advocate'}
                  desc={t.advocateDesc || 'Growth.'}
                />
              </div>
            </div>
          </GlassCard>

          <GlassCard className="p-8 rounded-3xl flex flex-col justify-between space-y-8 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-b from-celestial-saturn/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="space-y-6 relative z-10">
              <h3 className="text-xl font-bold tracking-tight">{t.nodeSimulator || 'Node Simulator'}</h3>
              <div className="space-y-4">
                <div className="p-4 rounded-xl bg-black/40 border border-white/5 space-y-3">
                  <div className="flex justify-between text-xs uppercase tracking-widest font-bold text-white/40">
                    <span>{t.syncRate || 'Sync Rate'}</span>
                    <span className="text-celestial-saturn">98.2%</span>
                  </div>
                  <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                    <motion.div 
                      animate={{ width: ['0%', '98.2%'] }}
                      transition={{ duration: 2, ease: "easeOut" }}
                      className="h-full bg-celestial-saturn shadow-[0_0_10px_rgba(255,204,0,0.5)]" 
                    />
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-black/40 border border-white/5 space-y-3">
                  <div className="flex justify-between text-xs uppercase tracking-widest font-bold text-white/40">
                    <span>{t.soulCreditsPerDay || 'Soul Credits / Day'}</span>
                    <span className="text-celestial-saturn">+12.5 SC</span>
                  </div>
                  <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                    <motion.div 
                      animate={{ width: ['0%', '65%'] }}
                      transition={{ duration: 2, ease: "easeOut", delay: 0.5 }}
                      className="h-full bg-celestial-saturn shadow-[0_0_10px_rgba(255,204,0,0.5)]" 
                    />
                  </div>
                </div>
              </div>
              <p className="text-xs text-white/40 leading-relaxed">
                {t.nodeSimulatorDesc || 'Estimate your contribution value based on your hardware profile and network latency.'}
              </p>
            </div>
            <Button className="w-full bg-celestial-saturn text-black font-bold rounded-xl py-6 relative z-10 hover:scale-[1.02] transition-transform">
              {t.startBenchmarking || 'Start Benchmarking'}
            </Button>
          </GlassCard>
        </div>
      </div>

      {/* Genesis Program Details */}
      <div className="space-y-12">
        <div className="text-center space-y-4">
          <h2 className="text-3xl font-bold tracking-tighter">{t.genesisPillarsTitle}</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          <PillarCard icon={<Zap className="text-celestial-saturn" />} title={t.pillar1Title} desc={t.pillar1Desc} />
          <PillarCard icon={<Shield className="text-celestial-saturn" />} title={t.pillar2Title} desc={t.pillar2Desc} />
          <PillarCard icon={<Globe className="text-celestial-saturn" />} title={t.pillar3Title} desc={t.pillar3Desc} />
        </div>
      </div>

      {/* Application Form */}
      <GlassCard className="p-10 rounded-3xl relative overflow-hidden border border-celestial-saturn/10">
        <div className="absolute top-0 right-0 w-32 h-32 bg-celestial-saturn/10 blur-3xl" />
        
        {sent ? (
          <div className="text-center py-12 space-y-4">
            <div className="w-16 h-16 bg-celestial-nebula/20 text-celestial-nebula rounded-full flex items-center justify-center mx-auto">
              <Send />
            </div>
            <h3 className="text-2xl font-bold">{t.manifestoReceived}</h3>
            <p className="text-white/60">{t.manifestoReceivedDesc}</p>
            <Button onClick={() => { setSent(false); setIsGenesisMode(false); }} variant="ghost" className="text-celestial-nebula">{t.returnToHub}</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-2xl font-bold">{isGenesisMode ? t.architectApplication : t.joinTheMesh}</h3>
              {isGenesisMode && (
                <Button variant="ghost" size="sm" onClick={() => setIsGenesisMode(false)} className="text-white/40 hover:text-white">
                  <X size={16} />
                </Button>
              )}
            </div>
            
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-bold text-white/40 uppercase tracking-widest">{t.neuralLinkEmail}</label>
                <Input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="architect@lumi.ai"
                  className="bg-white/5 border-white/10 py-6 rounded-xl"
                />
              </div>
              {isGenesisMode ? (
                <div className="space-y-2">
                  <label className="text-xs font-bold text-white/40 uppercase tracking-widest">{t.secureChannelContact}</label>
                  <Input
                    required
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    placeholder="Signal / Telegram / WeChat"
                    className="bg-white/5 border-white/10 py-6 rounded-xl"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="text-xs font-bold text-white/40 uppercase tracking-widest">{t.quickAction || 'Quick Action'}</label>
                  <Button
                    type="button"
                    onClick={() => setIsGenesisMode(true)}
                    className="w-full py-6 bg-white/5 border border-white/10 text-white/60 hover:text-white rounded-xl transition-all"
                  >
                    {t.applyAsArchitect || 'Apply as Architect'}
                  </Button>
                </div>
              )}
            </div>

            {isGenesisMode && (
              <div className="space-y-2">
                <label className="text-xs font-bold text-white/40 uppercase tracking-widest">{t.fieldOfExpertise}</label>
                <Input
                  required
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  placeholder="e.g. Neural Protocol Architect"
                  className="bg-white/5 border-white/10 py-6 rounded-xl"
                />
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-bold text-white/40 uppercase tracking-widest">{t.yourManifesto}</label>
              <Textarea
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t.manifestoPlaceholder}
                className="bg-white/5 border-white/10 min-h-[120px] rounded-xl"
              />
            </div>

            <Button type="submit" className={`w-full py-8 ${isGenesisMode ? 'bg-celestial-saturn text-black' : 'bg-white/10 text-white'} font-black text-lg rounded-xl hover:scale-[1.01] transition-transform flex items-center justify-center gap-3 shadow-[0_0_30px_rgba(255,204,0,0.2)]`}>
              {isGenesisMode ? <Sprout size={24} /> : <Rocket size={24} />}
              {isGenesisMode ? t.submitManifesto : t.initiateConnection}
            </Button>
          </form>
        )}
      </GlassCard>

      {/* Strategic Roles */}
      <div className="space-y-8">
        <div className="flex items-center gap-4">
          <div className="h-px flex-1 bg-white/10" />
          <h2 className="text-2xl font-bold tracking-tight text-white/40 uppercase tracking-[0.2em]">{t.strategicRoles}</h2>
          <div className="h-px flex-1 bg-white/10" />
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          <JobCard 
            title={t.neuralProtocolResearcher} 
            desc={t.neuralProtocolDesc} 
            t={t}
            onClick={() => {
              setIsGenesisMode(true);
              setMessage(`I'm interested in the ${t.neuralProtocolResearcher} position.`);
              window.scrollTo({ top: 400, behavior: 'smooth' });
            }}
          />
          <JobCard 
            title={t.digitalRightsAdvocate} 
            desc={t.digitalRightsDesc} 
            t={t}
            onClick={() => {
              setIsGenesisMode(true);
              setMessage(`I'm interested in the ${t.digitalRightsAdvocate} position.`);
              window.scrollTo({ top: 400, behavior: 'smooth' });
            }}
          />
          <JobCard 
            title={t.meshInfrastructureEngineer} 
            desc={t.meshInfrastructureDesc} 
            t={t}
            onClick={() => {
              setIsGenesisMode(true);
              setMessage(`I'm interested in the ${t.meshInfrastructureEngineer} position.`);
              window.scrollTo({ top: 400, behavior: 'smooth' });
            }}
          />
          <JobCard 
            title={t.neuralNarrativeDesigner} 
            desc={t.neuralNarrativeDesc} 
            t={t}
            onClick={() => {
              setIsGenesisMode(true);
              setMessage(`I'm interested in the ${t.neuralNarrativeDesigner} position.`);
              window.scrollTo({ top: 400, behavior: 'smooth' });
            }}
          />
          <JobCard 
            title={t.meshSecuritySentinel} 
            desc={t.meshSecurityDesc} 
            t={t}
            onClick={() => {
              setIsGenesisMode(true);
              setMessage(`I'm interested in the ${t.meshSecuritySentinel} position.`);
              window.scrollTo({ top: 400, behavior: 'smooth' });
            }}
          />
          <JobCard 
            title={t.holographicSculptor} 
            desc={t.holographicSculptorDesc} 
            t={t}
            onClick={() => {
              setIsGenesisMode(true);
              setMessage(`I'm interested in the ${t.holographicSculptor} position.`);
              window.scrollTo({ top: 400, behavior: 'smooth' });
            }}
          />
        </div>
      </div>
    </motion.div>
  );
}

function ContributionTypeCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="p-4 rounded-2xl bg-white/5 border border-white/10 hover:border-white/20 transition-colors space-y-2">
      <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
        {icon}
      </div>
      <h4 className="font-bold text-sm">{title}</h4>
      <p className="text-xs text-white/40 leading-tight">{desc}</p>
    </div>
  );
}

function JobCard({ title, desc, t, onClick }: { title: string; desc: string; t: any; onClick: () => void }) {
  return (
    <GlassCard className="p-8 rounded-3xl space-y-6 flex flex-col h-full">
      <div className="space-y-2 flex-1">
        <h3 className="text-xl font-bold tracking-tight">{title}</h3>
        <p className="text-sm text-white/40 leading-relaxed">{desc}</p>
      </div>
      <Button 
        onClick={onClick}
        className="w-full rounded-2xl bg-white/5 border border-white/10 hover:bg-celestial-mars hover:text-white transition-all"
      >
        {t.applyNow}
      </Button>
    </GlassCard>
  );
}

function PillarCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <GlassCard className="p-6 rounded-2xl space-y-4 text-center">
      <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mx-auto">
        {icon}
      </div>
      <div className="space-y-1">
        <h4 className="font-bold">{title}</h4>
        <p className="text-xs text-white/40 leading-relaxed">{desc}</p>
      </div>
    </GlassCard>
  );
}

function PathStep({ number, title }: { number: string; title: string }) {
  return (
    <div className="flex flex-col items-center gap-4 relative z-10 bg-celestial-deep px-4">
      <div className="w-12 h-12 rounded-full border-2 border-celestial-nebula flex items-center justify-center text-celestial-nebula font-bold text-lg bg-celestial-deep">
        {number}
      </div>
      <p className="font-bold text-sm tracking-tight">{title}</p>
    </div>
  );
}

function EmailButton({ adminEmail, setAdminEmail, onUpdate, userRole, t }: { adminEmail: string; setAdminEmail: (v: string) => void; onUpdate: () => void; userRole?: string; t: any }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  return (
    <div className="relative">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="w-12 h-12 rounded-full glass flex items-center justify-center text-white/60 hover:text-white hover:scale-110 transition-all border-white/10"
      >
        <Mail size={20} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <motion.div 
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute bottom-full left-0 mb-4 w-72 glass border border-white/10 rounded-2xl p-4 z-50 shadow-2xl"
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-widest text-white/40 font-bold">{t.directContact || 'Direct Contact'}</p>
                  <a href="mailto:3565286431@qq.com" className="block text-sm text-white/80 hover:text-celestial-saturn transition-colors truncate">
                    3565286431@qq.com
                  </a>
                  <a href="mailto:maoxiansheng946@gmail.com" className="block text-sm text-white/80 hover:text-celestial-saturn transition-colors truncate">
                    maoxiansheng946@gmail.com
                  </a>
                </div>

                {userRole === 'admin' && (
                  <div className="pt-4 border-t border-white/10 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs uppercase tracking-widest text-celestial-saturn font-bold">{t.adminConfig || 'Admin Config'}</p>
                      {!isEditing && (
                        <button onClick={() => setIsEditing(true)} className="text-xs text-white/40 hover:text-white underline">{t.edit || 'Edit'}</button>
                      )}
                    </div>
                    
                    {isEditing ? (
                      <div className="space-y-2">
                        <input 
                          value={adminEmail}
                          onChange={(e) => setAdminEmail(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-celestial-saturn"
                          placeholder={t.adminEmail || "Admin Email"}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => { onUpdate(); setIsEditing(false); }}
                            className="flex-1 bg-celestial-saturn text-black text-xs font-bold py-1 rounded"
                          >
                            {t.save || 'Save'}
                          </button>
                          <button
                            onClick={() => setIsEditing(false)}
                            className="flex-1 bg-white/5 text-white text-xs py-1 rounded"
                          >
                            {t.cancel || 'Cancel'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-white/60 font-mono truncate">{adminEmail || "3565286431@qq.com"}</p>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

function SocialLink({ icon, href }: { icon: React.ReactNode; href: string }) {
  return (
    <a href={href} className="w-12 h-12 rounded-full glass flex items-center justify-center text-white/60 hover:text-white hover:scale-110 transition-all border-white/10">
      {icon}
    </a>
  );
}
