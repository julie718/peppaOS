import { useEffect, useRef, useState } from 'react';
import { Health } from '@krzysztofkostecki/capacitor-health';

const POLL_INTERVAL = 60000;

interface HealthData {
  heartRate: number | null;
  hrv: number | null;
  steps: number | null;
  timestamp: string | null;
}

export function useHealth(enabled: boolean) {
  const [data, setData] = useState<HealthData>({
    heartRate: null,
    hrv: null,
    steps: null,
    timestamp: null,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const poll = async () => {
      try {
        const status = await Health.requestAuthorization({
          read: ['heartRate', 'heartRateVariability', 'steps'],
          write: [],
        });

        if (status.readAuthorized.length === 0) {
          console.warn('[Health] 未获得任何读取权限');
          return;
        }

        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        const { samples: hrSamples } = await Health.readSamples({
          dataType: 'heartRate',
          startDate: oneHourAgo.toISOString(),
          endDate: now.toISOString(),
          limit: 1,
          ascending: false,
        });

        const { samples: hrvSamples } = await Health.readSamples({
          dataType: 'heartRateVariability',
          startDate: oneHourAgo.toISOString(),
          endDate: now.toISOString(),
          limit: 1,
          ascending: false,
        });

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const { samples: stepsSamples } = await Health.queryAggregated({
          dataType: 'steps',
          startDate: today.toISOString(),
          endDate: now.toISOString(),
          bucket: 'day',
          aggregation: 'sum',
        });

        const newData: HealthData = {
          heartRate: hrSamples.length > 0 ? hrSamples[0].value : null,
          hrv: hrvSamples.length > 0 ? hrvSamples[0].value : null,
          steps: stepsSamples.length > 0 ? stepsSamples[0].value : null,
          timestamp: now.toISOString(),
        };

        setData(newData);

        const ws = (window as any).__peppaWS;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'bio:update',
            payload: newData,
          }));
        }

        try {
          const token = localStorage.getItem('peppa_auth_token');
          await fetch('/api/health/data', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(newData),
          });
        } catch (fetchErr) {
          // 静默失败
        }

      } catch (err) {
        console.warn('[Health] 轮询失败:', err);
      }
    };

    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [enabled]);

  return data;
}
