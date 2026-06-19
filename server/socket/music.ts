/**
 * Music Socket Handler - real-time music playback events.
 * NetEase controls use ncm-cli/mpv; the frontend mirrors playback state and
 * renders the mood layer.
 */
import { Socket } from 'socket.io';
import { getNcmPlaybackStateAsync, runNcmCliAsync } from '../music/ncm_cli';
import { getNeteaseLyricText } from '../music/netease_public';

type MusicLyricLine = { time: number; text: string };

interface MusicAtmosphere {
  track: { name: string; artists: string[]; album?: string; coverUrl?: string; duration?: number };
  mood: string;
  weather?: string;
  lumiReason?: string;
  audioUrl?: string;
  nativePlayback?: boolean;
  queue?: Array<{
    track: { name: string; artists: string[]; album?: string; coverUrl?: string; duration?: number };
    audioUrl?: string;
    encryptedId?: string;
    originalId?: string;
  }>;
  queueIndex?: number;
  lyrics?: Array<{ time: number; text: string }>;
  scene?: import('../music/scene_generator').MusicScene;
}

const userPollers = new Map<string, ReturnType<typeof setInterval>>();
const activeNativeQueues = new Map<string, { queue: NonNullable<MusicAtmosphere['queue']>; queueIndex: number }>();
const lastLyricTrackByClient = new Map<string, string>();
const lyricCache = new Map<string, MusicLyricLine[]>();
const MUSIC_STATE_POLL_INTERVAL_MS = 1500;
const MUSIC_IDLE_POLLS_BEFORE_STOP = 2;

async function ncmExecArgs(args: string[], timeout = 10000): Promise<string> {
  const result = await runNcmCliAsync(args, timeout);
  if (!result.ok) throw new Error(result.error || result.stderr || result.stdout || 'ncm-cli failed');
  return result.stdout;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForNcmPlaying(attempts = 6, delayMs = 650): Promise<any | null> {
  let lastState: any | null = null;
  for (let i = 0; i < attempts; i += 1) {
    const state = await getNcmPlaybackStateAsync(8000);
    if (state) lastState = state;
    if (isNcmPlaying(state)) return state;
    await delay(delayMs);
  }
  return lastState;
}

function isNcmPlaying(state: any) {
  return state?.status === 'playing' || state?.playing === true;
}

async function recoverNcmPlaying(attempts = 8, delayMs = 700): Promise<any | null> {
  let state = await waitForNcmPlaying(attempts, delayMs);
  if (isNcmPlaying(state)) return state;
  try {
    await ncmExecArgs(['resume'], 8000);
  } catch {}
  state = await waitForNcmPlaying(4, delayMs);
  return state;
}

function getSocketUserRoom(socket: Socket) {
  return Array.from(socket.rooms).find(room => room.startsWith('user:'));
}

function normalizeNcmDurationMs(value: any) {
  const duration = Number(value || 0);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  return duration < 1000 ? duration * 1000 : duration;
}

function normalizeNcmProgressSeconds(value: any) {
  const progress = Number(value || 0);
  if (!Number.isFinite(progress) || progress < 0) return 0;
  return progress > 1000 ? progress / 1000 : progress;
}

function parseLrcText(lrc: string): MusicLyricLine[] {
  if (!lrc) return [];
  const lines: MusicLyricLine[] = [];
  for (const line of lrc.split('\n')) {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/);
    if (!match) continue;
    const time =
      parseInt(match[1], 10) * 60 +
      parseInt(match[2], 10) +
      parseInt(match[3], 10) / (match[3].length === 3 ? 1000 : 100);
    const text = match[4].trim();
    if (text) lines.push({ time, text });
  }
  return lines;
}

function normalizeArtists(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (!raw) return [];
  return [String(raw)].filter(Boolean);
}

function getMusicClientKey(socket: Socket) {
  return getSocketUserRoom(socket) || socket.id;
}

