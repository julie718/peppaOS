import React from 'react';
import { motion } from 'motion/react';
import { Loader2, LucideIcon } from 'lucide-react';
import { Card } from './ui/card';
import { cn } from '@/lib/utils';

interface FeatureItemProps {
  icon: React.ReactNode;
  title: string;
  desc: string;
  className?: string;
  iconClassName?: string;
}

export function FeatureItem({ icon, title, desc, className, iconClassName }: FeatureItemProps) {
  return (
    <div className={cn("flex gap-4 items-start", className)}>
      <div className={cn("p-2 rounded-lg bg-white/5 text-celestial-saturn shrink-0", iconClassName)}>
        {icon}
      </div>
      <div className="space-y-1">
        <h4 className="font-bold text-sm">{title}</h4>
        <p className="text-xs text-white/40 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  hoverEffect?: boolean;
}

export function GlassCard({ children, className, hoverEffect = true, ...props }: GlassCardProps) {
  return (
    <Card 
      className={cn(
        "glass-panel p-8 transition-all duration-500 relative overflow-hidden group",
        hoverEffect && "hover:border-celestial-saturn/30 hover:shadow-[0_0_40px_rgba(255,204,0,0.05)]",
        className
      )}
      {...props}
    >
      {hoverEffect && (
        <div className="absolute inset-0 bg-gradient-to-br from-celestial-saturn/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
      )}
      <div className="relative z-10">
        {children}
      </div>
    </Card>
  );
}

export function PulseCounter({ label, value, colorClass = "text-celestial-saturn" }: { label: string; value: string; colorClass?: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={cn("text-xl md:text-3xl font-black tracking-tighter tabular-nums", colorClass)}>
        {value}
      </div>
      <div className="text-xs md:text-[12px] uppercase tracking-[0.2em] md:tracking-[0.3em] text-white/45 font-bold text-center">
        {label}
      </div>
      <motion.div 
        animate={{ scaleX: [0, 1, 0], opacity: [0, 1, 0] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        className={cn("h-px w-full", colorClass.replace('text-', 'bg-'))}
      />
    </div>
  );
}

export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center min-h-[400px]", className)}>
      <Loader2 className="animate-spin text-celestial-saturn" size={48} />
    </div>
  );
}

interface IconBoxProps {
  icon: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function IconBox({ icon, className, size = 'md' }: IconBoxProps) {
  const sizes = {
    sm: 'w-10 h-10 rounded-xl',
    md: 'w-14 h-14 rounded-2xl',
    lg: 'w-20 h-20 rounded-3xl'
  };

  return (
    <div className={cn(
      "bg-white/5 flex items-center justify-center transition-transform group-hover:scale-110",
      sizes[size],
      className
    )}>
      {icon}
    </div>
  );
}
