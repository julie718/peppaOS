// Socket event listener hook — converts existing agent:* events into canvas cards
import { useCallback, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { CanvasCard } from './types';

interface UseCanvasSocketOptions {
  socket: Socket | null;
  onCards: (cards: CanvasCard[]) => void;
  onStatusChange: (status: string) => void;
}

export function useCanvasSocket({ socket, onCards, onStatusChange }: UseCanvasSocketOptions) {
  const cardsRef = useRef<CanvasCard[]>([]);
  const groupIdRef = useRef<string>('');
  const pendingChunkRef = useRef<string>('');
  const chunkCardIdRef = useRef<string | null>(null);
  const rafRef = useRef<number>(0);
  const pendingRef = useRef(false);

  const flush = useCallback(() => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    onCards([...cardsRef.current]);
  }, [onCards]);

  const scheduleFlush = useCallback(() => {
    pendingRef.current = true;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      flush();
    });
  }, [flush]);

  const addCard = useCallback((card: CanvasCard) => {
    cardsRef.current = [...cardsRef.current, card];
    scheduleFlush();
  }, [scheduleFlush]);

  const updateCard = useCallback((cardId: string, updates: Partial<CanvasCard>) => {
    cardsRef.current = cardsRef.current.map(c =>
      c.id === cardId ? { ...c, ...updates } : c
    );
    scheduleFlush();
  }, [scheduleFlush]);

  const clearCards = useCallback(() => {
    cardsRef.current = [];
    chunkCardIdRef.current = null;
    pendingChunkRef.current = '';
    onCards([]);
  }, [onCards]);

  const newGroupId = useCallback(() => {
    groupIdRef.current = `group_${Date.now()}`;
    return groupIdRef.current;
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onStatus = (data: { status: string; agentName?: string }) => {
      onStatusChange(data.status);

      if (data.status === 'thinking') {
        addCard({
          id: `stage_${Date.now()}`,
          type: 'stage_header',
          text: data.agentName ? `${data.agentName}` : 'Analyzing...',
          timestamp: Date.now(),
          groupId: groupIdRef.current,
          status: 'running',
        });
      }

      if (data.status === 'idle' || data.status === 'error') {
        // Flush any pending reasoning chunk
        if (chunkCardIdRef.current && pendingChunkRef.current) {
          updateCard(chunkCardIdRef.current, {
            text: pendingChunkRef.current,
            status: 'done',
          });
          chunkCardIdRef.current = null;
          pendingChunkRef.current = '';
        }
        // Mark running tool calls as done/error
        cardsRef.current = cardsRef.current.map(c =>
          c.status === 'running' && c.type === 'stage_header'
            ? { ...c, status: data.status === 'error' ? 'error' as const : 'done' as const }
            : c
        );
        scheduleFlush();
      }
    };

    const onChunk = (data: { text: string }) => {
      if (!data.text) return;
      pendingChunkRef.current += data.text;

      if (!chunkCardIdRef.current) {
        const id = `reasoning_${Date.now()}`;
        chunkCardIdRef.current = id;
        addCard({
          id,
          type: 'reasoning_text',
          text: pendingChunkRef.current,
          timestamp: Date.now(),
          groupId: groupIdRef.current,
          status: 'running',
        });
      } else {
        updateCard(chunkCardIdRef.current, { text: pendingChunkRef.current });
      }
    };

    const onTool = (data: { name: string; args?: any; arguments?: any; result?: string; error?: string }) => {
      const toolName = data.name || 'unknown_tool';
      const toolArgs = data.args || data.arguments;
      const argsStr = toolArgs ? JSON.stringify(toolArgs).slice(0, 200) : '';

      const id = `tool_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      addCard({
        id,
        type: 'tool_call',
        text: toolName,
        detail: argsStr,
        timestamp: Date.now(),
        groupId: groupIdRef.current,
        status: data.error ? 'error' : (data.result ? 'done' : 'running'),
        metadata: { toolName, args: toolArgs, result: data.result?.slice(0, 500), error: data.error },
      });
    };

    // Both event names are used by different server paths
    const onToolCall = (data: { name: string; arguments?: any; result?: string; error?: string }) => {
      onTool(data);
    };

    const onTaskChunk = (data: { text: string; agentName?: string }) => {
      if (!data.text) return;
      const prefix = data.agentName === 'Lumi Orchestrator' || data.text.includes('[Orchestrator]') ? '' : '';
      addCard({
        id: `task_${Date.now()}`,
        type: 'reasoning_text',
        text: prefix ? `${prefix} ${data.text}` : data.text,
        timestamp: Date.now(),
        groupId: groupIdRef.current,
      });
    };

    const onResponse = (data: { text: string; agentName?: string }) => {
      if (!data.text) return;

      // Finalize any running stream chunk
      if (chunkCardIdRef.current) {
        updateCard(chunkCardIdRef.current, { status: 'done' });
        chunkCardIdRef.current = null;
        pendingChunkRef.current = '';
      }

      addCard({
        id: `output_${Date.now()}`,
        type: 'final_output',
        text: data.text,
        timestamp: Date.now(),
        groupId: groupIdRef.current,
        status: 'done',
        metadata: { agentName: data.agentName },
      });
    };

    const onError = (data: { message: string; code?: string }) => {
      addCard({
        id: `error_${Date.now()}`,
        type: 'error',
        text: data.message || 'Unknown error',
        detail: data.code,
        timestamp: Date.now(),
        groupId: groupIdRef.current,
        status: 'error',
      });
    };

    const onProactive = (data: { type?: string; message: string }) => {
      if (data.type === 'distill_hint') {
        addCard({
          id: `proactive_${Date.now()}`,
          type: 'stage_header',
          text: data.message,
          timestamp: Date.now(),
          groupId: groupIdRef.current,
          metadata: { proactiveType: data.type },
        });
      }
    };

    socket.on('agent:status', onStatus);
    socket.on('agent:chunk', onChunk);
    socket.on('agent:tool', onTool);
    socket.on('agent:tool_call', onToolCall);
    socket.on('task:chunk', onTaskChunk);
    socket.on('agent:response', onResponse);
    socket.on('agent:error', onError);
    socket.on('agent:proactive', onProactive);

    return () => {
      socket.off('agent:status', onStatus);
      socket.off('agent:chunk', onChunk);
      socket.off('agent:tool', onTool);
      socket.off('agent:tool_call', onToolCall);
      socket.off('task:chunk', onTaskChunk);
      socket.off('agent:response', onResponse);
      socket.off('agent:error', onError);
      socket.off('agent:proactive', onProactive);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [socket, addCard, updateCard, scheduleFlush, onStatusChange]);

  const submitTask = useCallback((text: string) => {
    if (!socket?.connected || !text.trim()) return;

    const groupId = newGroupId();
    clearCards();

    // Add user request card
    addCard({
      id: `user_${Date.now()}`,
      type: 'user_request',
      text: text.trim(),
      timestamp: Date.now(),
      groupId,
      status: 'done',
    });

    socket.emit('agent:chat', {
      text: text.trim(),
      history: [],
      personalityId: 'lumi',
      category: undefined,
      agentId: undefined,
      domain: undefined,
      orgId: null,
    });
  }, [socket, newGroupId, clearCards, addCard]);

  return { submitTask, clearCards };
}
