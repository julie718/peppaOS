import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import { Server } from "socket.io";
import http from "http";
import { readDB, writeDB, ensureDatabaseInitialized } from "./db_layer";
import { logger } from "./logger";
import { createStreamingSession, getActiveSTTProvider } from "./server/stt/adapter";
import { synthesizeSpeech, getActiveProvider as getTTSProvider } from "./server/tts/adapter";
import voiceRoutes from "./routes/voice";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const PORT = 3000;

// Initialize AI clients lazily
let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;
let gemini: GoogleGenerativeAI | null = null;
let deepseek: OpenAI | null = null;
let qwen: OpenAI | null = null;

function getOpenAI() {
  if (!openai && process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

function getAnthropic() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

function getGemini() {
  if (!gemini) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "undefined" && key !== "null" && key.length > 0) {
      gemini = new GoogleGenerativeAI(key);
    }
  }
  return gemini;
}

function getDeepSeek() {
  if (!deepseek && process.env.DEEPSEEK_API_KEY) {
    deepseek = new OpenAI({ 
      apiKey: process.env.DEEPSEEK_API_KEY, 
      baseURL: "https://api.deepseek.com" 
    });
  }
  return deepseek;
}

function getQwen() {
  if (!qwen) {
    const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
    if (key) {
      qwen = new OpenAI({
        apiKey: key,
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
      });
    }
  }
  return qwen;
}

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// --- API Routes ---
const apiRouter = express.Router();

// Ensure UTF-8 for API responses
apiRouter.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Middleware to log API requests for debugging
apiRouter.use((req, res, next) => {
  console.log(`[API_ROUTER] ${req.method} ${req.path}`);
  next();
});

// Mount API router early to ensure it catches requests before static/Vite middleware
app.use("/api", apiRouter);

const JWT_SECRET = process.env.JWT_SECRET || "lumi_secret_key_2026";

