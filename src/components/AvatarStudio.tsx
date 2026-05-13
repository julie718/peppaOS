import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Brush, Sparkles, Cat, Bird, Disc3, Flame, Loader2, Check, ArrowRight, Wand2, ChevronLeft, ChevronRight, Play, Pause, RotateCcw, Download, Upload, Image } from 'lucide-react';
import { toast } from 'sonner';
import { getDefaultPets, generateCustomPet } from '../pets/defaults';
import { PetConfig } from '../pets/types';
import { SpriteAnimator, PetAvatar } from './SpriteAnimator';

const BUILTIN_ANIMATIONS = ['idle', 'run', 'wave', 'jump', 'waiting'];

const PET_ICONS: Record<string, React.ReactNode> = {
  'lumi-cat': <Cat size={28} />,
  'lumi-blob': <Disc3 size={28} />,
  'lumi-bird': <Bird size={28} />,
  'lumi-dragon': <Flame size={28} />,
};

const PET_DESCS: Record<string, string> = {
  'lumi-cat': '温暖治愈的猫猫，会眨眼、摇尾巴、撒娇挥手。适合日常陪伴。',
  'lumi-blob': 'Q弹软萌的史莱姆，一蹦一跳、眼睛闪闪。活泼可爱风。',
  'lumi-bird': '圆滚滚的小鸟，扑腾翅膀、叽叽喳喳。轻快灵动风。',
  'lumi-dragon': '迷你小龙，有翅膀和小角。适合喜欢奇幻风格的用户。',
};

