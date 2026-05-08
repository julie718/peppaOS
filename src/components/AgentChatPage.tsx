import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, MessageSquare, Loader2, ArrowLeft, Ghost, Zap, Cpu, Sparkles, Upload, FileText, Mic, Video, CheckCircle2, Pause, Play, Square, ChevronDown, History, Clock } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { socketService } from '@/services/socketService';
import { useTTS } from '@/hooks/useTTS';
import { GlassCard, PulseCounter } from './SharedUI';
import { toast } from 'sonner';
import { FoundersSanctuary } from './FoundersSanctuary';
import { usePlatform } from '@/hooks/usePlatform';
import { runAgentLogic, AgentResponse } from '@/services/agentService';
import { useApp } from '@/contexts/AppContext';
import { VoiceCallButton } from './VoiceCallButton';
import { useSocket } from '@/hooks/useSocket';
import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useVoiceCloning } from '@/hooks/useVoiceCloning';
import { listVoices } from '@/services/voiceService';

export function AgentChatPage({ t, user, agent, onBack }: { t: any; user: any; agent?: any; onBack: () => void }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [agentMetadata, setAgentMetadata] = useState<Partial<AgentResponse>>({});
  const { platform, isElectron } = usePlatform();
  const { aiConfig, personalityId } = useApp();
  const socket = useSocket();
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | undefined>();
  const [voices, setVoices] = useState<any[]>([]);
  const [showVoicePicker, setShowVoicePicker] = useState(false);

  const { callState, audioLevel, startCall, endCall, error: callError } = useVoiceCall({
    socket,
    onTranscript: (text, isFinal) => {
      if (isFinal) {
         // Optionally add to transcript view if separate from chat
      }
    },
    onResponse: (text) => {
      const agentMsg = {
        id: Date.now().toString(),
        text: text,
        userName: agentName,
        timestamp: new Date().toISOString(),
        type: 'agent'
      };
      setMessages(prev => [...prev, agentMsg]);
    }
  });

  useEffect(() => {
    listVoices().then(data => {
      const all = [...data.cloned, ...data.premade];
      setVoices(all);
      if (all.length > 0 && !selectedVoiceId) {
        setSelectedVoiceId(all[0].voiceId);
      }
    }).catch(err => toast.error('Failed to load voices'));
  }, [selectedVoiceId]);

  useEffect(() => {
    if (callError) toast.error(callError);
  }, [callError]);

  const [newMessage, setNewMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [optimizationProgress, setOptimizationProgress] = useState(0);
  const [activeConversation, setActiveConversation] = useState<any>(null);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const { speak, stop, pause, resume, isSpeaking, isPaused } = useTTS();
  const recognition = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const agentName = agent?.name || 'Lumi Essence';
  const agentCategory = agent?.category || 'friend';
  const agentId = agent?.id || 'lumi_default';

  const isFounder = agentId === 'founder' || agentCategory === 'founder' || agentName.includes('Founder') || agentName.includes('创始人');

  useEffect(() => {
    // Initialize Speech Recognition
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognition.current = new SpeechRecognition();
      recognition.current.continuous = false;
      recognition.current.interimResults = false;
      recognition.current.lang = 'zh-CN'; // Default to Chinese, can be dynamic

      recognition.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setNewMessage(transcript);
        setIsListening(false);
      };

      recognition.current.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setIsListening(false);
        toast.error(`Speech recognition error: ${event.error}`);
      };

      recognition.current.onend = () => {
        setIsListening(false);
      };
    }
  }, []);

  useEffect(() => {
    if (agentId && !isFounder) {
      // Load history for this agent's active conversation
      fetch(`/api/agents/${agentId}/history`)
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            const historyMessages = data.map((m: any, idx: number) => ({
              id: `history-${idx}`,
              text: m.content,
              userName: m.role === 'assistant' ? agentName : (user?.displayName || user?.username || 'User'),
              timestamp: new Date().toISOString(),
              type: m.role === 'assistant' ? 'agent' : 'user'
            }));
            setMessages(historyMessages);
          }
        })
        .catch(err => console.error("Failed to load chat history", err));

      // Check for active conversation
      fetch('/api/conversations/active')
        .then(res => res.json())
        .then(data => {
          if (data.activeConversation) {
            setActiveConversation(data.activeConversation);
            // If resume is for a different agent, show prompt
            if (data.activeConversation.agentId !== agentId) {
              setShowResumePrompt(true);
            }
          }
        })
        .catch(err => toast.error('Failed to load conversation'));
    }
  }, [agentId, agentName, user, isFounder]);

  const handleResumeConversation = useCallback(async (conversationId: string) => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages?limit=100`);
      const data = await res.json();
      if (data.messages && Array.isArray(data.messages)) {
        const historyMessages = data.messages.map((m: any, idx: number) => ({
          id: `resume-${idx}`,
          text: m.content || m.message || '',
          userName: m.role === 'assistant' ? agentName : (user?.displayName || user?.username || 'User'),
          timestamp: m.timestamp || new Date().toISOString(),
          type: m.role === 'assistant' ? 'agent' : 'user'
        }));
        setMessages(historyMessages);
      }
      setShowResumePrompt(false);
    } catch (err) {
      console.error("Failed to resume conversation", err);
    }
  }, [agentName, user]);

  useEffect(() => {
    if (isFounder || !socket) return; 

    socket.on("agent:response", (data: { text: string; agentName: string }) => {
      const agentMsg = {
        id: Date.now().toString(),
        text: data.text,
        userName: data.agentName,
        timestamp: new Date().toISOString(),
        type: 'agent'
      };
      setMessages(prev => [...prev, agentMsg]);
      speak(data.text);
    });

    socket.on("agent:status", (data: { status: string }) => {
      setIsTyping(data.status === "thinking");
    });

    return () => {
      socket.off("agent:response");
      socket.off("agent:status");
      stop();
    };
  }, [speak, stop, isFounder, socket]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !user) return;

    const userMsg = {
      id: Date.now().toString(),
      text: newMessage,
      userName: user.displayName || user.username || 'User',
      timestamp: new Date().toISOString(),
      type: 'user'
    };

    setMessages(prev => [...prev, userMsg]);
    setNewMessage('');
    stop();
    setIsTyping(true);

    try {
      const response = await runAgentLogic(newMessage, { platform, aiConfig });
      setAgentMetadata(response);

      const agentMsg = {
        id: Date.now().toString(),
        text: response.text,
        userName: agentName,
        timestamp: new Date().toISOString(),
        type: 'agent'
      };

      setMessages(prev => [...prev, agentMsg]);
      speak(response.text);

      // Persist new message pair via conversation-managed endpoint
      fetch(`/api/agents/${agentId}/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: userMsg.text },
            { role: 'assistant', content: response.text },
          ],
        }),
      }).catch(err => toast.error('Failed to save message'));
    } catch (err) {
      toast.error("Failed to route through Neural Mesh.");
    } finally {
      setIsTyping(false);
    }
  };

  const toggleListening = () => {
    if (!recognition.current) {
      toast.error("Speech recognition is not supported in this browser.");
      return;
    }

    if (isListening) {
      recognition.current.stop();
    } else {
      stop(); // Stop TTS if speaking
      recognition.current.start();
      setIsListening(true);
    }
  };

  const handleImportData = (type: 'text' | 'voice' | 'video') => {
    setIsOptimizing(true);
    setOptimizationProgress(0);
    
    const interval = setInterval(() => {
      setOptimizationProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setIsOptimizing(false);
          toast.success(t.optimizationSuccess || "Optimization complete. Neural essence updated.");
          return 100;
        }
        return prev + 10;
      });
    }, 300);
  };

  if (isFounder) {
    return <FoundersSanctuary t={t} user={user} onBack={onBack} />;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4 md:space-y-8 pb-32 md:pb-0">
      <div className="flex items-center justify-between px-4 md:px-0">
        <Button 
          onClick={onBack}
          variant="ghost"
          className="text-white/40 hover:text-white flex items-center gap-2 p-0 h-auto"
        >
          <ArrowLeft size={18} />
          <span className="text-xs font-bold uppercase tracking-widest">{t.back || 'Back'}</span>
        </Button>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowVoicePicker(!showVoicePicker)}
              className="text-[10px] font-black uppercase tracking-widest text-white/40 flex items-center gap-2 hover:text-celestial-saturn transition-colors"
            >
              {voices.find(v => v.voiceId === selectedVoiceId)?.name || 'Select Voice'}
              <ChevronDown size={12} />
            </Button>
            
            <AnimatePresence>
              {showVoicePicker && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute top-full left-0 mt-2 w-48 bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl p-2 z-50 shadow-2xl max-h-64 overflow-y-auto custom-scrollbar"
                >
                  {voices.map(v => (
                    <button
                      key={v.voiceId}
                      onClick={() => {
                        setSelectedVoiceId(v.voiceId);
                        setShowVoicePicker(false);
                      }}
                      className={`w-full text-left p-2 rounded-xl text-[10px] font-bold uppercase transition-all ${
                        selectedVoiceId === v.voiceId ? 'bg-celestial-saturn text-black' : 'text-white/60 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      {v.name}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <VoiceCallButton 
            callState={callState}
            audioLevel={audioLevel}
            onStart={() => startCall(selectedVoiceId, personalityId)}
            onEnd={endCall}
            hasVoice={voices.length > 0}
          />
          <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl bg-celestial-saturn/20 flex items-center justify-center text-celestial-saturn border border-celestial-saturn/20">
            <Ghost className="w-4 h-4 md:w-5 md:h-5" />
          </div>
          <div className="text-right sm:text-left">
            <h2 className="text-base md:text-xl font-bold tracking-tight truncate max-w-[120px] sm:max-w-none">{agentName}</h2>
            <p className="text-[8px] md:text-[10px] uppercase tracking-widest text-white/40 font-bold">{agentCategory}</p>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6 md:gap-8 lg:h-[700px]">
        <div className="lg:col-span-2 flex flex-col h-[500px] md:h-full glass rounded-[2.5rem] md:rounded-[3rem] border-white/10 overflow-hidden shadow-2xl">
          <div className="p-4 md:p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${isSpeaking ? 'bg-celestial-nebula animate-ping' : 'bg-celestial-saturn animate-pulse'}`} />
              <span className="text-[10px] md:text-xs font-bold uppercase tracking-widest text-white/60">Neural Link</span>
              {isSpeaking && (
                <div className="flex items-center gap-3 ml-2 md:ml-4 scale-75 md:scale-100 origin-left">
                  <div className="flex items-end gap-1 h-4">
                    {[...Array(5)].map((_, i) => (
                      <motion.div
                        key={i}
                        animate={{ height: [4, 16, 4] }}
                        transition={{ 
                          duration: 0.5 + Math.random() * 0.5, 
                          repeat: Infinity,
                          ease: "easeInOut"
                        }}
                        className="w-1 bg-celestial-nebula rounded-full"
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button 
                      onClick={isPaused ? resume : pause}
                      className="h-6 px-2 text-[8px] bg-white/10 text-white hover:bg-white/20 rounded-full border border-white/10 flex items-center gap-1"
                    >
                      {isPaused ? <Play size={10} /> : <Pause size={10} />}
                    </Button>
                    <Button 
                      onClick={stop}
                      className="h-6 px-2 text-[8px] bg-red-500/20 text-red-500 hover:bg-red-500/40 rounded-full border border-red-500/20 flex items-center gap-1"
                    >
                      <Square size={10} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4 md:space-y-6 scrollbar-hide"
          >
            {/* Resume conversation prompt */}
            {showResumePrompt && activeConversation && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-amber-500/20 flex items-center justify-center">
                    <History size={16} className="text-amber-400" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-amber-300 uppercase tracking-tight">Unfinished conversation</p>
                    <p className="text-[10px] text-white/40 flex items-center gap-1">
                      <Clock size={10} />
                      {new Date(activeConversation.lastActiveAt).toLocaleString()}
                      {activeConversation.messageCount > 0 && (
                        <span> &middot; {activeConversation.messageCount} messages</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => handleResumeConversation(activeConversation.id)}
                    className="bg-amber-500 text-black font-bold text-[10px] px-3 py-1.5 rounded-xl hover:scale-105 transition-transform"
                  >
                    Continue
                  </Button>
                  <Button
                    onClick={() => setShowResumePrompt(false)}
                    variant="ghost"
                    className="text-white/20 hover:text-white/60 text-[10px] px-2"
                  >
                    New
                  </Button>
                </div>
              </motion.div>
            )}

            {/* Active conversation indicator */}
            {activeConversation && !showResumePrompt && activeConversation.agentId === agentId && activeConversation.messageCount > 0 && (
              <div className="flex items-center gap-2 text-[9px] text-white/20 font-bold uppercase tracking-widest">
                <History size={10} />
                <span>{activeConversation.messageCount} messages</span>
                <span>&middot;</span>
                <span>Last active {new Date(activeConversation.lastActiveAt).toLocaleString()}</span>
              </div>
            )}
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-20">
                <Sparkles size={64} className="text-celestial-saturn" />
                <p className="text-lg font-medium">Your agent has awakened.<br/>Begin the first conversation.</p>
              </div>
            )}
            <AnimatePresence initial={false}>
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex flex-col ${msg.type === 'agent' ? 'items-start' : 'items-end'}`}
                >
                  <div className={`max-w-[85%] p-5 rounded-3xl text-sm leading-relaxed ${
                    msg.type === 'agent' 
                      ? 'bg-celestial-saturn/10 text-celestial-saturn border border-celestial-saturn/20 rounded-tl-none' 
                      : 'bg-white/5 text-white/80 border border-white/10 rounded-tr-none'
                  }`}>
                    {msg.text}
                  </div>
                  <span className="text-[9px] uppercase tracking-widest opacity-30 mt-2 px-3">
                    {msg.userName} • {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
            {isTyping && (
              <div className="flex flex-col gap-3">
                <div className="flex gap-2 items-center text-celestial-saturn/40 text-[10px] font-bold uppercase tracking-widest">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  >
                    <Loader2 size={14} />
                  </motion.div>
                  Neural Processing...
                </div>
                <div className="flex gap-1">
                  {[...Array(3)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ 
                        scale: [1, 1.5, 1],
                        opacity: [0.3, 1, 0.3]
                      }}
                      transition={{ 
                        duration: 1, 
                        repeat: Infinity, 
                        delay: i * 0.2 
                      }}
                      className="w-1.5 h-1.5 rounded-full bg-celestial-saturn"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="p-6 bg-white/5 border-t border-white/5">
            <form onSubmit={handleSendMessage} className="relative flex gap-3">
              <div className="relative flex-1">
                <Input
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Communicate with your essence..."
                  className="bg-black/40 border-white/10 rounded-2xl py-6 pr-12 focus-visible:ring-celestial-saturn/50"
                />
                <Button
                  type="button"
                  onClick={toggleListening}
                  variant="ghost"
                  className={`absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 p-0 rounded-full transition-colors ${
                    isListening ? 'text-celestial-mars bg-celestial-mars/20 animate-pulse' : 'text-white/40 hover:text-white'
                  }`}
                >
                  <Mic size={18} />
                </Button>
              </div>
              <Button 
                type="submit" 
                disabled={isTyping || !newMessage.trim()}
                className="bg-celestial-saturn text-black rounded-2xl px-6 hover:scale-105 transition-transform disabled:opacity-50 disabled:hover:scale-100"
              >
                <Send size={20} />
              </Button>
            </form>
          </div>
        </div>

        <div className="space-y-6">
          <GlassCard className="p-6 rounded-[2.5rem] space-y-4 border-celestial-saturn/20" hoverEffect={false}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">Active Capabilities</h4>
              {isElectron && (
                <div className="px-2 py-0.5 rounded-full bg-celestial-saturn/20 text-[8px] text-celestial-saturn font-black">NODE_NATIVE</div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {(agentMetadata.capabilities || ['Neural Core', 'Web Mesh']).map((cap, i) => (
                <div key={i} className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/5 text-[10px] text-white/60 font-bold flex items-center gap-2">
                  <div className="w-1 h-1 rounded-full bg-celestial-saturn" />
                  {cap}
                </div>
              ))}
            </div>
          </GlassCard>

          <GlassCard className="p-6 rounded-[2.5rem] space-y-4" hoverEffect={false}>
            <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">{t.optimizeKnowledge || 'Knowledge Optimization'}</h4>
            <div className="grid grid-cols-1 gap-3">
              <Button 
                onClick={() => handleImportData('text')}
                disabled={isOptimizing}
                variant="ghost" 
                className="w-full justify-start gap-3 bg-white/5 border border-white/5 hover:bg-white/10 rounded-2xl py-6"
              >
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center text-blue-400">
                  <FileText size={16} />
                </div>
                <div className="text-left">
                  <div className="text-sm font-bold">{t.textData || 'Text'}</div>
                  <div className="text-[10px] opacity-40">PDF, TXT, DOCX</div>
                </div>
              </Button>

              <Button 
                onClick={() => handleImportData('voice')}
                disabled={isOptimizing}
                variant="ghost" 
                className="w-full justify-start gap-3 bg-white/5 border border-white/5 hover:bg-white/10 rounded-2xl py-6"
              >
                <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center text-purple-400">
                  <Mic size={16} />
                </div>
                <div className="text-left">
                  <div className="text-sm font-bold">{t.voiceData || 'Voice'}</div>
                  <div className="text-[10px] opacity-40">MP3, WAV, M4A</div>
                </div>
              </Button>

              <Button 
                onClick={() => handleImportData('video')}
                disabled={isOptimizing}
                variant="ghost" 
                className="w-full justify-start gap-3 bg-white/5 border border-white/5 hover:bg-white/10 rounded-2xl py-6"
              >
                <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center text-red-400">
                  <Video size={16} />
                </div>
                <div className="text-left">
                  <div className="text-sm font-bold">{t.videoData || 'Video'}</div>
                  <div className="text-[10px] opacity-40">MP4, MOV, AVI</div>
                </div>
              </Button>
            </div>

            {isOptimizing && (
              <div className="space-y-2 pt-2">
                <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest">
                  <span className="text-celestial-saturn animate-pulse">Optimizing...</span>
                  <span>{optimizationProgress}%</span>
                </div>
                <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-celestial-saturn"
                    initial={{ width: 0 }}
                    animate={{ width: `${optimizationProgress}%` }}
                  />
                </div>
              </div>
            )}
          </GlassCard>

          <GlassCard className="p-6 rounded-[2.5rem] space-y-4" hoverEffect={false}>
            <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">Agent Stats</h4>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 flex items-center gap-2"><Cpu size={14}/> Logic Engine</span>
                <span className="text-sm font-bold text-celestial-saturn">v1.0.2</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 flex items-center gap-2"><Zap size={14}/> Sync Speed</span>
                <span className="text-sm font-bold text-celestial-mars">8.4ms</span>
              </div>
            </div>
          </GlassCard>

          <GlassCard className="p-6 rounded-[2.5rem] space-y-4" hoverEffect={false}>
            <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">Neural Mesh Status</h4>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-bold">Encrypted Link Active</span>
            </div>
            <p className="text-xs text-white/40 leading-relaxed">
              Your agent is currently synchronized with the local node. All interactions are stored in your private neural cloud.
            </p>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