function getStateTrackName(state: any) {
  return String(state?.trackName || state?.name || state?.title || '').trim();
}

function getStateSongId(state: any): string {
  const candidates = [
    state?.originalId,
    state?.originId,
    state?.songId,
    state?.trackId,
    state?.id,
    state?.encryptedId,
  ];
  for (const value of candidates) {
    const id = String(value || '').trim();
    if (/^\d+$/.test(id)) return id;
  }
  return '';
}

function findActiveQueueItem(clientKey: string, state?: any) {
  const active = activeNativeQueues.get(clientKey);
  if (!active?.queue?.length) return null;

  const stateName = getStateTrackName(state);
  if (stateName) {
    const matchedIndex = active.queue.findIndex(item => item.track?.name === stateName);
    if (matchedIndex >= 0) {
      active.queueIndex = matchedIndex;
      return active.queue[matchedIndex];
    }
  }

  const currentIndex = Number(state?.currentIndex);
  const queueLength = Number(state?.queueLength);
  if (Number.isInteger(currentIndex)) {
    const index = queueLength === active.queue.length && currentIndex >= 1
      ? currentIndex - 1
      : currentIndex;
    if (index >= 0 && index < active.queue.length) {
      active.queueIndex = index;
      return active.queue[index];
    }
  }

  return active.queue[active.queueIndex] || active.queue[0] || null;
}

function getStateTrackKey(state: any, clientKey: string) {
  const id = getStateSongId(state);
  if (id) return `song:${id}`;

  const queueItem = findActiveQueueItem(clientKey, state);
  const queueId = String(queueItem?.originalId || queueItem?.encryptedId || '').trim();
  if (queueId) return `song:${queueId}`;

  const name = getStateTrackName(state);
  if (!name) return '';
  const artists = normalizeArtists(state?.artists || state?.artist).join('/');
  const duration = normalizeNcmDurationMs(state?.duration) || '';
  return `fingerprint:${name}|${artists}|${duration}|${state?.album || ''}`;
}

function getLyricLookupId(state: any, clientKey: string) {
  const id = getStateSongId(state);
  if (id) return id;
  const queueItem = findActiveQueueItem(clientKey, state);
  const queueId = String(queueItem?.originalId || queueItem?.encryptedId || '').trim();
  return /^\d+$/.test(queueId) ? queueId : '';
}

function advanceActiveQueue(socket: Socket, offset: number) {
  const clientKey = getMusicClientKey(socket);
  const active = activeNativeQueues.get(clientKey);
  if (!active?.queue?.length) return;
  active.queueIndex = (active.queueIndex + offset + active.queue.length) % active.queue.length;
}

async function emitLyricsForState(socket: Socket, state: any) {
  const clientKey = getMusicClientKey(socket);
  const trackKey = getStateTrackKey(state, clientKey);
  if (!trackKey || lastLyricTrackByClient.get(clientKey) === trackKey) return;

  lastLyricTrackByClient.set(clientKey, trackKey);
  socket.emit('music:lyrics', { lyrics: [], trackKey });

  const lookupId = getLyricLookupId(state, clientKey);
  if (!lookupId) return;

  let lyrics = lyricCache.get(lookupId);
  if (!lyrics) {
    try {
      lyrics = parseLrcText(await getNeteaseLyricText(lookupId));
    } catch {
      lyrics = [];
    }
    lyricCache.set(lookupId, lyrics);
    if (lyricCache.size > 200) {
      const oldest = lyricCache.keys().next().value;
      if (oldest) lyricCache.delete(oldest);
    }
  }

  if (lastLyricTrackByClient.get(clientKey) === trackKey) {
    socket.emit('music:lyrics', { lyrics, trackKey });
  }
}

async function stopNativePlayback() {
  try {
    await ncmExecArgs(['stop'], 8000);
  } catch {
    await ncmExecArgs(['pause'], 8000);
  }
}

