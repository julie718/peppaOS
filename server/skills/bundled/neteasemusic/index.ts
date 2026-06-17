import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  configureNcmCredentials,
  normalizeNcmAppId,
  normalizeNcmPrivateKey,
} from '../../../music/ncm_cli';

const execAsync = promisify(exec);

// ── Public API helpers (search, lyrics — no auth needed) ─────────────────────

const UA = 'LumiOS/2.0';
const MUSIC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://music.163.com/',
  'Accept': 'application/json',
};

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url, { headers: MUSIC_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function ncmPath(): string {
  // ncm-cli is installed in node_modules — use npx to run it
  return 'npx @music163/ncm-cli';
}

async function ncm(args: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  const cmd = `${ncmPath()} ${args} --output json`;
  try {
    return await execAsync(cmd, { timeout: opts?.timeout || 15000 });
  } catch (e: any) {
    // ncm-cli exits with code 1 even on success sometimes, check stderr for "错误" or "error"
    if (e.stdout) return { stdout: e.stdout, stderr: e.stderr || '' };
    throw new Error(e.stderr || e.message);
  }
}

function tryParseJSON(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: 'text' as const, text: `NeteaseMusic error: ${message}` }], isError: true };
}

// ── Auto-configure ncm-cli from env/stored keys ─────────────────────────────

async function autoConfigureFromEnv() {
  const appId = normalizeNcmAppId(process.env.NETEASE_APP_ID);
  const privateKey = normalizeNcmPrivateKey(process.env.NETEASE_PRIVATE_KEY);
  if (appId && privateKey) {
    await configureNcmCredentials(appId, privateKey, 10000).catch(() => {});
  }
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'netease-music', version: '1.0.0' }, { capabilities: { tools: {} } });

// ── Tool 1: netease_setup ────────────────────────────────────────────────────

async function setupHandler(args: any) {
  try {
    const appId = normalizeNcmAppId(args.appId);
    const privateKey = normalizeNcmPrivateKey(args.privateKey);
    if (!appId || !privateKey) return err('appId and privateKey are required. Get them from developer.music.163.com');

    await configureNcmCredentials(appId, privateKey, 10000);
    return ok({ configured: true, message: 'Credentials configured. Run netease_login to log in.' });
  } catch (e: any) {
    return err(`Setup failed: ${e.message}`);
  }
}

server.registerTool('netease_setup', {
  description: 'Configure NetEase Cloud Music API credentials (appId + privateKey from developer.music.163.com). Required before login and playback.',
  inputSchema: {
    appId: z.string().describe('App ID from NetEase developer console'),
    privateKey: z.string().describe('Private key from NetEase developer console'),
  },
}, setupHandler);


// ── Tool 3: netease_search ───────────────────────────────────────────────────

async function searchHandler(args: any) {
  try {
    const keyword = String(args.keyword || '').trim();
    if (!keyword) return err('keyword is required');

    const searchType = args.type || 'song';
    const typeMap: Record<string, number> = {
      song: 1, album: 10, artist: 100, playlist: 1000, lyric: 1006,
    };
    const type = typeMap[searchType] || 1;
    const limit = Math.min(50, Math.max(1, args.limit || 10));

    const data = await fetchJSON(
      `https://music.163.com/api/search/get/web?csrf_token=hlpretag=&hlposttag=&s=${encodeURIComponent(keyword)}&type=${type}&limit=${limit}&offset=0&total=true`,
    );

    if (data.code !== 200) return err(`Search failed: code ${data.code}`);

    const result = data.result || {};
    if (searchType === 'song') {
      const songs = (result.songs || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        artists: (s.artists || s.ar || []).map((a: any) => a.name),
        album: s.album?.name || s.al?.name,
        duration: s.duration || s.dt,
        hasMV: s.mvid > 0,
        fee: s.fee, // 0=free, 1=VIP, 4=digital album, 8=free, etc.
        playHint: `Use netease_play with encryptedId and originalId: ${s.id}`,
      }));
      return ok({ query: keyword, type: searchType, count: result.songCount, songs });
    } else if (searchType === 'playlist') {
      const playlists = (result.playlists || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        creator: p.creator?.nickname,
        trackCount: p.trackCount,
        playCount: p.playCount,
        coverImgUrl: p.coverImgUrl,
      }));
      return ok({ query: keyword, type: searchType, count: result.playlistCount, playlists });
    } else if (searchType === 'artist') {
      const artists = (result.artists || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        albumSize: a.albumSize,
        musicSize: a.musicSize,
        img1v1Url: a.img1v1Url,
      }));
      return ok({ query: keyword, type: searchType, count: result.artistCount, artists });
    } else if (searchType === 'album') {
      const albums = (result.albums || []).map((a: any) => ({
        id: a.id, name: a.name,
        artist: a.artist?.name,
        size: a.size,
        publishTime: a.publishTime,
      }));
      return ok({ query: keyword, type: searchType, count: result.albumCount, albums });
    }
    return ok({ query: keyword, type: searchType, result });
  } catch (e: any) {
    return err(`Search failed: ${e.message}`);
  }
}