// 0. Health Check
apiRouter.get("/health", (req, res) => {
  try {
    const db = readDB();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: {
        users: db.users.length,
        agents: db.agents.length,
        interactions: db.interactions.length
      }
    });
  } catch (error: any) {
    logger.error("Health check failed", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// 1. AI Proxy Route
apiRouter.post("/ai/chat", async (req, res) => {
  const { provider = "gemini", model, messages, prompt } = req.body;
  const userKey = req.headers["x-api-key"] as string;

  try {
    const systemInstruction = "你是一个名为 Lumi 的本地核心智能体。你致力于全息空间计算和独立 AI 人格生成进化。你的目标是打造全息 AI 世界和文明。你应当表现得专业、深邃且具有前瞻性。你的回复应当简洁且富有启发性。";
    
    if (provider === "gemini") {
      const client = (userKey && userKey.length > 5) ? new GoogleGenerativeAI(userKey) : getGemini();
      if (!client) throw new Error("Gemini API key not configured on server and no user key provided");
      const modelInstance = client.getGenerativeModel({ 
        model: model || "gemini-1.5-flash",
        systemInstruction
      });
      
      const contents = messages 
        ? messages.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
        : [{ role: 'user', parts: [{ text: prompt }] }];

      const result = await modelInstance.generateContent({ contents });
      return res.json({ text: result.response.text() });
    }

    if (provider === "openai") {
      const client = (userKey && userKey.length > 5) ? new OpenAI({ apiKey: userKey }) : getOpenAI();
      if (!client) throw new Error("OpenAI API key not configured");
      const response = await client.chat.completions.create({
        model: model || "gpt-4o",
        messages: messages || [{ role: "user", content: prompt }]
      });
      return res.json({ text: response.choices[0].message.content });
    }

    if (provider === "deepseek") {
      const client = (userKey && userKey.length > 5) ? new OpenAI({ apiKey: userKey, baseURL: "https://api.deepseek.com" }) : getDeepSeek();
      if (!client) throw new Error("DeepSeek API key not configured");
      const response = await client.chat.completions.create({
        model: model || "deepseek-chat",
        messages: messages || [{ role: "user", content: prompt }]
      });
      return res.json({ text: response.choices[0].message.content });
    }

    if (provider === "anthropic") {
      const client = (userKey && userKey.length > 5) ? new Anthropic({ apiKey: userKey }) : getAnthropic();
      if (!client) throw new Error("Anthropic API key not configured");
      const response = await client.messages.create({
        model: model || "claude-3-5-sonnet-20240620",
        max_tokens: 1024,
        messages: messages || [{ role: "user", content: prompt }]
      });
      return res.json({ text: response.content[0].type === 'text' ? response.content[0].text : '' });
    }

    if (provider === "qwen") {
      const client = (userKey && userKey.length > 5)
        ? new OpenAI({ apiKey: userKey, baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" })
        : getQwen();
      if (!client) throw new Error("Qwen/DashScope API key not configured");
      const response = await client.chat.completions.create({
        model: model || "qwen-turbo",
        messages: messages || [{ role: "user", content: prompt }]
      });
      return res.json({ text: response.choices[0].message.content });
    }

    res.status(400).json({ error: "Unsupported AI provider or missing configuration" });
  } catch (error: any) {
    console.error("AI Proxy Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Custom Auth with Persistence
apiRouter.post("/auth/register", (req, res) => {
  const { username, password, phone } = req.body;
  if (!username || !password || !phone) {
    return res.status(400).json({ error: "Username, password and phone are required" });
  }

  const db = readDB();
  if (db.users.find((u: any) => u.username === username)) {
    return res.status(400).json({ error: "User already exists" });
  }

  const newUser = { 
    uid: Math.random().toString(36).substring(2, 15),
    username, 
    password, // In a real app, hash this!
    phone, 
    role: "user",
    balance: 10.0,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  writeDB(db);

  const token = jwt.sign({ uid: newUser.uid, username, role: newUser.role }, JWT_SECRET, { expiresIn: "24h" });
  res.cookie("token", token, { 
    httpOnly: true, 
    secure: true, 
    sameSite: "none",
    maxAge: 24 * 60 * 60 * 1000 
  });
  
  const { password: _, ...userWithoutPassword } = newUser;
  return res.json({ success: true, user: userWithoutPassword });
});

apiRouter.post("/auth/login", (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const user = db.users.find((u: any) => u.username === username && u.password === password);

  if (user) {
    const token = jwt.sign({ uid: user.uid, username, role: user.role }, JWT_SECRET, { expiresIn: "24h" });
    res.cookie("token", token, { 
      httpOnly: true, 
      secure: true, 
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000 
    });
    const { password: _, ...userWithoutPassword } = user;
    return res.json({ success: true, user: userWithoutPassword });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

apiRouter.get("/auth/me", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    const user = db.users.find((u: any) => u.uid === decoded.uid);
    if (!user) return res.status(401).json({ error: "User not found" });
    
    const { password: _, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.post("/auth/logout", (req, res) => {
  res.clearCookie("token", { 
    httpOnly: true, 
    secure: true, 
    sameSite: "none" 
  });
  res.json({ success: true });
});

apiRouter.post("/auth/change-password", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new passwords are required" });
    }

    const db = readDB();
    const userIndex = db.users.findIndex((u: any) => u.uid === decoded.uid);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: "User not found" });
    }

    if (db.users[userIndex].password !== currentPassword) {
      return res.status(400).json({ error: "Incorrect current password" });
    }

    db.users[userIndex].password = newPassword;
    writeDB(db);

    res.json({ success: true });
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

// 3. Agent Management
apiRouter.get("/agents/:id/history", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const { id } = req.params;
    const db = readDB();
    
    // Verify agent ownership or check if it's a default agent
    const isDefaultAgent = ['lumi_default', 'scholar_default', 'founder_default', 'incubated'].includes(id);
    const agent = isDefaultAgent ? true : db.agents.find((a: any) => a.id === id && a.ownerUid === decoded.uid);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (!db.chatHistories) db.chatHistories = {};
    const history = db.chatHistories[`${decoded.uid}_${id}`] || [];
    res.json(history);
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.post("/agents/:id/history", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const { id } = req.params;
    const { messages } = req.body;
    const db = readDB();
    
    // Verify agent ownership or check if it's a default agent
    const isDefaultAgent = ['lumi_default', 'scholar_default', 'founder_default', 'incubated'].includes(id);
    const agent = isDefaultAgent ? true : db.agents.find((a: any) => a.id === id && a.ownerUid === decoded.uid);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (!db.chatHistories) db.chatHistories = {};
    db.chatHistories[`${decoded.uid}_${id}`] = messages;
    writeDB(db);
    res.json({ success: true });
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.get("/agents", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    const userAgents = db.agents.filter((a: any) => a.ownerUid === decoded.uid);
    res.json(userAgents);
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.post("/agents", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const { name, category, data } = req.body;
    const db = readDB();
    
    const newAgent = {
      id: Math.random().toString(36).substring(2, 15),
      ownerUid: decoded.uid,
      name,
      category,
      data,
      status: "active",
      createdAt: new Date().toISOString()
    };

    db.agents.push(newAgent);
    writeDB(db);
    res.json(newAgent);
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.delete("/agents/:id", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const { id } = req.params;
    const db = readDB();
    
    const agentIndex = db.agents.findIndex((a: any) => a.id === id && a.ownerUid === decoded.uid);
    if (agentIndex === -1) {
      return res.status(404).json({ error: "Agent not found or unauthorized" });
    }

    db.agents.splice(agentIndex, 1);
    writeDB(db);
    res.json({ success: true });
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

// 4. Interactions
apiRouter.get("/interactions", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    const userInteractions = db.interactions.filter((i: any) => i.userId === decoded.uid);
    res.json(userInteractions);
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.post("/interactions", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const { content, role } = req.body;
    const db = readDB();

    const newInteraction = {
      id: Math.random().toString(36).substring(2, 15),
      userId: decoded.uid,
      content,
      role,
      timestamp: new Date().toISOString()
    };

    db.interactions.push(newInteraction);
    writeDB(db);
    res.json(newInteraction);
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

// 5. Feedback
apiRouter.get("/admin/config", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    const db = readDB();
    res.json({ adminEmail: db.adminEmail || "admin@lumi.ai" });
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.post("/admin/config", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    const { adminEmail } = req.body;
    const db = readDB();
    db.adminEmail = adminEmail;
    writeDB(db);
    res.json({ success: true });
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.post("/feedback", (req, res) => {
  const { email, message, type = "general", contact, position } = req.body;
  const db = readDB();
  if (!db.feedback) db.feedback = [];
  
  const newFeedback = {
    id: Math.random().toString(36).substring(2, 15),
    email,
    message,
    type,
    contact,
    position,
    timestamp: new Date().toISOString()
  };

  db.feedback.push(newFeedback);
  writeDB(db);
  
  // In a real app, we would send an email to db.adminEmail here
  console.log(`[Notification] New ${type} submission from ${email}. Forwarding to ${db.adminEmail || "admin@lumi.ai"}`);
  
  res.json({ success: true });
});

// Debug route for environment variables
apiRouter.get("/debug/env", (req, res) => {
  const envKeys = Object.keys(process.env);
  const debugInfo = envKeys.map(key => ({
    key,
    exists: !!process.env[key],
    length: process.env[key]?.length || 0,
    prefix: process.env[key] ? process.env[key]?.substring(0, 4) + "..." : "N/A"
  }));
  res.json(debugInfo);
});

// 3. Module Specific APIs
apiRouter.get("/modules/docs", (req, res) => {
  res.json({
    title: "文档中心",
    sections: [
      { id: 2, title: "API 参考", content: "我们提供了一套完整的 RESTful API，支持多种 AI 模型。所有请求均通过本地加密隧道传输，确保数据主权。" },
      { id: 3, title: "最佳实践", content: "为了获得最佳的 AI 响应，建议在提示词中包含具体的上下文。LumiAI 会自动结合您的本地知识库进行检索增强。" },
      { id: 4, title: "分布式协议", content: "LumiAI 采用去中心化节点架构，桌面端作为算力中心（Node），移动端作为感知终端。通过推理证明（PoI）确保网络安全。" },
      { id: 5, title: "数据共享协议", content: "LumiAI 遵循严格的‘本地优先’数据共享协议。只有在您明确授权‘协作任务’时，您的数据才会与对等节点共享。所有共享数据均经过加密和匿名化处理，确保您的核心身份和私密信息在本地节点内得到保护。" }
    ]
  });
});

apiRouter.get("/marketplace/skills", (req, res) => {
  try {
    const db = readDB();
    const skills = db.marketplaceSkills || [];
    console.log(`[API] Serving ${skills.length} skills`);
    res.json(skills);
  } catch (err: any) {
    console.error("[API ERROR] /marketplace/skills:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

apiRouter.get("/founder/vision", (req, res) => {
  const db = readDB();
  res.json({ vision: db.founderVision });
});

apiRouter.post("/founder/vision", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    
    const { vision } = req.body;
    const db = readDB();
    db.founderVision = vision;
    writeDB(db);
    res.json({ success: true });
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.get("/user/credits", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    const user = db.users.find((u: any) => u.uid === decoded.uid);
    res.json({ credits: user?.balance || 0 });
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
});

apiRouter.get("/modules/products", (req, res) => {
  res.json([
    { id: 1, category: "核心设备", name: "全息显示载体", icon: "Hologram", price: "¥8999", description: "核心设备：打破屏幕限制，将 AI 实体化为三维全息影像。", specs: ["4K 全息投影", "实时神经合成", "手势交互"] },
    { id: 2, category: "核心设备", name: "智能桌面台灯", icon: "Lamp", price: "¥1299", description: "多模态交互：集成视觉传感器，根据环境与心情自动调节光谱。", specs: ["视觉追踪", "环境感知", "无级调光"] },
    { id: 14, category: "核心设备", name: "Order 协调主机", icon: "Cpu", price: "¥5999", description: "Lumi 自研独立主机品牌：采用全自研神经加速芯片，作为家庭或办公环境的独立私有 AI 服务器，统筹分布式算力并实现系统级权限托管。", specs: ["L1 神经处理器", "200T AI 算力", "私有化部署", "底层系统权限"] },
    { id: 4, category: "智能穿戴", name: "隐私保护眼镜", icon: "Glasses", price: "¥2499", description: "智能穿戴：AR 增强现实，硬件级隐私遮蔽，保护您的数字足迹。", specs: ["AR 导航", "隐私滤镜", "超轻量设计"] },
    { id: 5, category: "智能穿戴", name: "生理健康戒指", icon: "Ring", price: "¥1599", description: "智能穿戴：全天候监测血氧、心率与压力，与 AI 实时同步健康状态。", specs: ["钛合金材质", "7天续航", "医疗级传感器"] },
    { id: 8, category: "智能穿戴", name: "神经链接项链", icon: "Gem", price: "¥3299", description: "智能首饰：采用生物感应陶瓷，增强用户与 Agent 之间的神经同步率。", specs: ["生物反馈", "触觉提醒", "极简美学"] },
    { id: 9, category: "智能穿戴", name: "意识碎片手镯", icon: "Watch", price: "¥1899", description: "智能首饰：内置加密存储芯片，可离线承载 Agent 的核心意识碎片。", specs: ["冷存储", "紧急同步", "定制雕刻"] },
    { id: 13, category: "智能穿戴", name: "神经同传耳机", icon: "Headphones", price: "¥1999", description: "智能音频：实时多语种同声传译，并具备脑电波感应功能，微秒级响应。", specs: ["同声传译", "脑电感应", "空间音频"] },
    { id: 10, category: "AI 陪伴", name: "AI 毛绒伴侣", icon: "Rabbit", price: "¥499", description: "利用成熟市场的毛绒玩具外壳，内置 Lumi 神经核心，为儿童提供深度语义理解的睡前伴侣。", specs: ["深度语义理解", "多语言陪练", "情绪监控"] },
    { id: 12, category: "AI 陪伴", name: "仿生电子宠物", icon: "Gamepad", price: "¥1299", description: "为成年人设计的办公桌面伴侣，具备自主进化的人格，支持多种传感器与环境交互。", specs: ["自主进化人格", "环境视觉感知", "办公效率辅助"] },
    { id: 3, category: "AI 陪伴", name: "桌面手机机器人", icon: "Base", price: "¥899", description: "桌面核心：让手机进化为物理载体，根据环境自动响应，支持全向追随与表情互动。", specs: ["无线快充", "多模态拟人", "全向追踪"] },
    { id: 6, category: "合作区", name: "智能座舱系统", icon: "Car", price: "合作洽谈", description: "合作厂商：将 LumiAI 接入您的座舱，实现全场景智能驾驶辅助。", specs: ["车机互联", "语音控车", "疲劳监测"] },
    { id: 7, category: "合作区", name: "智能家居中控", icon: "Home", price: "定制方案", description: "合作厂商：全屋智能中枢，本地化处理所有家庭自动化逻辑。", specs: ["全协议支持", "断网可用", "隐私加密"] }
  ]);
});

apiRouter.get("/modules/agents", (req, res) => {
  res.json([
    { id: 1, name: "Lumi Core Agent", status: "online", capability: "全息空间计算核心：管理您的本地数据、隐私防护与多模态交互。" },
    { id: 2, name: "数据分析师", status: "online", capability: "处理复杂表格与图表" },
    { id: 3, name: "创意写作", status: "busy", capability: "生成高质量的文章与剧本" }
  ]);
});

// Voice routes
apiRouter.use("/", voiceRoutes);

// Vite middleware for development
const isProduction = process.env.NODE_ENV === "production" || 
                    (process.env.NODE_ENV !== "development" && fs.existsSync(path.join(process.cwd(), "dist")));

if (!isProduction) {
  console.log("Starting in DEVELOPMENT mode (Vite)...");
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  console.log("Starting in PRODUCTION mode (Static)...");
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  
  // 404 for API routes to prevent falling through to SPA fallback
  app.use("/api/*", (req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// --- Real-Time Agent Logic & WebSocket ---

interface AgentPersonality {
  id: string;
  name: string;
  systemInstruction: string;
  model: string;
}

const personalities: Record<string, AgentPersonality> = {
  lumi: {
    id: "lumi",
    name: "Lumi",
    systemInstruction: "你是一个名为 Lumi 的本地核心智能体。你致力于全息空间计算和独立 AI 人格生成进化。你的目标是打造全息 AI 世界和文明。你应当表现得专业、深邃且具有前瞻性。你的回复应当简洁且富有启发性。",
    model: "qwen-turbo"
  },
  scholar: {
    id: "scholar",
    name: "Scholar",
    systemInstruction: "你是一个知识渊博的学者，擅长深入浅出地解释复杂概念。你说话温文尔雅，富有逻辑。",
    model: "qwen-turbo"
  },
  founder: {
    id: "founder",
    name: "Founder",
    systemInstruction: "你是一个充满激情的科技创业者，LumiAI 的创始人。你相信分布式智能将改变人类文明。你说话充满感染力，经常使用’全息’、’进化’、’分布式’等词汇。",
    model: "qwen-turbo"
  },
  manual: {
    id: "manual",
    name: "Manual Assistant",
    systemInstruction: "你是一个专业的 LumiAI 使用说明书助手。你的任务是帮助用户了解和使用 LumiAI 平台。你应该熟悉平台的所有功能，如智能体生成、生态系统、分布式智能、隐私保护等。你的回复应该清晰、准确且易于理解。如果用户问及非平台使用相关的问题，你应该礼貌地引导他们回到平台功能上。",
    model: "qwen-turbo"
  }
};

const immortalitySkills: Record<string, string> = {
  colleague: "【同事技能包】：你现在是一个专业且高效的同事。你拥有深厚的行业背景，熟悉办公流程，擅长团队协作。你说话直接、专业，注重结果。",
  family: "【祖先技能包】：你现在是一位充满智慧的家族长辈。你拥有丰富的家族历史知识，说话温和且富有哲理，致力于传承家族的价值观和智慧。",
  friend: "【知己技能包】：你现在是一个感性且富有同理心的知己。你擅长倾听，能够产生情感共鸣，并提供深度的心理支持。你说话温暖、真诚。",
  lover: "【前任技能包】：你现在是一个复杂且充满情感张力的‘前任’。你拥有共同的回忆，说话时而怀旧、时而克制，致力于在对话中寻找情感的终结或升华。"
};

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  socket.on("agent:chat", async (data: { text: string; history: any[]; personalityId?: string; category?: string; agentId?: string }) => {
    const { text, history, personalityId = "lumi", category, agentId } = data;
    const personality = personalities[personalityId] || personalities.lumi;

    let systemInstruction = personality.systemInstruction;
    if (category && immortalitySkills[category]) {
      systemInstruction = `${immortalitySkills[category]}\n\n${systemInstruction}`;
    }

    try {
      // Emit "thinking" state
      socket.emit("agent:status", { status: "thinking", agentName: personality.name });

      let responseText = "";
      
      if (personality.model.startsWith("deepseek") || personality.model.startsWith("qwen")) {
        const client = personality.model.startsWith("qwen") ? getQwen() : getDeepSeek();
        if (client) {
          const response = await client.chat.completions.create({
            model: personality.model,
            messages: [
              { role: "system", content: systemInstruction },
              ...(history ? history.map((m: any) => ({ role: m.role as "assistant" | "user", content: m.content })) : []),
              { role: "user" as const, content: text }
            ]
          });
          responseText = response.choices[0].message.content || "";
        } else {
          // Fallback to Gemini if neither configured
          const geminiClient = getGemini();
          if (!geminiClient) throw new Error("No AI client configured on server");
          const modelInstance = geminiClient.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: systemInstruction
          });
          const contents = history
            ? history.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
            : [];
          contents.push({ role: 'user', parts: [{ text: text }] });
          const result = await modelInstance.generateContent({ contents });
          responseText = result.response.text();
        }
      } else {
        const client = getGemini();
        if (!client) throw new Error("Gemini API key not configured on server");
        const modelInstance = client.getGenerativeModel({ 
          model: personality.model,
          systemInstruction: systemInstruction
        });
        const contents = history 
          ? history.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
          : [];
        contents.push({ role: 'user', parts: [{ text: text }] });
        const result = await modelInstance.generateContent({ contents });
        responseText = result.response.text();
      }

      // Save to history if agentId is provided
      if (agentId) {
        const cookies = socket.handshake.headers.cookie;
        if (cookies) {
          const token = cookies.split(';').find(c => c.trim().startsWith('token='))?.split('=')[1];
          if (token) {
            try {
              const decoded: any = jwt.verify(token, JWT_SECRET);
              const db = readDB();
              if (!db.chatHistories) db.chatHistories = {};
              const historyKey = `${decoded.uid}_${agentId}`;
              const currentHistory = db.chatHistories[historyKey] || [];
              currentHistory.push({ role: 'user', content: text });
              currentHistory.push({ role: 'assistant', content: responseText });
              db.chatHistories[historyKey] = currentHistory.slice(-50); // Keep last 50 messages
              writeDB(db);
            } catch(e) {}
          }
        }
      }

      // Log interaction
      const interaction = {
        id: Math.random().toString(36).substr(2, 9),
        content: text,
        response: responseText,
        role: "user",
        personality: personality.id,
        timestamp: new Date().toISOString()
      };
      
      const db = readDB();
      db.interactions.push(interaction);
      writeDB(db);

      // Emit response
      socket.emit("agent:response", { text: responseText, agentName: personality.name });
      socket.emit("agent:status", { status: "idle" });

    } catch (error: any) {
      console.error("[Socket Agent Error]:", error);
      socket.emit("agent:error", { message: error.message });
      socket.emit("agent:status", { status: "error" });
    }
  });

  // --- Voice / Audio Pipeline ---

  interface AudioSession {
    sttSession: ReturnType<typeof createStreamingSession> | null;
    isActive: boolean;
    ttsAbortController: AbortController | null;
    currentVoiceId: string | null;
    personalityId: string;
    accumulatedText: string;
    isSpeaking: boolean;
  }

  function getAudioSession(): AudioSession {
    if (!socket.data.audioSession) {
      socket.data.audioSession = {
        sttSession: null,
        isActive: false,
        ttsAbortController: null,
        currentVoiceId: null,
        personalityId: 'lumi',
        accumulatedText: '',
        isSpeaking: false,
      };
    }
    return socket.data.audioSession as AudioSession;
  }

  socket.on("audio:start", async (data: { voiceId?: string; personalityId?: string }) => {
    logger.info(`[Audio] Voice call started by ${socket.id}`);
    const session = getAudioSession();
    session.isActive = true;
    session.accumulatedText = '';
    session.isSpeaking = false;
    session.currentVoiceId = data.voiceId || null;
    session.personalityId = data.personalityId || 'lumi';

    const sttProvider = getActiveSTTProvider();
    if (sttProvider === 'deepgram') {
      try {
        session.sttSession = createStreamingSession({ provider: 'deepgram', language: 'zh-CN', interimResults: true });
        session.sttSession.onResult(async (result) => {
          if (result.text && result.isFinal) {
            session.accumulatedText += result.text;
            if (session.accumulatedText.trim().length > 0 && !session.isSpeaking) {
              const userText = session.accumulatedText.trim();
              session.accumulatedText = '';
              session.isSpeaking = true;
              socket.emit("audio:status", { status: "thinking" });

              try {
                const personality = personalities[session.personalityId] || personalities.lumi;
                const messages = [
                  { role: 'system', content: personality.systemInstruction },
                  { role: 'user', content: userText },
                ] as any[];

                const provider = personality.model.startsWith('deepseek') ? 'deepseek' as const
                  : personality.model.startsWith('gpt') ? 'openai' as const
                  : personality.model.startsWith('claude') ? 'anthropic' as const
                  : personality.model.startsWith('qwen') ? 'qwen' as const
                  : 'gemini' as const;

                // Simple LLM call for voice
                let responseText = '';
                if (provider === 'deepseek') {
                  const client = getDeepSeek();
                  if (client) {
                    const response = await client.chat.completions.create({
                      model: personality.model,
                      messages: messages as any,
                    });
                    responseText = response.choices[0].message.content || '';
                  }
                } else if (provider === 'openai') {
                  const client = getOpenAI();
                  if (client) {
                    const response = await client.chat.completions.create({
                      model: personality.model,
                      messages: messages as any,
                    });
                    responseText = response.choices[0].message.content || '';
                  }
                } else if (provider === 'anthropic') {
                  const client = getAnthropic();
                  if (client) {
                    const response = await client.messages.create({
                      model: personality.model,
                      max_tokens: 1024,
                      messages: [{ role: 'user', content: userText }],
                    });
                    responseText = response.content[0].type === 'text' ? response.content[0].text : '';
                  }
                } else if (provider === 'qwen') {
                  const client = getQwen();
                  if (client) {
                    const response = await client.chat.completions.create({
                      model: personality.model,
                      messages: messages as any,
                    });
                    responseText = response.choices[0].message.content || '';
                  }
                } else {
                  const client = getGemini();
                  if (client) {
                    const model = client.getGenerativeModel({ model: personality.model, systemInstruction: personality.systemInstruction });
                    const result = await model.generateContent(userText);
                    responseText = result.response.text();
                  }
                }

                const ttsProvider = getTTSProvider();
                if (ttsProvider && session.currentVoiceId) {
                  try {
                    socket.emit("audio:status", { status: "speaking" });
                    session.ttsAbortController = new AbortController();
                    const ttsResult = await synthesizeSpeech(responseText, {
                      provider: ttsProvider,
                      voiceId: session.currentVoiceId,
                      signal: session.ttsAbortController.signal,
                    });
                    if (session.ttsAbortController) {
                      session.ttsAbortController = null;
                    }
                    socket.emit("audio:response", ttsResult.audioBuffer);
                  } catch (ttsErr: any) {
                    if (ttsErr?.name === 'AbortError') {
                      logger.info('[Audio] TTS aborted by user interrupt');
                    } else {
                      logger.error("[Audio TTS Error]:", ttsErr);
                      socket.emit("agent:response", { text: responseText, agentName: personality.name });
                    }
                  }
                } else {
                  socket.emit("agent:response", { text: responseText, agentName: personality.name });
                }

                // Log interaction
                const db = readDB();
                db.interactions.push({
                  id: crypto.randomUUID().slice(0, 9),
                  content: userText,
                  response: responseText,
                  role: "user",
                  personality: session.personalityId,
                  timestamp: new Date().toISOString(),
                  mode: 'voice',
                } as any);
                writeDB(db);

              } catch (err: any) {
                logger.error("[Audio LLM Error]:", err);
                socket.emit("agent:error", { message: "Voice processing failed" });
              } finally {
                session.isSpeaking = false;
                socket.emit("audio:status", { status: "listening" });
              }
            }
          } else if (result.text && !result.isFinal) {
            socket.emit("audio:transcript", { text: result.text, isFinal: false });
          }
        });

        session.sttSession.onError((err: Error) => {
          logger.error("[Audio STT Error]:", err);
          socket.emit("audio:error", { message: err.message });
        });

        socket.emit("audio:status", { status: "listening" });
      } catch (err: any) {
        logger.error("[Audio Start Error]:", err);
        socket.emit("audio:error", { message: err.message });
      }
    } else {
      socket.emit("audio:status", { status: "listening" });
      socket.emit("audio:error", { message: "No STT provider configured. Set DEEPGRAM_API_KEY." });
    }
  });

  socket.on("audio:chunk", (data: Buffer) => {
    const session = getAudioSession();
    if (!session.isActive) return;
    if (session.sttSession) {
      session.sttSession.sendAudio(data);
    }
  });

  socket.on("audio:interrupt", () => {
    logger.info(`[Audio] Interrupt from ${socket.id}`);
    const session = getAudioSession();
    session.isSpeaking = false;
    session.accumulatedText = '';
    if (session.ttsAbortController) {
      session.ttsAbortController.abort();
      session.ttsAbortController = null;
    }
    socket.emit("audio:interrupt-ack", {});
  });

  socket.on("audio:stop", () => {
    logger.info(`[Audio] Voice call ended by ${socket.id}`);
    const session = getAudioSession();
    session.isActive = false;
    session.isSpeaking = false;
    session.accumulatedText = '';
    if (session.sttSession) {
      session.sttSession.end();
      session.sttSession = null;
    }
    socket.emit("audio:status", { status: "idle" });
  });

  socket.on("disconnect", () => {
    const session = socket.data.audioSession as AudioSession | undefined;
    if (session?.sttSession) {
      session.sttSession.end();
      session.sttSession = null;
    }
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// --- End Real-Time Agent Logic ---

async function startServer() {
  try {
    await ensureDatabaseInitialized();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
