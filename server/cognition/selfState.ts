// 自身状态读取 — 阶段3 P1-5 从 deepReasoning.ts 迁移而来
//
// P2-2: 原实现用 require('sqlite3')（tsx ESM 下 require 未定义 → 永远返回默认值，
//       router 的 canSelfRespond 依赖的 emotion/personality 读取全部失效），
//       改为静态 import + 查询现有有效字段（emotion_state.vector_json / personality.vector_json）。
// P2-3: 数据库路径不再硬编码 /app/data/life.db，优先读取环境变量 LIFE_DB_PATH。

import sqlite3 from 'sqlite3';

const LIFE_DB = process.env.LIFE_DB_PATH || '/app/data/life.db';

const defaultPersonality = {
  id: 1,
  vector_json: '[0.55,0.55,0.55,0.55,0.55,0.55,0.55,0.55]',
};

const defaultEmotion = {
  id: 0,
  vector_json: '[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]',
};

/** 读取最近的情绪向量与人格向量（最新一行），失败回退默认值 — 永不抛错 */
export async function getSelfState(): Promise<{ emotion: any | null; personality: any | null }> {
  let db: sqlite3.Database | null = null;
  try {
    db = new sqlite3.Database(LIFE_DB);
    const [emotionRow, personalityRow] = await Promise.all([
      new Promise<any>((resolve, reject) => {
        db!.get('SELECT * FROM emotion_state ORDER BY id DESC LIMIT 1', (err: any, row: any) => {
          if (err) reject(err); else resolve(row);
        });
      }),
      new Promise<any>((resolve, reject) => {
        db!.get('SELECT * FROM personality ORDER BY id DESC LIMIT 1', (err: any, row: any) => {
          if (err) reject(err); else resolve(row);
        });
      }),
    ]);
    return {
      emotion: emotionRow || defaultEmotion,
      personality: personalityRow || defaultPersonality,
    };
  } catch (e) {
    return { emotion: defaultEmotion, personality: defaultPersonality };
  } finally {
    if (db) db.close();
  }
}