server.registerTool('netease_search', {
  description: 'Search NetEase Cloud Music for songs, albums, artists, playlists, or lyrics.',
  inputSchema: {
    keyword: z.string().describe('Search keyword, e.g. "周杰伦", "晴天"'),
    type: z.enum(['song', 'album', 'artist', 'playlist', 'lyric']).optional().describe('Search type (default: song)'),
    limit: z.number().optional().describe('Max results (default: 10, max: 50)'),
  },
}, searchHandler);

// ── Tool 4: netease_lyric ────────────────────────────────────────────────────

async function lyricHandler(args: any) {
  try {
    const songId = Number(args.songId) || 0;
    if (!songId) return err('songId is required (numeric ID from search results)');

    const data = await fetchJSON(
      `https://music.163.com/api/song/lyric?os=pc&id=${songId}&lv=-1&kv=-1&tv=-1`,
    );

    return ok({
      songId,
      lyric: data.lrc?.lyric || null,        // original lyrics
      translated: data.tlyric?.lyric || null, // translated lyrics
      romaji: data.romalrc?.lyric || null,    // romaji/pronunciation
      lyricUser: data.lyricUser,
      transUser: data.transUser,
    });
  } catch (e: any) {
    return err(`Lyric failed: ${e.message}`);
  }
}

server.registerTool('netease_lyric', {
  description: 'Get song lyrics (original + translated + romaji) by song ID.',
  inputSchema: {
    songId: z.number().describe('Song numeric ID from search results'),
  },
}, lyricHandler);

// ── Tool 5: netease_play ─────────────────────────────────────────────────────

async function playHandler(args: any) {
  try {
    if (args.playlist) {
      const encryptedId = args.encryptedId?.trim();
      const originalId = args.originalId?.trim();
      if (!encryptedId && !originalId) return err('encryptedId or originalId is required for playlist');

      const optArgs = [encryptedId ? `--encrypted-id "${encryptedId}"` : '', originalId ? `--original-id "${originalId}"` : ''].filter(Boolean).join(' ');
      const result = await ncm(`play --playlist ${optArgs}`, { timeout: 10000 });
      const data = tryParseJSON(result.stdout);
      return ok({ playing: true, mode: 'playlist', ...(data || {}) });
    }

    // Single song
    const encryptedId = args.encryptedId?.trim();
    const originalId = args.originalId?.trim();
    if (!encryptedId || !originalId) return err('Both encryptedId and originalId are required for single song. Get them from search results or netease_song_detail.');

    const result = await ncm(`play --song --encrypted-id "${encryptedId}" --original-id "${originalId}"`, { timeout: 10000 });
    const data = tryParseJSON(result.stdout);
    return ok({ playing: true, mode: 'song', ...(data || {}) });
  } catch (e: any) {
    return err(`Play failed: ${e.message}. Make sure you have configured credentials (netease_setup) and logged in (netease_login).`);
  }
}

