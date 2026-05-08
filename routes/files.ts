import { Router, Request, Response } from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { readDB, writeDB } from '../db_layer';
import { ingestDocument } from '../server/agents/rag';

const router = Router();
const filesDir = path.join(process.cwd(), 'data', 'files');
fs.mkdirSync(filesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, filesDir),
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-. ]/g, '');
    cb(null, `${timestamp}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// GET /api/files/list — list files and folders
router.get('/files/list', (req: Request, res: Response) => {
  try {
    const dirPath = (req.query.path as string) || '';
    const targetDir = dirPath ? path.join(filesDir, dirPath) : filesDir;

    // Prevent directory traversal
    const resolved = path.resolve(targetDir);
    if (!resolved.startsWith(path.resolve(filesDir))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(resolved)) {
      return res.json({ files: [] });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const files = entries.map((entry, i) => {
      const fullPath = path.join(resolved, entry.name);
      const stat = fs.statSync(fullPath);
      const isDir = entry.isDirectory();

      return {
        id: entry.name,
        name: entry.name,
        type: isDir ? 'folder' as const : 'file' as const,
        size: isDir ? '--' : formatSize(stat.size),
        status: 'local' as const,
        updatedAt: stat.mtime.toISOString(),
        ...(isDir ? { children: [] } : {}),
      };
    });

    // Folders first, then files, alphabetically
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/files/upload — upload files
router.post('/files/upload', upload.array('files', 20), (req: Request, res: Response) => {
  try {
    const uploadedFiles = req.files as Express.Multer.File[];
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Save metadata to DB
    const db = readDB();
    if (!db.fileMetadata) db.fileMetadata = [];
    for (const f of uploadedFiles) {
      db.fileMetadata.push({
        id: f.filename,
        originalName: f.originalname,
        size: f.size,
        mimeType: f.mimetype,
        uploadedAt: new Date().toISOString(),
      });
    }
    writeDB(db);

    res.json({
      uploaded: uploadedFiles.map(f => ({ id: f.filename, name: f.originalname, size: formatSize(f.size) })),
      count: uploadedFiles.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/files/delete/:id — delete a file
router.delete('/files/delete/:id', (req: Request, res: Response) => {
  try {
    const fileId = req.params.id;

    // Try to find by filename (id = filename from our naming convention)
    const filePath = path.join(filesDir, fileId);
    const resolved = path.resolve(filePath);

    if (!resolved.startsWith(path.resolve(filesDir))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      fs.unlinkSync(resolved);
    }

    // Also clean up DB metadata
    const db = readDB();
    if (db.fileMetadata) {
      db.fileMetadata = db.fileMetadata.filter((m: any) => m.id !== fileId);
      writeDB(db);
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/download/:id — download a file
router.get('/files/download/:id', (req: Request, res: Response) => {
  try {
    const fileId = req.params.id;
    const filePath = path.join(filesDir, fileId);
    const resolved = path.resolve(filePath);

    if (!resolved.startsWith(path.resolve(filesDir))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }

    const db = readDB();
    const meta = db.fileMetadata?.find((m: any) => m.id === fileId);
    const originalName = meta?.originalName || fileId;
    res.download(resolved, originalName);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/files/rename — rename a file or folder
router.post('/files/rename', (req: Request, res: Response) => {
  try {
    const { id, newName } = req.body;
    if (!id || !newName) return res.status(400).json({ error: 'id and newName are required' });

    const oldPath = path.join(filesDir, id);
    const resolvedOld = path.resolve(oldPath);
    if (!resolvedOld.startsWith(path.resolve(filesDir))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(resolvedOld)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const newPath = path.join(path.dirname(resolvedOld), newName);
    fs.renameSync(resolvedOld, newPath);

    // Update DB metadata
    const db = readDB();
    if (db.fileMetadata) {
      const meta = db.fileMetadata.find((m: any) => m.id === id);
      if (meta) {
        meta.id = path.basename(newPath);
        meta.originalName = newName;
      }
      writeDB(db);
    }

    res.json({ success: true, id: path.basename(newPath), name: newName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/info/:id — get file metadata
router.get('/files/info/:id', (req: Request, res: Response) => {
  try {
    const fileId = req.params.id;
    const filePath = path.join(filesDir, fileId);
    const resolved = path.resolve(filePath);

    if (!resolved.startsWith(path.resolve(filesDir))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(resolved);
    res.json({
      id: fileId,
      name: fileId,
      size: stat.size,
      formattedSize: formatSize(stat.size),
      type: stat.isDirectory() ? 'folder' : 'file',
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/files/ingest — chunk a file into agent's private memory (RAG)
router.post('/files/ingest', async (req: Request, res: Response) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const JWT_SECRET = process.env.JWT_SECRET || 'lumi_secret_key_2026';
    let userId: string;
    try {
      const decoded: any = jwt.verify(token, JWT_SECRET);
      userId = decoded.uid;
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { fileId, agentId } = req.body;
    if (!fileId || !agentId) {
      return res.status(400).json({ error: 'fileId and agentId are required' });
    }

    const filePath = path.join(filesDir, fileId);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(filesDir))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    const result = await ingestDocument(userId, agentId, fileId, content);
    res.json({ success: true, chunkCount: result.chunkCount, memoryIds: result.memoryIds });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default router;