export function AvatarStudio({
  t,
  selectedPetId,
  onSelectPet,
  onResetToSphere,
}: {
  t: any;
  selectedPetId?: string;
  onSelectPet: (pet: PetConfig) => void;
  onResetToSphere?: () => void;
}) {
  const pets = getDefaultPets();
  const [activePet, setActivePet] = useState<PetConfig>(
    pets.find(p => p.id === selectedPetId) || pets[0],
  );
  const [previewAnim, setPreviewAnim] = useState('idle');
  const [animKey, setAnimKey] = useState(0);
  const [tab, setTab] = useState<'gallery' | 'generate'>('gallery');
  const [genPrompt, setGenPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiMode, setAiMode] = useState(false);

  const handleSelectPet = useCallback((pet: PetConfig) => {
    setActivePet(pet);
    onSelectPet(pet);
    toast.success(`${pet.name} 已设为桌面形象`);
  }, [onSelectPet]);

  const handleGenerate = useCallback(async () => {
    if (!genPrompt.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch('/api/pets/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: genPrompt.trim(), mode: aiMode }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Generation failed');
      const result = await res.json();
      // Generate pet procedurally on client side from tags
      const newPet = generateCustomPet(result.petName, result.tags);
      handleSelectPet(newPet);
      setTab('gallery');
      toast.success('形象已生成！');
    } catch (err: any) {
      toast.error(err.message || '生成失败');
    } finally {
      setGenerating(false);
    }
  }, [genPrompt, handleSelectPet, aiMode]);

  // Export pet as .json manifest + .webp spritesheet
  const handleExport = useCallback((pet: PetConfig) => {
    try {
      // Download spritesheet
      const a = document.createElement('a');
      a.download = `${pet.id}.webp`;
      a.href = pet.spritesheet;
      a.click();

      // Download manifest
      const manifest = {
        id: pet.id,
        name: pet.name,
        author: pet.author,
        atlas: pet.atlas,
        format: 'codex-pets-v1',
        exportedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const b = document.createElement('a');
      b.download = `${pet.id}.pet.json`;
      b.href = url;
      b.click();
      URL.revokeObjectURL(url);

      toast.success(`已导出 ${pet.name}`);
    } catch (err: any) {
      toast.error('导出失败');
    }
  }, []);

  // Import community pet from .pet.json + .webp/.png
  const importRef = useRef<HTMLInputElement>(null);
  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const manifest = JSON.parse(reader.result as string);
        if (!manifest.id || !manifest.name || !manifest.atlas) {
          throw new Error('Invalid pet manifest');
        }
        // Ask user for the spritesheet image
        const spritesheetInput = document.createElement('input');
        spritesheetInput.type = 'file';
        spritesheetInput.accept = 'image/webp,image/png,image/gif';
        spritesheetInput.onchange = (ev) => {
          const imgFile = (ev.target as HTMLInputElement).files?.[0];
          if (!imgFile) return;
          const imgReader = new FileReader();
          imgReader.onload = () => {
            const importedPet: PetConfig = {
              id: manifest.id,
              name: manifest.name,
              author: manifest.author || 'Community',
              spritesheet: imgReader.result as string,
              atlas: manifest.atlas,
              thumbnail: imgReader.result as string,
            };
            handleSelectPet(importedPet);
            toast.success(`已导入 ${importedPet.name}`);
          };
          imgReader.readAsDataURL(imgFile);
        };
        spritesheetInput.click();
      } catch {
        toast.error('无效的 pet.json 文件');
      }
    };
    reader.readAsText(file);
  }, [handleSelectPet]);

  return (
    <div className="h-full flex flex-col bg-zinc-950/90">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Brush size={18} className="text-cyan-400" />
          <div>
            <h2 className="text-sm font-black text-white/90 uppercase tracking-wider">形象设计室</h2>
            <p className="text-[10px] text-white/30 font-mono">Avatar Design Studio</p>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-white/5 rounded-xl p-1">
          <button
            onClick={() => setTab('gallery')}
            className={`px-4 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-all ${
              tab === 'gallery' ? 'bg-cyan-500/20 text-cyan-400' : 'text-white/30 hover:text-white/50'
            }`}
          >
            形象画廊
          </button>
          <button
            onClick={() => setTab('generate')}
            className={`px-4 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-all ${
              tab === 'generate' ? 'bg-fuchsia-500/20 text-fuchsia-400' : 'text-white/30 hover:text-white/50'
            }`}
          >
            AI 定制
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left: Gallery / Generate Panel */}
        <div className="w-72 flex-shrink-0 border-r border-white/5 overflow-y-auto custom-scrollbar p-4">
          {tab === 'gallery' ? (
            <div className="space-y-2">
              <p className="text-[9px] font-bold uppercase tracking-wider text-white/20 mb-3">内置形象</p>
              {pets.map(pet => (
                <div key={pet.id} className="relative group/pet">
                  <button
                    onClick={() => { setActivePet(pet); setAnimKey(k => k + 1); }}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
                      activePet.id === pet.id
                        ? 'bg-cyan-500/10 border-cyan-500/30'
                        : 'bg-white/5 border-white/5 hover:bg-white/10'
                    }`}
                  >
                    <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center overflow-hidden flex-shrink-0">
                      <div className="scale-[0.35] origin-center">
                        <PetAvatar pet={pet} animation="idle" scale={0.35} />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-white/70 flex items-center gap-1.5">
                        {PET_ICONS[pet.id] && <span className="scale-75 inline-block">{PET_ICONS[pet.id]}</span>}
                        {pet.name}
                      </div>
                      <p className="text-[9px] text-white/30 truncate">{PET_DESCS[pet.id]?.slice(0, 20)}</p>
                    </div>
                    {activePet.id === pet.id && (
                      <Check size={14} className="text-cyan-400 flex-shrink-0" />
                    )}
                  </button>
                  {/* Export button */}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleExport(pet); }}
                    className="absolute top-1 right-1 w-6 h-6 rounded-lg bg-white/5 border border-white/5 flex items-center justify-center opacity-0 group-hover/pet:opacity-100 transition-opacity hover:bg-white/10"
                    title="导出宠物"
                  >
                    <Download size={10} className="text-white/40" />
                  </button>
                </div>
              ))}
              {/* Import button */}
              <input ref={importRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
              <button
                onClick={() => importRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 p-3 bg-white/5 border border-dashed border-white/10 rounded-xl text-[10px] font-bold text-white/20 hover:text-white/40 hover:border-white/20 transition-all"
              >
                <Upload size={12} />
                导入社区宠物
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-[9px] font-bold uppercase tracking-wider text-white/20">AI 形象生成</p>
              <div className="space-y-3">
                {/* AI Mode Toggle */}
                <div className="flex items-center gap-2 p-2 bg-white/5 rounded-xl">
                  <button
                    onClick={() => setAiMode(false)}
                    className={`flex-1 px-3 py-2 rounded-lg text-[10px] font-bold transition-all ${!aiMode ? 'bg-cyan-500/20 text-cyan-400' : 'text-white/20 hover:text-white/40'}`}
                  >
                    <Wand2 size={12} className="inline mr-1" /> 程序生成
                  </button>
                  <button
                    onClick={() => setAiMode(true)}
                    className={`flex-1 px-3 py-2 rounded-lg text-[10px] font-bold transition-all ${aiMode ? 'bg-fuchsia-500/20 text-fuchsia-400' : 'text-white/20 hover:text-white/40'}`}
                  >
                    <Sparkles size={12} className="inline mr-1" /> AI 增强
                  </button>
                </div>
                <textarea
                  value={genPrompt}
                  onChange={e => setGenPrompt(e.target.value)}
                  placeholder="描述你想要的桌面宠物，例如：一只戴红色围巾的白色小猫，像素风，可爱的..."
                  className="w-full h-32 bg-white/5 border border-white/10 rounded-xl p-3 text-xs text-white/70 placeholder:text-white/15 focus:outline-none focus:border-fuchsia-500/20 resize-none"
                />
                <button
                  onClick={handleGenerate}
                  disabled={!genPrompt.trim() || generating}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-fuchsia-500/15 border border-fuchsia-500/25 rounded-xl text-xs font-bold text-fuchsia-400 hover:bg-fuchsia-500/25 disabled:opacity-30 transition-all"
                >
                  {generating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  {generating ? '生成中...' : '开始生成'}
                </button>
              </div>
              <div className="p-3 bg-amber-500/5 border border-amber-500/15 rounded-xl text-[9px] text-amber-300/60 leading-relaxed">
                AI 生成的形象为原创版权，可放心商用。生成需约 30 秒，请耐心等待。
              </div>
            </div>
          )}
        </div>

        {/* Right: Preview + Actions */}
        <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-8">
          {/* Large Preview */}
          <div className="relative">
            <div className="w-64 h-72 rounded-[2.5rem] bg-white/[0.02] border border-white/5 flex items-center justify-center overflow-hidden shadow-[0_0_80px_rgba(0,200,200,0.06)]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${activePet.id}-${animKey}`}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.2 }}
                >
                  <PetAvatar pet={activePet} animation={previewAnim} scale={1.1} />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* Pet Info */}
          <div className="text-center space-y-1">
            <h3 className="text-lg font-bold text-white/80">{activePet.name}</h3>
            <p className="text-[10px] text-white/30 font-mono">by {activePet.author}</p>
            <p className="text-xs text-white/40 max-w-xs">{PET_DESCS[activePet.id] || ''}</p>
          </div>

          {/* Animation Controls */}
          <div className="flex items-center gap-2">
            {BUILTIN_ANIMATIONS.map(anim => (
              <button
                key={anim}
                onClick={() => { setPreviewAnim(anim); setAnimKey(k => k + 1); }}
                className={`px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase transition-all ${
                  previewAnim === anim
                    ? 'bg-cyan-500/20 border border-cyan-500/30 text-cyan-400'
                    : 'bg-white/5 border border-white/5 text-white/30 hover:bg-white/10'
                }`}
              >
                {anim === 'idle' ? '待机' : anim === 'run' ? '奔跑' : anim === 'wave' ? '挥手' : anim === 'jump' ? '跳跃' : anim === 'waiting' ? '等待' : anim}
              </button>
            ))}
            <button
              onClick={() => setAnimKey(k => k + 1)}
              className="p-1.5 rounded-lg bg-white/5 border border-white/5 text-white/30 hover:bg-white/10 transition-all"
            >
              <RotateCcw size={12} />
            </button>
          </div>

          {/* Select Button */}
          <div className="flex items-center gap-3">
            {onResetToSphere && selectedPetId && (
              <button
                onClick={() => onResetToSphere()}
                className="flex items-center gap-2 px-5 py-3 bg-white/5 border border-white/10 rounded-2xl text-sm font-bold text-white/30 hover:text-white/60 hover:bg-white/10 transition-all"
              >
                还原默认圆球
              </button>
            )}
            <button
              onClick={() => handleSelectPet(activePet)}
              className="flex items-center gap-2 px-8 py-3 bg-cyan-500/15 border border-cyan-500/25 rounded-2xl text-sm font-bold text-cyan-400 hover:bg-cyan-500/25 transition-all shadow-[0_0_30px_rgba(0,200,200,0.1)]"
            >
              <Sparkles size={16} />
              设为桌面形象
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
