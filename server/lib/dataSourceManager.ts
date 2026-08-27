// 金融数据源管理器 — 智能路由、健康检查、熔断保护、自动降级
import { logger } from './logger';

interface DataSource {
  name: string;
  priority: number;              // 越高越优先
  healthCheck: () => Promise<boolean>;
  query: (code: string, type: 'quote' | 'kline' | 'batch' | 'search' | 'index', extra?: any) => Promise<any>;
  state: 'healthy' | 'unhealthy' | 'degraded';
  consecutiveFailures: number;
  cooldownUntil: number;          // 熔断冷却到期时间
  lastCheckTime: number;
  totalQueries: number;
  successQueries: number;
  totalLatency: number;
}

const MAX_FAILURES = 3;
const COOLDOWN_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60000;

export class DataSourceManager {
  private sources: Map<string, DataSource> = new Map();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** 注册数据源 */
  register(source: Omit<DataSource, 'state' | 'consecutiveFailures' | 'cooldownUntil' | 'lastCheckTime' | 'totalQueries' | 'successQueries' | 'totalLatency'>): void {
    this.sources.set(source.name, {
      ...source,
      state: 'healthy',
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastCheckTime: 0,
      totalQueries: 0,
      successQueries: 0,
      totalLatency: 0,
    });
    logger.info(`[DataSource] 已注册: ${source.name} (优先级 ${source.priority})`);
  }

  /** 智能路由查询 */
  async query(code: string, type: 'quote' | 'kline' | 'batch' | 'search' | 'index', extra?: any): Promise<{ result: any; source: string; latency: number } | { error: string; sources: any[] }> {
    const sorted = [...this.sources.values()]
      .filter(s => s.state !== 'unhealthy' || Date.now() > s.cooldownUntil)
      .sort((a, b) => b.priority - a.priority);

    if (sorted.length === 0) {
      return {
        error: '所有数据源不可用',
        sources: [...this.sources.values()].map(s => ({ name: s.name, state: s.state, failures: s.consecutiveFailures })),
      };
    }

    const errors: string[] = [];

    for (const source of sorted) {
      const start = Date.now();
      try {
        const result = await source.query(code, type, extra);
        const latency = Date.now() - start;

        // Reset failure counter and restore health status after success
        // Bugfix: When healthCheck timeout/failure sets state to degraded,
        // original logic only handled unhealthy→healthy, degraded state stuck forever.
        source.consecutiveFailures = 0;
        if (source.state !== 'healthy') {
          const prevState = source.state;
          source.state = 'healthy';
          logger.info(`[DataSource] ${source.name} recovered to healthy (${prevState} → healthy)`);
        }

        source.totalQueries++;
        source.successQueries++;
        source.totalLatency += latency;

        logger.info(`[DataSource] 查询成功 via ${source.name} [${type}:${code}] ${latency}ms`);
        return { result, source: source.name, latency };
      } catch (e: any) {
        const latency = Date.now() - start;
        errors.push(`${source.name}: ${e.message}`);
        source.consecutiveFailures++;
        source.totalQueries++;

        if (source.consecutiveFailures >= MAX_FAILURES) {
          source.state = 'unhealthy';
          source.cooldownUntil = Date.now() + COOLDOWN_MS;
          logger.warn(`[DataSource] ${source.name} 熔断 (${source.consecutiveFailures}次失败), 冷却 ${COOLDOWN_MS/1000}s`);
        }

        logger.warn(`[DataSource] ${source.name} 查询失败 [${type}:${code}] ${latency}ms: ${e.message}`);
      }
    }

    return {
      error: `所有数据源查询失败: ${errors.join('; ')}`,
      sources: this.getStatus(),
    };
  }

  /** 启动定时健康检查 */
  startHealthChecks(): void {
    this.healthTimer = setInterval(() => this.runHealthChecks(), HEALTH_CHECK_INTERVAL_MS);
    this.runHealthChecks(); // 立即执行一次
    logger.info('[DataSource] 健康检查已启动 (5分钟间隔)');
  }

  /** 停止健康检查 */
  stopHealthChecks(): void {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
  }

  /** 执行所有数据源健康检查 */
  private async runHealthChecks(): Promise<void> {
    for (const [name, source] of this.sources) {
      // 熔断期内跳过
      if (source.state === 'unhealthy' && Date.now() < source.cooldownUntil) continue;
      try {
        const ok = await source.healthCheck();
        source.state = ok ? 'healthy' : 'degraded';
        source.lastCheckTime = Date.now();
        if (!ok) logger.warn(`[DataSource] ${name} 健康检查失败`);
      } catch {
        source.state = 'degraded';
      }
    }
    logger.info(`[DataSource] 健康检查完成: ${this.statusSummary()}`);
  }

  /** 获取状态摘要 */
  statusSummary(): string {
    return [...this.sources.values()]
      .map(s => `${s.name}=${s.state}(P${s.priority},F${s.consecutiveFailures})`)
      .join(' ');
  }

  /** 获取所有数据源状态 */
  getStatus(): any[] {
    return [...this.sources.values()].map(s => ({
      name: s.name,
      state: s.state,
      priority: s.priority,
      consecutiveFailures: s.consecutiveFailures,
      totalQueries: s.totalQueries,
      successRate: s.totalQueries > 0 ? (s.successQueries / s.totalQueries).toFixed(2) : 'N/A',
      avgLatency: s.successQueries > 0 ? Math.round(s.totalLatency / s.successQueries) : 0,
    }));
  }
}

let instance: DataSourceManager | null = null;
export function getDataSourceManager(): DataSourceManager {
  if (!instance) instance = new DataSourceManager();
  return instance;
}
