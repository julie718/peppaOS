import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, BookOpen, Tag, Clock, ChevronRight, Loader2, Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { useT } from '../../lib/useT';

interface Article {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string;
  authorId: string;
  status: string;
  createdAt: string;
}

export function KnowledgeBaseBrowser() {
  const t = useT();
  const [articles, setArticles] = useState<Article[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    loadArticles();
  }, []);

  const loadArticles = async () => {
    try {
      const res = await fetch('/api/enterprise/kb/articles', { credentials: 'include' });
      if (res.ok) setArticles(await res.json());
    } catch {} finally { setLoading(false); }
  };

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch('/api/enterprise/kb/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 10 }),
        credentials: 'include',
      });
      if (res.ok) setSearchResults(await res.json());
    } catch {} finally { setSearching(false); }
  }, []);

  const handleSearchInput = (val: string) => {
    setSearchQuery(val);
    if (val.length >= 2) {
      handleSearch(val);
    } else {
      setSearchResults([]);
    }
  };

  const parseTags = (tagsStr: string): string[] => {
    try { return JSON.parse(tagsStr); } catch { return []; }
  };

  return (
    <div className="p-6 space-y-6 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <BookOpen size={24} className="text-blue-400" />
            {t.enterpriseKB}
          </h2>
          <p className="text-white/40 text-sm">Company policies, SOPs, and documentation</p>
        </div>
        <Button
          onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'enterprise', sub: 'kb-edit' } }))}
          className="bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm flex items-center gap-1"
        >
          <Plus size={14} /> New Article
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
        <input
          value={searchQuery}
          onChange={e => handleSearchInput(e.target.value)}
          placeholder="Search knowledge base..."
          className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-blue-500/40"
        />
        {searching && <Loader2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-white/30" />}
      </div>

      {/* Search results */}
      <AnimatePresence>
        {searchResults.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="bg-white/5 border border-blue-500/20 rounded-xl p-4 space-y-2"
          >
            <p className="text-white/30 text-xs font-medium">Semantic Search Results</p>
            {searchResults.map((r, i) => (
              <button
                key={`${r.articleId}-${i}`}
                onClick={() => {
                  const article = articles.find(a => a.id === r.articleId);
                  if (article) setSelectedArticle(article);
                }}
                className="w-full text-left p-3 rounded-lg hover:bg-white/5 transition-colors group"
              >
                <p className="text-white text-sm font-medium group-hover:text-blue-400 transition-colors">
                  {r.title}
                </p>
                <p className="text-white/40 text-xs mt-1 line-clamp-2">{r.chunk}</p>
                <p className="text-white/20 text-[10px] mt-1">Score: {r.score.toFixed(2)}</p>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Article list */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <div className="text-center py-12 text-white/30">
            <Loader2 size={24} className="mx-auto animate-spin mb-2" />
            Loading articles...
          </div>
        ) : articles.length === 0 ? (
          <div className="text-center py-12 text-white/30">
            <BookOpen size={32} className="mx-auto mb-2 opacity-30" />
            No articles yet
          </div>
        ) : (
          articles.map((article) => (
            <motion.button
              key={article.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => setSelectedArticle(article)}
              className={`w-full text-left p-4 rounded-xl border transition-all ${
                selectedArticle?.id === article.id
                  ? 'bg-blue-500/10 border-blue-500/30'
                  : 'bg-white/5 border-white/5 hover:bg-white/[0.07] hover:border-white/10'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium truncate">{article.title}</p>
                  <p className="text-white/30 text-xs mt-1 line-clamp-1">{article.content}</p>
                </div>
                <ChevronRight size={14} className="text-white/20 mt-1 ml-2 flex-shrink-0" />
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40">{article.category}</span>
                {parseTags(article.tags).slice(0, 3).map((tag) => (
                  <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/30 flex items-center gap-1">
                    <Tag size={10} /> {tag}
                  </span>
                ))}
              </div>
            </motion.button>
          ))
        )}
      </div>

      {/* Article detail panel */}
      <AnimatePresence>
        {selectedArticle && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-y-0 right-0 w-96 bg-black/90 backdrop-blur-xl border-l border-white/10 p-6 overflow-y-auto z-50"
          >
            <button
              onClick={() => setSelectedArticle(null)}
              className="text-white/40 hover:text-white mb-4 text-sm"
            >
              {'← '}{t.back}
            </button>
            <h3 className="text-lg font-bold text-white mb-2">{selectedArticle.title}</h3>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400">{selectedArticle.category}</span>
              <span className="text-xs text-white/20"><Clock size={12} className="inline mr-1" />{new Date(selectedArticle.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="prose prose-invert text-white/70 text-sm whitespace-pre-wrap leading-relaxed">
              {selectedArticle.content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
