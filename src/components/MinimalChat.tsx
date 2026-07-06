import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Camera, Send, LogOut, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { useSocket } from '@/hooks/useSocket';
import { useVoiceCall } from '@/hooks/useVoiceCall';
import { LoginModal } from '@/core/components/Auth';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

export function MinimalChat() {
  const { user, loading, logout, refreshUser } = useApp();
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const socket = useSocket();
  const { callState, startCall, endCall, transcript } = useVoiceCall({
    socket,
    onTranscript: (text, isFinal) => {
      if (isFinal && text.trim()) {
        sendMessage(text.trim());
      }
    },
    onResponse: (text) => {
      // Response text is handled via socket agent:response
    },
  });

  const isCallActive = callState !== 'idle';

  // Scroll to bottom
  const scrollToBottom = (smooth = false) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  };

  // Handle scroll button visibility
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(dist > 100);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load messages when user logs in
  useEffect(() => {
    if (!user || !socket) return;
    setMessages([]);

    // Load recent conversation
    fetch('/api/conversations/active')
      .then(r => r.json())
      .then(data => {
        if (data.conversationId) {
          return fetch(`/api/conversations/${data.conversationId}/messages?limit=50`);
        }
        return null;
      })
      .then(r => r?.json())
      .then(data => {
        if (data?.messages) {
          const msgs = data.messages
            .filter((m: any) => m.role === 'user' || m.role === 'assistant')
            .map((m: any) => ({
              id: m.id || String(Math.random()),
              role: m.role,
              content: m.message || m.response || m.content || '',
              timestamp: new Date(m.timestamp || Date.now()).getTime(),
            }));
          setMessages(msgs);
        }
      })
      .catch(() => {});
  }, [user, socket]);

  // Listen for incoming messages
  useEffect(() => {
    if (!socket) return;

    const onResponse = (data: { text: string; agentName?: string }) => {
      if (data.text) {
        setMessages(prev => [...prev, {
          id: String(Date.now()),
          role: 'assistant',
          content: data.text,
          timestamp: Date.now(),
        }]);
      }
    };

    const onChunk = (data: { text: string }) => {
      if (data.text) {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.id.startsWith('stream-')) {
            const updated = [...prev];
            updated[updated.length - 1] = { ...last, content: last.content + data.text };
            return updated;
          }
          return [...prev, { id: 'stream-' + Date.now(), role: 'assistant', content: data.text, timestamp: Date.now() }];
        });
      }
    };

    socket.on('agent:response', onResponse);
    socket.on('agent:chunk', onChunk);
    return () => {
      socket.off('agent:response', onResponse);
      socket.off('agent:chunk', onChunk);
    };
  }, [socket]);

  const sendMessage = (text: string) => {
    if (!text.trim() || !socket) return;
    const msg: Message = { id: String(Date.now()), role: 'user', content: text, timestamp: Date.now() };
    setMessages(prev => [...prev, msg]);
    setInput('');
    setSending(true);

    socket.emit('agent:chat', {
      message: text,
      personalityId: 'peppa',
      agentId: 'peppa',
      mode: 'text',
    });

    setTimeout(() => setSending(false), 500);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleVoiceToggle = () => {
    if (isCallActive) {
      endCall();
    } else {
      startCall(undefined, 'peppa', 'peppa');
    }
  };

  const handleCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      // Create a temporary video element to capture a frame
      const video = document.createElement('video');
      video.srcObject = stream;
      video.play();

      video.onloadeddata = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')!.drawImage(video, 0, 0);
        const base64 = canvas.toDataURL('image/jpeg', 0.8);
        stream.getTracks().forEach(t => t.stop());

        // Send to chat with vision prompt
        if (socket) {
          socket.emit('agent:chat', {
            message: '[用户拍摄了一张照片]',
            personalityId: 'peppa',
            agentId: 'peppa',
            mode: 'text',
            images: [base64],
          });
          setMessages(prev => [...prev, {
            id: String(Date.now()),
            role: 'user',
            content: '📷 拍摄了一张照片',
            timestamp: Date.now(),
          }]);
        }
      };
    } catch (err: any) {
      toast.error('无法访问相机：' + (err.message || '权限被拒绝'));
    }
  };

  const handleLogout = () => {
    logout();
    setMessages([]);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-dvh bg-black">
        <motion.div
          animate={{ scale: [1, 1.05, 1], opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="w-3 h-3 rounded-full bg-white/80"
        />
      </div>
    );
  }

  return (
    <div className="h-dvh flex flex-col bg-black text-white overflow-hidden" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center text-sm font-bold">
            M
          </div>
          <span className="font-semibold text-sm">MayOS</span>
        </div>
        {user && (
          <button onClick={handleLogout} className="p-2 rounded-full hover:bg-white/10 transition-colors">
            <LogOut size={18} className="text-white/50" />
          </button>
        )}
      </header>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
      >
        {!user ? (
          <div className="flex flex-col items-center justify-center h-full gap-6 text-center px-8">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <span className="text-2xl font-black">M</span>
            </div>
            <div>
              <h1 className="text-xl font-bold mb-1">MayOS</h1>
              <p className="text-white/40 text-sm">你的个人 AI 伙伴</p>
            </div>
            <button
              onClick={() => setIsLoginOpen(true)}
              className="px-8 py-3 rounded-full bg-white text-black font-semibold text-sm hover:bg-white/90 transition-colors active:scale-95"
            >
              开始使用
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-4">
              <span className="text-white/30 text-xl">💬</span>
            </div>
            <p className="text-white/30 text-sm">发送一条消息开始对话</p>
            <p className="text-white/15 text-xs mt-2">或点击下方麦克风开始语音</p>
          </div>
        ) : (
          <>
            {messages.map(msg => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-white text-black rounded-br-md'
                      : 'bg-white/10 text-white/90 rounded-bl-md'
                  }`}
                >
                  {msg.content}
                </div>
              </motion.div>
            ))}
            {sending && (
              <div className="flex justify-end">
                <div className="bg-white/20 rounded-full px-4 py-2 flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </>
        )}

        {/* Scroll to bottom button */}
        <AnimatePresence>
          {showScrollBtn && (
            <motion.button
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              onClick={() => scrollToBottom(true)}
              className="absolute bottom-28 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full bg-white/20 backdrop-blur flex items-center justify-center active:scale-90 transition-transform"
            >
              <ChevronDown size={20} className="text-white/80" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Input area */}
      {user && (
        <div className="shrink-0 px-3 pb-3 pt-2 border-t border-white/10">
          {/* Voice call status */}
          {isCallActive && (
            <div className="flex items-center justify-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs text-white/50">
                {callState === 'listening' ? '正在听...' : callState === 'thinking' ? '思考中...' : callState === 'speaking' ? '回复中...' : transcript || '通话中...'}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            {/* Camera button */}
            <button
              onClick={handleCamera}
              className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center active:scale-90 transition-transform hover:bg-white/15 shrink-0"
            >
              <Camera size={20} className="text-white/70" />
            </button>

            {/* Text input */}
            <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2 bg-white/10 rounded-full px-4 h-10">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="输入消息..."
                className="flex-1 bg-transparent text-sm text-white placeholder-white/30 outline-none"
                autoComplete="off"
                enterKeyHint="send"
              />
              {input.trim() && (
                <button type="submit" className="shrink-0">
                  <Send size={18} className="text-white/60" />
                </button>
              )}
            </form>

            {/* Voice button */}
            <button
              onClick={handleVoiceToggle}
              className={`w-10 h-10 rounded-full flex items-center justify-center active:scale-90 transition-all shrink-0 ${
                isCallActive
                  ? 'bg-red-500 shadow-lg shadow-red-500/30'
                  : 'bg-white/10 hover:bg-white/15'
              }`}
            >
              {isCallActive ? <MicOff size={20} className="text-white" /> : <Mic size={20} className="text-white/70" />}
            </button>
          </div>
        </div>
      )}

      {/* Login Modal */}
      <LoginModal
        t={{}}
        isOpen={isLoginOpen}
        onClose={() => setIsLoginOpen(false)}
        onLoginSuccess={() => {
          setIsLoginOpen(false);
          refreshUser();
        }}
        onGoogleLogin={() => {}}
      />
    </div>
  );
}