function tryParse(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function socketGuard(fn: (...args: any[]) => void | Promise<void>) {
  return (...args: any[]) => {
    try {
      const ret = fn(...args);
      if (ret && typeof (ret as any).catch === 'function') {
        (ret as any).catch((e: any) => console.error('[Music] Handler error:', e.message || String(e)));
      }
    } catch (e: any) {
      console.error('[Music] Handler error:', e.message || String(e));
    }
  };
}

export function registerMusicHandlers(
  socket: Socket,
  getUserId: (s: any) => string,
  io?: any,
) {
  const uid = getUserId(socket);

  socket.on('music:play', socketGuard(async (data: { encryptedId?: string; originalId?: string; playlist?: boolean; audioUrl?: string }) => {
    try {
      if (data.audioUrl) {
        socket.emit('music:state', { playing: true, source: 'url', audioUrl: data.audioUrl });
        return;
      }
      if (data.playlist) {
        const args = ['play', '--playlist'];
        if (data.encryptedId) args.push('--encrypted-id', data.encryptedId);
        if (data.originalId) args.push('--original-id', data.originalId);
        await ncmExecArgs(args, 15000);
      } else if (data.encryptedId && data.originalId) {
        await ncmExecArgs(['play', '--song', '--encrypted-id', data.encryptedId, '--original-id', data.originalId], 15000);
      }

      const state = await recoverNcmPlaying();
      if (!isNcmPlaying(state)) {
        const status = state?.status || 'unknown';
        socket.emit('music:state', { playing: false, source: 'netease' });
        socket.emit('music:error', { message: `网易云播放命令已发送，但播放器没有进入播放状态（当前状态：${status}）。` });
        return;
      }
      startStatePoller(socket, getSocketUserRoom(socket) || uid);
      await pollAndEmitState(socket);
    } catch (e: any) {
      socket.emit('music:error', { message: e.message });
    }
  }));

  socket.on('music:pause', socketGuard(async () => {
    try {
      await ncmExecArgs(['pause']);
      await pollAndEmitState(socket);
      socket.emit('music:state', { playing: false, source: 'netease' });
      stopStatePoller(getSocketUserRoom(socket) || uid);
    } catch (e: any) {
      socket.emit('music:error', { message: e.message || '网易云暂停失败' });
    }
  }));

  socket.on('music:resume', socketGuard(async () => {
    try {
      await ncmExecArgs(['resume']);
      const state = await recoverNcmPlaying();
      startStatePoller(socket, getSocketUserRoom(socket) || uid);
      await pollAndEmitState(socket);
      socket.emit('music:state', { playing: isNcmPlaying(state), source: 'netease' });
      if (!isNcmPlaying(state)) {
        socket.emit('music:error', { message: `网易云恢复播放失败（当前状态：${state?.status || 'unknown'}）。` });
      }
    } catch (e: any) {
      socket.emit('music:error', { message: e.message || '网易云恢复播放失败' });
      socket.emit('music:state', { playing: false, source: 'netease' });
    }
  }));

  socket.on('music:next', socketGuard(async () => {
    await ncmExecArgs(['next']);
    advanceActiveQueue(socket, 1);
    socket.emit('music:lyrics', { lyrics: [] });
    const state = await recoverNcmPlaying(8, 700);
    if (!isNcmPlaying(state)) {
      socket.emit('music:error', { message: `已切到下一首，但播放器没有进入播放状态（当前状态：${state?.status || 'unknown'}）。` });
      socket.emit('music:state', { playing: false, source: 'netease' });
      return;
    }
    startStatePoller(socket, getSocketUserRoom(socket) || uid);
    await pollAndEmitState(socket);
  }));

  socket.on('music:prev', socketGuard(async () => {
    await ncmExecArgs(['prev']);
    advanceActiveQueue(socket, -1);
    socket.emit('music:lyrics', { lyrics: [] });
    const state = await recoverNcmPlaying(8, 700);
    if (!isNcmPlaying(state)) {
      socket.emit('music:error', { message: `已切到上一首，但播放器没有进入播放状态（当前状态：${state?.status || 'unknown'}）。` });
      socket.emit('music:state', { playing: false, source: 'netease' });
      return;
    }
    startStatePoller(socket, getSocketUserRoom(socket) || uid);
    await pollAndEmitState(socket);
  }));

  socket.on('music:seek', socketGuard(async (data: { seconds: number }) => {
    await ncmExecArgs(['seek', String(Math.max(0, data.seconds || 0))]);
    await pollAndEmitState(socket);
  }));

  socket.on('music:volume', socketGuard(async (data: { level: number }) => {
    const vol = Math.max(0, Math.min(100, Number(data.level ?? 50)));
    await ncmExecArgs(['volume', String(vol)]);
    socket.emit('music:state', { volume: vol, source: 'netease' });
  }));

  socket.on('music:queue:list', socketGuard(async () => {
    const raw = await ncmExecArgs(['queue']);
    socket.emit('music:queue', tryParse(raw) || raw.slice(0, 1000));
  }));

  socket.on('music:queue:add', socketGuard(async (data: { encryptedId: string; originalId?: string }) => {
    const args = ['queue', 'add', '--encrypted-id', data.encryptedId];
    if (data.originalId) args.push('--original-id', data.originalId);
    await ncmExecArgs(args);
    socket.emit('music:queue:added', { encryptedId: data.encryptedId });
  }));

  socket.on('music:queue:clear', socketGuard(async () => {
    await ncmExecArgs(['queue', 'clear']);
    socket.emit('music:queue:cleared', {});
  }));

  socket.on('music:like', socketGuard(async (data: { encryptedId: string }) => {
    await ncmExecArgs(['song', 'like', '--songId', data.encryptedId]);
    socket.emit('music:liked', { encryptedId: data.encryptedId });
  }));

  socket.on('music:dislike', socketGuard(async (data: { encryptedId: string }) => {
    await ncmExecArgs(['song', 'dislike', '--songId', data.encryptedId]);
    socket.emit('music:disliked', { encryptedId: data.encryptedId });
  }));

  socket.on('music:get_state', socketGuard(async () => {
    const state = await pollAndEmitState(socket, { reportErrors: false });
    if (isNcmPlaying(state)) startStatePoller(socket, getSocketUserRoom(socket) || uid);
  }));

  socket.on('music:playback_error', socketGuard((data: { message?: string; track?: { name?: string; artists?: string[] }; queueIndex?: number }) => {
    const trackLabel = data?.track?.name
      ? `${data.track.name}${data.track.artists?.length ? ` - ${data.track.artists.join(' / ')}` : ''}`
      : 'current track';
    const message = data?.message || 'Music playback failed in the desktop audio engine';
    if (message.includes('trying another candidate')) return;
    socket.emit('music:error', { message: `${trackLabel}: ${message}` });
    socket.emit('agent:notification', {
      type: 'music',
      level: 'warning',
      title: 'Music playback issue',
      message: `${trackLabel}: ${message}`,
    });
    socket.emit('agent:status', { status: 'idle', source: 'music' });
  }));

  let disconnectingUserRoom = getSocketUserRoom(socket);

  socket.on('disconnecting', () => {
    disconnectingUserRoom = getSocketUserRoom(socket) || disconnectingUserRoom;
  });

  socket.on('disconnect', () => {
    stopStatePoller(uid);
    if (disconnectingUserRoom) stopStatePoller(disconnectingUserRoom);
    const roomName = disconnectingUserRoom || `user:${uid}`;
    setTimeout(() => {
      const activeClients = io?.sockets?.adapter?.rooms?.get(roomName)?.size ?? 0;
      if (activeClients > 0) return;
      stopStatePoller(uid);
      stopStatePoller(roomName);
      stopNativePlayback().catch((e: any) => {
        console.warn('[Music] Failed to stop native playback after client disconnect:', e?.message || String(e));
      });
    }, 1500);
  });
}

async function pollAndEmitState(socket: Socket, options: { reportErrors?: boolean } = {}): Promise<any | null> {
  try {
    const raw = await ncmExecArgs(['state']);
    const result = tryParse(raw);
    const data = result?.state || result;
    if (data) {
      const clientKey = getMusicClientKey(socket);
      const activeItem = findActiveQueueItem(clientKey, data);
      const durationMs = normalizeNcmDurationMs(data.duration) || normalizeNcmDurationMs(activeItem?.track?.duration);
      const trackKey = getStateTrackKey(data, clientKey);
      socket.emit('music:state', {
        playing: isNcmPlaying(data),
        trackName: data.trackName || data.name || data.title || activeItem?.track?.name,
        artists: data.artists || (data.artist ? [data.artist] : undefined) || activeItem?.track?.artists,
        album: data.album || activeItem?.track?.album,
        duration: durationMs,
        progress: normalizeNcmProgressSeconds(data.position ?? data.progress ?? 0),
        coverUrl: data.coverUrl || data.cover || activeItem?.track?.coverUrl,
        volume: data.volume,
        source: 'netease',
        trackKey,
      });
      await emitLyricsForState(socket, data);
      return data;
    }
    return null;
  } catch (e: any) {
    if (options.reportErrors !== false) {
      socket.emit('music:error', { message: e.message || '网易云播放状态读取失败' });
    }
    return null;
  }
}

function startStatePoller(socket: Socket, uid: string) {
  stopStatePoller(uid);
  void pollAndEmitState(socket, { reportErrors: true });
  let idlePolls = 0;
  const interval = setInterval(async () => {
    const state = await pollAndEmitState(socket);
    if (isNcmPlaying(state)) {
      idlePolls = 0;
      return;
    }
    idlePolls += 1;
    if (idlePolls >= MUSIC_IDLE_POLLS_BEFORE_STOP) {
      stopStatePoller(uid);
    }
  }, MUSIC_STATE_POLL_INTERVAL_MS);
  userPollers.set(uid, interval);
}

function stopStatePoller(uid: string) {
  const existing = userPollers.get(uid);
  if (existing) {
    clearInterval(existing);
    userPollers.delete(uid);
  }
}

export function emitMusicAtmosphere(socket: Socket, atmosphere: MusicAtmosphere) {
  const rooms = Array.from(socket.rooms);
  const userRoom = rooms.find(r => r.startsWith('user:'));
  const clientKeys = [userRoom, socket.id].filter(Boolean) as string[];
  const queue = atmosphere.queue || [];
  const queueIndex = Math.max(0, Math.min(atmosphere.queueIndex ?? 0, Math.max(0, queue.length - 1)));
  for (const key of clientKeys) {
    if (queue.length) activeNativeQueues.set(key, { queue, queueIndex });
  }
  const activeItem = queue[queueIndex];
  const trackId = String(activeItem?.originalId || activeItem?.encryptedId || '').trim();
  const trackKey = trackId
    ? `song:${trackId}`
    : `fingerprint:${atmosphere.track.name}|${atmosphere.track.artists?.join('/') || ''}|${atmosphere.track.duration || ''}|${atmosphere.track.album || ''}`;
  const lyricPayload = { lyrics: atmosphere.lyrics || [], trackKey };
  for (const key of clientKeys) {
    if (lyricPayload.lyrics.length > 0) lastLyricTrackByClient.set(key, trackKey);
    else lastLyricTrackByClient.delete(key);
  }
  if (userRoom) {
    socket.to(userRoom).emit('music:atmosphere', atmosphere);
    socket.to(userRoom).emit('music:lyrics', lyricPayload);
  }
  socket.emit('music:atmosphere', atmosphere);
  socket.emit('music:lyrics', lyricPayload);
  startStatePoller(socket, userRoom || socket.id);
}
