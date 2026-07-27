// 迁移 anonymous 用户数据到已登录用户
import { logger } from './logger.js';

export function migrateAnonymousData(targetUid: string): { migrated: number } {
  try {
    // Node.js 环境中的 sqlite3 迁移
    const sqlite3 = require('sqlite3');
    const dbPath = process.env.DB_PATH || '/app/data/peppa.db';
    const db = new sqlite3.Database(dbPath);

    let migrated = 0;

    db.serialize(() => {
      // 检查 anonymous 是否有数据
      db.get(
        "SELECT COUNT(*) as cnt FROM interactions WHERE userId = 'anonymous'",
        (err: any, row: any) => {
          if (err || !row || row.cnt === 0) {
            logger.info('[Migrate] 无 anonymous 数据需要迁移');
            db.close();
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
              db.close();
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
