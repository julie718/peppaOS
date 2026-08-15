// 迁移 anonymous 用户数据到已登录用户
import { logger } from './logger';
import { getSharedPeppaDb } from '../db/dbBase'; // 进程级单例连接：业务路径禁止自行 open/close

export function migrateAnonymousData(targetUid: string): { migrated: number } {
  try {
    // 【句柄复用】进程级单例连接（路径经 E-3 getDataPath 统一解析）：
    // 原实现 per-call open（无回调无 error 监听）+ 回调内 close →
    // 并发迁移下句柄关闭竞态随机 SQLITE_MISUSE FATAL；单例连接生命周期归进程
    const db = getSharedPeppaDb();

    let migrated = 0;

    db.serialize(() => {
      // 检查 anonymous 是否有数据
      db.get(
        "SELECT COUNT(*) as cnt FROM interactions WHERE userId = 'anonymous'",
        (err: any, row: any) => {
          if (err || !row || row.cnt === 0) {
            logger.info('[Migrate] 无 anonymous 数据需要迁移');
            return;
          }

          const count = row.cnt;
          // 迁移 interactions
          db.run(
            "UPDATE interactions SET userId = ? WHERE userId = 'anonymous'",
            [targetUid],
            function (this: any, err: any) {
              if (err) {
                logger.error('[Migrate] 迁移失败:', err.message);
              } else {
                migrated = this.changes;
                logger.info(`[Migrate] 已将 ${migrated} 条记录从 anonymous → ${targetUid}`);
              }
            }
          );
        }
      );
    });

    return { migrated };
  } catch (e: any) {
    logger.warn('[Migrate] 迁移异常:', e.message);
    return { migrated: 0 };
  }
}