server.registerTool('netease_play', {
  description: 'Play a song or playlist from NetEase Cloud Music. Requires login.',
  inputSchema: {
    encryptedId: z.string().optional().describe('Encrypted ID (32-char hex for song). Required for single songs.'),
    originalId: z.string().optional().describe('Original numeric ID. Required for single songs.'),
    playlist: z.boolean().optional().describe('Set to true to play a playlist instead of a single song'),
  },
}, playHandler);

// ── Tool 6: netease_control ──────────────────────────────────────────────────

async function controlHandler(args: any) {
  try {
    const action = args.action || 'state';
    let result: { stdout: string; stderr: string };

    switch (action) {
      case 'pause':
        result = await ncm('pause');
        return ok({ action: 'pause', ok: true });
      case 'resume':
        result = await ncm('resume');
        return ok({ action: 'resume', ok: true });
      case 'stop':
        result = await ncm('stop');
        return ok({ action: 'stop', ok: true });
      case 'next':
        result = await ncm('next');
        return ok({ action: 'next', ok: true });
      case 'prev':
        result = await ncm('prev');
        return ok({ action: 'prev', ok: true });
      case 'seek':
        await ncm(`seek ${Math.max(0, Number(args.seconds) || 0)}`);
        return ok({ action: 'seek', seconds: Number(args.seconds) || 0, ok: true });
      case 'volume':
        const vol = Math.max(0, Math.min(100, Number(args.level) || 50));
        await ncm(`volume ${vol}`);
        return ok({ action: 'volume', level: vol, ok: true });
      case 'state': {
        result = await ncm('state');
        const data = tryParseJSON(result.stdout);
        return ok({ state: data || result.stdout.slice(0, 500) });
      }
      default:
        return err(`Unknown action: ${action}. Valid: pause, resume, stop, next, prev, seek, volume, state`);
    }
  } catch (e: any) {
    return err(`Control failed: ${e.message}`);
  }
}

server.registerTool('netease_control', {
  description: 'Control playback: pause, resume, stop, next, prev, seek, volume, or get current state.',
  inputSchema: {
    action: z.enum(['pause', 'resume', 'stop', 'next', 'prev', 'seek', 'volume', 'state']).describe('Playback action'),
    seconds: z.number().optional().describe('For seek: jump to this second in the current track'),
    level: z.number().optional().describe('For volume: set volume 0-100'),
  },
}, controlHandler);

// ── Tool 7: netease_queue ────────────────────────────────────────────────────

async function queueHandler(args: any) {
  try {
    const action = args.action || 'list';
    let encryptedId = args.encryptedId?.trim() || '';
    let originalId = args.originalId?.trim() || '';

    switch (action) {
      case 'list': {
        const result = await ncm('queue');
        const data = tryParseJSON(result.stdout);
        return ok({ queue: data || result.stdout.slice(0, 1000) });
      }
      case 'add': {
        if (!encryptedId) return err('encryptedId is required to add a song');
        const optArgs = [encryptedId ? `--encrypted-id "${encryptedId}"` : '', originalId ? `--original-id "${originalId}"` : ''].filter(Boolean).join(' ');
        await ncm(`queue add ${optArgs}`);
        return ok({ action: 'add', encryptedId, ok: true });
      }
      case 'clear':
        await ncm('queue clear');
        return ok({ action: 'clear', ok: true });
      default:
        return err(`Unknown action: ${action}. Valid: list, add, clear`);
    }
  } catch (e: any) {
    return err(`Queue failed: ${e.message}`);
  }
}

server.registerTool('netease_queue', {
  description: 'Manage playback queue: list, add songs, or clear.',
  inputSchema: {
    action: z.enum(['list', 'add', 'clear']).describe('Queue action'),
    encryptedId: z.string().optional().describe('For add: encrypted song ID (32 hex chars)'),
    originalId: z.string().optional().describe('For add: original song ID'),
  },
}, queueHandler);

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  await autoConfigureFromEnv();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Netease Music] Ready — 7 tools loaded.');
}
main().catch(console.error);
