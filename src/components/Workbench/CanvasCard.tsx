import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  User, Layers, Wrench, Link, FileImage, MessageSquare,
  AlertCircle, CheckCircle2, Loader2, XCircle, RefreshCw
} from 'lucide-react';
import { PositionedCard } from './types';

interface CanvasCardProps {
  card: PositionedCard;
  onRetry?: (cardId: string) => void;
}

export function CanvasCard({ card, onRetry }: CanvasCardProps) {
  const [hovered, setHovered] = useState(false);

  const style: React.CSSProperties = {
    position: 'absolute',
    left: card.x,
    top: card.y,
    width: card.width,
    height: card.height,
  };

  const typeConfig = getTypeConfig(card);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`group flex flex-col overflow-hidden rounded-xl border shadow-lg backdrop-blur-sm ${typeConfig.bg} ${typeConfig.border}`}
    >
      {/* Header */}
      <div className={`flex shrink-0 items-center gap-2 border-b px-4 py-2.5 ${typeConfig.headerBg}`}>
        <span className={typeConfig.iconColor}>{typeConfig.icon}</span>
        <span className="text-xs font-semibold tracking-wide uppercase text-white/70">{typeConfig.label}</span>
        {card.status && <StatusBadge status={card.status} />}
        {hovered && onRetry && (
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(card.id); }}
            className="ml-auto flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg px-2 py-1 transition-colors"
          >
            <RefreshCw size={10} /> Retry from here
          </button>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {card.type === 'tool_call' ? (
          <div>
            <div className="text-sm font-medium text-white/90">{card.text}</div>
            {card.detail && (
              <div className="mt-1.5 text-xs text-white/50 font-mono bg-black/20 rounded-lg p-2 overflow-hidden text-ellipsis whitespace-pre-wrap max-h-24 overflow-y-auto">
                {card.detail}
              </div>
            )}
            {card.metadata?.result && (
              <div className="mt-2 text-xs text-emerald-400/80 font-mono bg-emerald-500/5 rounded-lg p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
                {card.metadata.result}
              </div>
            )}
            {card.metadata?.error && (
              <div className="mt-2 text-xs text-red-400/80 font-mono bg-red-500/5 rounded-lg p-2 whitespace-pre-wrap">
                {card.metadata.error}
              </div>
            )}
          </div>
        ) : card.type === 'artifact' ? (
          <div>
            <div className="text-sm font-medium text-white/90">{card.text}</div>
            {card.metadata?.filepath && (
              <div className="mt-1.5 text-xs text-cyan-400/80 font-mono bg-cyan-500/5 rounded-lg p-2">
                {card.metadata.filepath}
              </div>
            )}
          </div>
        ) : card.type === 'source_citation' ? (
          <div>
            <div className="text-sm font-medium text-white/90">{card.text}</div>
            {card.metadata?.url && (
              <div className="mt-1.5 text-xs text-blue-400/80 truncate">{card.metadata.url}</div>
            )}
          </div>
        ) : (
          <div className={`text-sm leading-relaxed whitespace-pre-wrap break-words ${card.type === 'reasoning_text' ? 'text-white/70' : card.type === 'error' ? 'text-red-300' : card.type === 'final_output' ? 'text-white/90' : 'text-white/80'}`}>
            {card.text.length > 2000 ? card.text.slice(0, 2000) + '...' : card.text}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-white/[0.03] px-4 py-1.5 text-[10px] text-white/25">
        <span>{new Date(card.timestamp).toLocaleTimeString()}</span>
        <span className="opacity-0 group-hover:opacity-100 transition-opacity text-white/15 text-[9px]">#{card.id.slice(-6)}</span>
      </div>
    </motion.div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-400">
        <Loader2 size={10} className="animate-spin" /> Running
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-400">
        <CheckCircle2 size={10} /> Done
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="ml-auto flex items-center gap-1 text-[10px] text-red-400">
        <XCircle size={10} /> Error
      </span>
    );
  }
  return null;
}

function getTypeConfig(card: PositionedCard) {
  switch (card.type) {
    case 'user_request':
      return {
        icon: <User size={14} />,
        iconColor: 'text-blue-400',
        label: 'Task',
        bg: 'bg-blue-500/5',
        border: 'border-blue-400/20',
        headerBg: 'border-blue-400/15 bg-blue-500/10',
      };
    case 'stage_header':
      return {
        icon: <Layers size={14} />,
        iconColor: 'text-violet-400',
        label: 'Stage',
        bg: 'bg-violet-500/5',
        border: 'border-violet-400/20',
        headerBg: 'border-violet-400/15 bg-violet-500/10',
      };
    case 'tool_call':
      return {
        icon: <Wrench size={14} />,
        iconColor: 'text-amber-400',
        label: 'Tool',
        bg: 'bg-amber-500/5',
        border: card.status === 'error' ? 'border-red-400/30' : card.status === 'done' ? 'border-emerald-400/20' : 'border-amber-400/20',
        headerBg: card.status === 'error' ? 'border-red-400/15 bg-red-500/10' : card.status === 'done' ? 'border-emerald-400/15 bg-emerald-500/10' : 'border-amber-400/15 bg-amber-500/10',
      };
    case 'source_citation':
      return {
        icon: <Link size={14} />,
        iconColor: 'text-blue-300',
        label: 'Source',
        bg: 'bg-blue-500/5',
        border: 'border-blue-400/15',
        headerBg: 'border-blue-400/10 bg-blue-500/8',
      };
    case 'artifact':
      return {
        icon: <FileImage size={14} />,
        iconColor: 'text-cyan-400',
        label: 'Artifact',
        bg: 'bg-cyan-500/5',
        border: 'border-cyan-400/20',
        headerBg: 'border-cyan-400/15 bg-cyan-500/10',
      };
    case 'reasoning_text':
      return {
        icon: <MessageSquare size={14} />,
        iconColor: 'text-white/50',
        label: 'Reasoning',
        bg: 'bg-white/[0.02]',
        border: 'border-white/[0.06]',
        headerBg: 'border-white/[0.04] bg-white/[0.02]',
      };
    case 'final_output':
      return {
        icon: <CheckCircle2 size={14} />,
        iconColor: 'text-emerald-400',
        label: 'Output',
        bg: 'bg-emerald-500/8',
        border: 'border-emerald-400/25',
        headerBg: 'border-emerald-400/20 bg-emerald-500/10',
      };
    case 'error':
      return {
        icon: <AlertCircle size={14} />,
        iconColor: 'text-red-400',
        label: 'Error',
        bg: 'bg-red-500/5',
        border: 'border-red-400/25',
        headerBg: 'border-red-400/15 bg-red-500/10',
      };
    default:
      return {
        icon: <MessageSquare size={14} />,
        iconColor: 'text-white/50',
        label: 'Card',
        bg: 'bg-white/[0.02]',
        border: 'border-white/[0.06]',
        headerBg: 'border-white/[0.04] bg-white/[0.02]',
      };
  }
}
