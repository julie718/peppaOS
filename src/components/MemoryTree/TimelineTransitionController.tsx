import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import { Clock, Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import { TimelineState } from './types';

interface TimelineTransitionControllerProps {
  timeline: TimelineState;
  onChangeTimeline: (t: TimelineState) => void;
  earliestDate: string | null;
  latestDate: string | null;
}

export function TimelineTransitionController({
  timeline,
  onChangeTimeline,
  earliestDate,
  latestDate,
}: TimelineTransitionControllerProps) {
  const playRef = useRef<number | null>(null);

  // Auto-play: advance the cutoff forward
  useEffect(() => {
    if (timeline.playing && earliestDate && latestDate) {
      const start = new Date(earliestDate).getTime();
      const end = new Date(latestDate).getTime();
      const range = end - start;

      const tick = () => {
        onChangeTimeline({
          ...timeline,
          before: timeline.before,
        });
        // This is handled by the parent advancing the slider — simpler: advance by 1 day per tick
      };

      playRef.current = window.setInterval(() => {
        const current = timeline.before ? new Date(timeline.before).getTime() : start;
        const next = current + 86400000 * timeline.speed; // +1 day * speed
        if (next >= end) {
          onChangeTimeline({ ...timeline, before: null, playing: false });
        } else {
          onChangeTimeline({
            ...timeline,
            before: new Date(next).toISOString(),
          });
        }
      }, 150);

      return () => {
        if (playRef.current) clearInterval(playRef.current);
      };
    }
  }, [timeline.playing, timeline.before, timeline.speed, earliestDate, latestDate, onChangeTimeline]);

  if (!earliestDate || !latestDate) return null;

  const startMs = new Date(earliestDate).getTime();
  const endMs = new Date(latestDate).getTime();
  const range = endMs - startMs;
  const currentMs = timeline.before ? new Date(timeline.before).getTime() : endMs;
  const progress = range > 0 ? (currentMs - startMs) / range : 1;

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="absolute bottom-20 left-6 right-6 z-20"
    >
      <div className="flex items-center gap-3 bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl px-4 py-2.5">
        <Clock size={13} className="text-amber-400/60 shrink-0" />
        <span className="text-[9px] font-bold text-white/30 uppercase tracking-widest shrink-0">
          {formatDate(earliestDate)}
        </span>

        {/* Slider */}
        <input
          type="range"
          min={0}
          max={1000}
          value={progress * 1000}
          onChange={(e) => {
            const p = parseFloat(e.target.value) / 1000;
            const ms = startMs + p * range;
            onChangeTimeline({
              ...timeline,
              before: p >= 0.999 ? null : new Date(ms).toISOString(),
              playing: false,
            });
          }}
          className="flex-1 h-1 appearance-none bg-white/10 rounded-full cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-3
            [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-amber-400
            [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(251,191,36,0.5)]
            [&::-webkit-slider-thumb]:cursor-grab"
        />

        <span className="text-[9px] font-bold text-amber-400/60 uppercase tracking-widest shrink-0">
          {timeline.before ? formatDate(timeline.before) : 'Now'}
        </span>

        {/* Playback controls */}
        <button
          onClick={() => {
            if (timeline.playing) {
              onChangeTimeline({ ...timeline, playing: false });
            } else {
              // Start playing from beginning if at the end
              const startFrom = timeline.before && new Date(timeline.before).getTime() >= endMs
                ? earliestDate
                : timeline.before || earliestDate;
              onChangeTimeline({ ...timeline, before: startFrom, playing: true });
            }
          }}
          className="p-1.5 hover:bg-white/10 rounded-lg text-white/40 hover:text-white transition-colors"
        >
          {timeline.playing ? <Pause size={13} /> : <Play size={13} />}
        </button>

        <button
          onClick={() => {
            onChangeTimeline({
              ...timeline,
              before: earliestDate,
              playing: false,
            });
          }}
          className="p-1.5 hover:bg-white/10 rounded-lg text-white/30 hover:text-white/60 transition-colors"
        >
          <SkipBack size={13} />
        </button>

        <button
          onClick={() => {
            onChangeTimeline({
              ...timeline,
              before: null,
              playing: false,
            });
          }}
          className="p-1.5 hover:bg-white/10 rounded-lg text-white/30 hover:text-white/60 transition-colors"
        >
          <SkipForward size={13} />
        </button>
      </div>
    </motion.div>
  );
}
