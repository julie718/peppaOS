import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Building2, Key, ArrowRight, CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';

export function JoinOrgPage() {
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'input' | 'preview' | 'joining' | 'done' | 'error'>('input');
  const [orgInfo, setOrgInfo] = useState<any>(null);
  const [error, setError] = useState('');

  const handleValidate = async () => {
    if (code.length < 6) return;
    try {
      const res = await fetch(`/api/enterprise/invitations/${code.toUpperCase()}`, { credentials: 'include' });
      const data = await res.json();
      if (data.valid) {
        setOrgInfo(data);
        setStep('preview');
      } else {
        setError(data.error || 'Invalid invitation code');
        setStep('error');
      }
    } catch {
      setError('Unable to reach the organization server');
      setStep('error');
    }
  };

  const handleJoin = async () => {
    setStep('joining');
    try {
      const res = await fetch(`/api/enterprise/invitations/${code.toUpperCase()}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setStep('done');
        // Reload to apply org context
        setTimeout(() => window.location.reload(), 1500);
      } else {
        setError(data.error || 'Failed to join');
        setStep('error');
      }
    } catch {
      setError('Connection failed — please try again');
      setStep('error');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-celestial-deep to-black p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8"
      >
        <div className="text-center mb-8">
          <Building2 size={48} className="mx-auto text-blue-400 mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Join an Organization</h1>
          <p className="text-white/50 text-sm">Enter the 8-character invitation code from your admin</p>
        </div>

        {step === 'input' && (
          <div className="space-y-4">
            <input
              type="text"
              value={code}
              onChange={e => { setCode(e.target.value.toUpperCase().slice(0, 8)); setError(''); }}
              placeholder="ABCD1234"
              maxLength={8}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white text-center text-2xl tracking-[0.3em] font-mono placeholder:text-white/20 focus:outline-none focus:border-blue-500/50"
            />
            {error && (
              <p className="text-red-400 text-sm text-center flex items-center justify-center gap-1">
                <AlertCircle size={14} /> {error}
              </p>
            )}
            <Button
              onClick={handleValidate}
              disabled={code.length < 6}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-xl py-3"
            >
              Validate Code <ArrowRight size={16} className="ml-2" />
            </Button>
            <button
              onClick={() => setStep('input')}
              className="w-full text-center text-white/30 text-sm hover:text-white/50"
            >
              Already joined? Reload the page to pick up your organization context.
            </button>
          </div>
        )}

        {step === 'preview' && orgInfo && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 text-center">
              <Building2 size={32} className="mx-auto text-blue-400 mb-2" />
              <h2 className="text-xl font-semibold text-white">{orgInfo.org.name}</h2>
              <p className="text-white/40 text-sm">Role: {orgInfo.role}</p>
            </div>
            <Button onClick={handleJoin} className="w-full bg-green-600 hover:bg-green-500 text-white rounded-xl py-3">
              Join <CheckCircle size={16} className="ml-2" />
            </Button>
            <button onClick={() => setStep('input')} className="w-full text-center text-white/30 text-sm hover:text-white/50">
              Cancel
            </button>
          </motion.div>
        )}

        {step === 'joining' && (
          <div className="text-center py-8">
            <Loader2 size={40} className="mx-auto animate-spin text-blue-400 mb-4" />
            <p className="text-white/50">Joining organization...</p>
          </div>
        )}

        {step === 'done' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-8">
            <CheckCircle size={48} className="mx-auto text-green-400 mb-4" />
            <p className="text-white font-semibold">Successfully joined!</p>
            <p className="text-white/40 text-sm mt-1">Reloading with new organization context...</p>
          </motion.div>
        )}

        {step === 'error' && (
          <div className="text-center space-y-4">
            <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
            <p className="text-red-400">{error}</p>
            <Button onClick={() => { setStep('input'); setError(''); }} className="bg-white/10 hover:bg-white/20 text-white rounded-xl">
              Try Again
            </Button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
