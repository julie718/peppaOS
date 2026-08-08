/**
 * Free weather lookup via wttr.in — no API key required.
 * Returns a concise one-line weather summary for proactive notifications.
 */

let cachedWeather: { text: string; timestamp: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function getWeather(city: string = 'Beijing'): Promise<string> {
  const now = Date.now();
  if (cachedWeather && (now - cachedWeather.timestamp) < CACHE_TTL) {
    return cachedWeather.text;
  }

  try {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=%C+%t+%h+%w&lang=en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'curl' } });
    const text = await res.text();
    const weather = text.trim();
    cachedWeather = { text: weather, timestamp: now };
    return weather;
  } catch {
    return 'Weather unavailable';
  }
}

export async function getWeatherBrief(): Promise<string> {
  const weather = await getWeather();
  if (weather === 'Weather unavailable') return '';
  return weather;
}
