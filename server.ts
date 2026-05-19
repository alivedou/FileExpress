/**
 * 文件快递柜 后端服务
 * 作者: adou
 * 功能：提供文件加密存储、提取、公开分享及存储容量熔断机制
 */
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import AdmZip from "adm-zip";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import crypto from "crypto";

// --- 环境变量配置 ---
const APP_NAME = process.env.APP_NAME || "File Express";
const APP_SUBTITLE = process.env.APP_SUBTITLE || "极简、安全、临时的文件传输中心";
// 单个文件最大限制 (MB)
const MAX_SINGLE_FILE_SIZE_MB = parseInt(process.env.MAX_SINGLE_FILE_SIZE_MB || "10");
// ZIP 压缩包最大限制 (MB)
const MAX_ZIP_PAYLOAD_SIZE_MB = parseInt(process.env.MAX_ZIP_PAYLOAD_SIZE_MB || "50");
// 全局存储配额限制 (MB) - 当总占用达到此值时将触发自动清理或停止上传
const MAX_TOTAL_STORAGE_MB = parseInt(process.env.MAX_TOTAL_STORAGE_MB || "1024"); 
// 加密密钥：建议在生产环境中通过环境变量设置 32 位随机字符串
const ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY || "8664183d-3b8f-431f-9988-6622b72f104d"; 

// --- 加密助手函数 ---
/**
 * 使用 AES-256-GCM 对 Buffer 进行加密
 * GCM 模式提供认证加密，确保数据未被篡改
 */
function encrypt(buffer: Buffer): Buffer {
    const iv = crypto.randomBytes(12); // 初始化向量 (12字节是 GCM 推荐长度)
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag(); // 获取身份验证标签
    // 返回格式: [IV (12字节)] [AuthTag (16字节)] [加密后的数据]
    return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * 解密经 AES-256-GCM 加密的数据
 */
function decrypt(buffer: Buffer): Buffer | null {
    try {
        const iv = buffer.slice(0, 12);
        const authTag = buffer.slice(12, 28);
        const encrypted = buffer.slice(28);
        const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (e) {
        console.error("解密失败（可能是密钥不匹配或数据损坏）:", e);
        return null;
    }
}

// --- 防滥用频率限制 (Anti-Abuse) ---
const rateLimitMap = new Map<string, { count: number; lastReset: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 小时窗口
const MAX_UPLOADS_PER_WINDOW = 20; // 每个 IP 每推 20 次

/**
 * 核心限流中间件
 */
function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
    const ip = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    const now = Date.now();
    const userLimit = rateLimitMap.get(ip);

    if (!userLimit || (now - userLimit.lastReset) > RATE_LIMIT_WINDOW_MS) {
        rateLimitMap.set(ip, { count: 1, lastReset: now });
        return next();
    }

    if (userLimit.count >= MAX_UPLOADS_PER_WINDOW) {
        console.warn(`[限流触发] IP: ${ip} 尝试频率过高`);
        return res.status(429).json({ error: "操作过于频繁，请 1 小时后再试" });
    }

    userLimit.count++;
    next();
}

// 每 24 小时自动清空一次限流缓存，防止长时间运行导致内存溢出
setInterval(() => {
    rateLimitMap.clear();
}, 24 * 60 * 60 * 1000);

const LOCAL_DB_PATH = path.join(process.cwd(), "local_db.json");
const LOCAL_STORAGE_DIR = path.join(process.cwd(), "local_storage");

// 确保本地存储目录存在
if (!fs.existsSync(LOCAL_STORAGE_DIR)) {
    fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
}

// 加载元数据数据库
function loadLocalDb() {
    if (fs.existsSync(LOCAL_DB_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(LOCAL_DB_PATH, "utf-8"));
        } catch { return { files: {} }; }
    }
    return { files: {} };
}
// 写入元数据数据库
function saveLocalDb(data: any) { fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2)); }

// 存储二进制文件到物理目录
function saveLocalFile(id: string, buffer: Buffer): string {
    const filePath = path.join(LOCAL_STORAGE_DIR, id);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

// 从物理目录提取二进制文件
function getLocalFile(id: string): Buffer | null {
    const filePath = path.join(LOCAL_STORAGE_DIR, id);
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath);
    }
    return null;
}

// 删除物理文件
function deleteLocalFile(id: string) {
    const filePath = path.join(LOCAL_STORAGE_DIR, id);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// 使用 Multer 处理文件上传，将其缓存在内存中以便直接加密
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_ZIP_PAYLOAD_SIZE_MB * 1024 * 1024 // 设置最大包体积
    }
});

// Multer 错误处理中间件
function handleMulterError(err: any, req: express.Request, res: express.Response, next: express.NextFunction) {
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ error: `文件体积超出服务器限制 (${MAX_ZIP_PAYLOAD_SIZE_MB}MB)` });
        }
        return res.status(400).json({ error: `上传错误: ${err.message}` });
    }
    next(err);
}

// --- API 路由 ---

// 健康检查接口
app.get("/api/health", (req, res) => {
    res.json({ 
        status: "ok", 
        mode: "local",
        timestamp: new Date().toISOString() 
    });
});

/**
 * 存储容量检查：熔断机制逻辑
 * 检查当前服务器占用总容量，如果接近阈值则触发过期文件清理
 */
async function checkStorageLimit(): Promise<boolean> {
    const local = loadLocalDb();
    let totalSize = 0;
    // 1. 计算内存中元数据的占用 (主要是文本内容)
    Object.values(local.files).forEach((f: any) => {
        if (f.type === "public" && f.content) {
            totalSize += Buffer.from(f.content).length;
        }
    });

    // 2. 计算物理二进制文件的实际硬盘占用
    if (fs.existsSync(LOCAL_STORAGE_DIR)) {
        const files = fs.readdirSync(LOCAL_STORAGE_DIR);
        files.forEach(file => {
            const stats = fs.statSync(path.join(LOCAL_STORAGE_DIR, file));
            if (stats.isFile()) {
                totalSize += stats.size;
            }
        });
    }

    const usageMb = totalSize / (1024 * 1024);
    
    // 如果占用超过总限额的 90%，触发积极清理
    if (usageMb > MAX_TOTAL_STORAGE_MB * 0.9) {
        console.warn(`[存储预警] 当前占用 ${usageMb.toFixed(2)}MB，接近上限 ${MAX_TOTAL_STORAGE_MB}MB。触发强制清理。`);
        const now = new Date();
        let cleaned = 0;
        Object.keys(local.files).forEach(id => {
            // 删除所有已过期的文件
            if (new Date(local.files[id].expiryDate) < now) {
                if (local.files[id].isLocalBinary) deleteLocalFile(id);
                delete local.files[id];
                cleaned++;
            }
        });
        if (cleaned > 0) saveLocalDb(local);
    }

    // 如果清理后依然超限，返回 false (阻断上传)
    return usageMb < MAX_TOTAL_STORAGE_MB;
}

// 获取前端基本配置
app.get("/api/config", (req, res) => {
    res.json({
        appName: APP_NAME,
        appSubtitle: APP_SUBTITLE,
        maxSingleFileMB: MAX_SINGLE_FILE_SIZE_MB,
        maxZipPayloadMB: MAX_ZIP_PAYLOAD_SIZE_MB
    });
});

/**
 * 公开模式上传接口
 * 仅允许 .txt 文件，直接存入 JSON 数据库，不进行加密（因为是公开分享）
 */
app.post("/api/upload/public", rateLimiter, upload.single("file"), handleMulterError, async (req, res) => {
    try {
        if (!(await checkStorageLimit())) {
            return res.status(507).json({ error: "STORAGE_QUOTA_EXCEEDED" });
        }
        const file = req.file;
        const textContent = req.body.content;
        const title = req.body.title;

        if (!file && !textContent) {
            return res.status(400).json({ error: "No file or content provided" });
        }

        let fileName = "untitled.txt";
        let content = "";

        if (file) {
            if (!file.originalname.endsWith(".txt")) {
                return res.status(400).json({ error: "公开模式仅支持 .txt 文件" });
            }
            fileName = file.originalname.trim() || "untitled.txt";
            content = file.buffer.toString("utf-8");
        } else {
            if (title && title.trim()) {
                const cleanTitle = title.trim();
                fileName = cleanTitle.toLowerCase().endsWith(".txt") ? cleanTitle : `${cleanTitle}.txt`;
            } else {
                fileName = "untitled.txt";
            }
            content = textContent || "";
        }

        if (!content && !file) {
            return res.status(400).json({ error: "内容不能为空" });
        }

        // 生成 ID：根据文件名生成固定 ID，以实现同名文件覆盖逻辑
        const id = `pub_${fileName.toLowerCase().replace(/[^a-z0-9.]/gi, '_')}`;
        
        // 公开内容有效期固定为 3 天
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 3);

        const fileRecord: any = {
            id,
            type: "public",
            fileName,
            content,
            mimeType: "text/plain",
            expiryDate: expiryDate.toISOString(),
            createdAt: new Date().toISOString(),
            downloadCount: 0
        };

        const local = loadLocalDb();
        
        // 保留原有的下载次数如果需要（这里可以根据需求决定是否保留，根据题意直接覆盖即可）
        if (local.files[id]) {
            fileRecord.downloadCount = local.files[id].downloadCount;
            // 顺便可以在控制台打印一下覆盖事件
            console.log(`[Public File Overwrite] ID: ${id}`);
        }
        
        local.files[id] = fileRecord;
        saveLocalDb(local);
        
        res.json({
            success: true,
            id,
            url: `/view/${id}`,
            expiresAt: fileRecord.expiryDate
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 私密柜上传接口
 * 支持多格式，强制进行 AES 加密，元数据存 JSON，二进制存硬盘
 */
app.post("/api/upload/private", rateLimiter, upload.array("files"), handleMulterError, async (req, res) => {
    try {
        if (!(await checkStorageLimit())) {
            return res.status(507).json({ error: "STORAGE_QUOTA_EXCEEDED" });
        }
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "未选择上传文件" });
        }

        // 生成唯一的 6 位提取码
        let pickupCode = "";
        let isUnique = false;
        let attempts = 0;
        const local = loadLocalDb();
        
        // 尝试生成不重复的验证码
        while (!isUnique && attempts < 10) {
            pickupCode = Math.floor(100000 + Math.random() * 900000).toString();
            const existing = Object.values(local.files).find((f: any) => f.type === "private" && f.pickupCode === pickupCode);
            if (!existing) isUnique = true;
            else attempts++;
        }

        const durationHours = parseInt(req.body.duration) || 24;
        const maxDownloads = 5; // 私密柜默认最多提取 5 次，之后即刻销毁

        // 文件格式审查
        const allowedExtensions = [".jpg", ".jpeg", ".png", ".txt", ".md", ".zip"];
        for (const file of files) {
            const ext = path.extname(file.originalname).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                return res.status(400).json({ error: `格式不支持: ${ext}。 仅支持: .jpg, .png, .txt, .md, .zip` });
            }
        }

        let finalBuffer: Buffer;
        let finalFileName: string;
        let finalMimeType: string;

        // 打包逻辑：如果上传了多个文件，或者单个文件较大，则自动封装为 ZIP
        const isSingleZip = files.length === 1 && (files[0].mimetype === "application/zip" || files[0].originalname.endsWith(".zip"));

        if (isSingleZip) {
            if (files[0].size > MAX_ZIP_PAYLOAD_SIZE_MB * 1024 * 1024) {
                return res.status(400).json({ error: `ZIP 超出上限 ${MAX_ZIP_PAYLOAD_SIZE_MB}MB` });
            }
            finalBuffer = files[0].buffer;
            finalFileName = files[0].originalname;
            finalMimeType = "application/zip";
        } else {
            if (files.length === 1 && files[0].size < MAX_SINGLE_FILE_SIZE_MB * 1024 * 1024) { 
                finalBuffer = files[0].buffer;
                finalFileName = files[0].originalname;
                finalMimeType = files[0].mimetype;
            } else {
                // 多文件自动压缩
                const zip = new AdmZip();
                files.forEach(file => {
                    zip.addFile(file.originalname, file.buffer);
                });
                const zipBuffer = zip.toBuffer();

                if (zipBuffer.length > MAX_ZIP_PAYLOAD_SIZE_MB * 1024 * 1024) {
                    return res.status(400).json({ error: `自动压缩包超出上限 ${MAX_ZIP_PAYLOAD_SIZE_MB}MB` });
                }
                finalBuffer = zipBuffer;
                finalFileName = files.length === 1 ? `${files[0].originalname}.zip` : "文件包.zip";
                finalMimeType = "application/zip";
            }
        }

        // --- 在入库前进行物理加密 ---
        const encryptedBuffer = encrypt(finalBuffer);

        const id = uuidv4();
        const expiryDate = new Date();
        expiryDate.setHours(expiryDate.getHours() + durationHours);

        const fileRecord: any = {
            id,
            type: "private",
            fileName: finalFileName,
            mimeType: finalMimeType,
            fileSize: finalBuffer.length,
            pickupCode,
            expiryDate: expiryDate.toISOString(),
            maxDownloads,
            downloadCount: 0,
            createdAt: new Date().toISOString(),
            isLocalBinary: true // 标记这是一个物理文件
        };

        // 存储二进制文件到物理磁盘
        saveLocalFile(id, encryptedBuffer);

        local.files[id] = fileRecord;
        saveLocalDb(local);

        res.json({
            success: true,
            pickupCode,
            expiresAt: fileRecord.expiryDate
        });
    } catch (error: any) {
        console.error("[私密上传] 错误:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 提取文件路由
 * 通过 6 位码调取私密柜文件，解密后下发
 */
app.post("/api/extract", async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: "请输入提取码" });

        const now = new Date();
        const local = loadLocalDb();
        // 查找匹配且有效的记录
        const matches = Object.keys(local.files)
            .map(id => ({ ...local.files[id], id }))
            .filter(f => f.type === "private" && f.pickupCode === code)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        let record: any = null;
        for (const f of matches) {
            // 检查有效期和剩余次数
            if (new Date(f.expiryDate) > now && f.downloadCount < f.maxDownloads) {
                record = f;
                break;
            }
            // 如果不符合条件，顺手清理过期的资源以节省空间
            if (f.isLocalBinary) deleteLocalFile(f.id);
            delete local.files[f.id];
        }
        saveLocalDb(local);

        if (!record) return res.status(404).json({ error: "提取码无效或文件已销毁" });

        // 以字节流形式安全下发，提高移动端兼容性
        return res.json({ 
            success: true, 
            fileName: record.fileName, 
            isLocal: true,
            mimeType: record.mimeType,
            downloadUrl: `/api/download/${record.pickupCode}` // 提供直接下载路径
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 直接下载接口 (GET)
 * 解决移动端无法处理 Base64 下载的问题
 */
app.get("/api/download/:code", async (req, res) => {
    try {
        const { code } = req.params;
        const now = new Date();
        const local = loadLocalDb();
        
        const record = Object.values(local.files).find((f: any) => f.type === "private" && f.pickupCode === code) as any;
        
        if (!record || new Date(record.expiryDate) < now || record.downloadCount >= record.maxDownloads) {
             return res.status(404).send("文件已过期或不存在");
        }

        const buffer = getLocalFile(record.id);
        if (!buffer) return res.status(404).send("文件已丢失");
        
        const decrypted = decrypt(buffer);
        if (!decrypted) return res.status(500).send("解密失败");

        // 设置下载头，防止浏览器尝试预览（如图片或文本）
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(record.fileName)}"`);
        res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
        
        // 增加下载次数并销毁
        const finalLocal = loadLocalDb();
        if (finalLocal.files[record.id]) {
            finalLocal.files[record.id].downloadCount++;
            if (finalLocal.files[record.id].downloadCount >= record.maxDownloads) {
                if (record.isLocalBinary) deleteLocalFile(record.id);
                delete finalLocal.files[record.id];
            }
            saveLocalDb(finalLocal);
        }

        return res.send(decrypted);
    } catch (e) {
        res.status(500).send("下载失败");
    }
});

/**
 * 访问公开内容接口
 */
app.get("/api/view/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const local = loadLocalDb();
        const data = local.files[id] || null;

        if (!data) return res.status(404).json({ error: "内容不存在" });

        const expiry = new Date(data.expiryDate);
        if (new Date() > expiry) {
            const updatedLocal = loadLocalDb();
            delete updatedLocal.files[id];
            saveLocalDb(updatedLocal);
            return res.status(410).json({ error: "内容已过期" });
        }

        res.json({ content: data.content, fileName: data.fileName, createdAt: data.createdAt });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 批量上传辅助接口：用于演示或其他便捷脚本调用
 */
app.post("/api/batch-upload", upload.single("file"), async (req, res) => {
    if (!req.file || !req.file.originalname.endsWith(".txt")) {
        return res.status(400).send("Error: 仅允许 .txt 文件。\n");
    }

    try {
        let title = req.file!.originalname.trim();
        if (!title) title = "untitled.txt";
        
        const id = `pub_${title.toLowerCase().replace(/[^a-z0-9.]/gi, '_')}`;
        
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 3);

        const fileRecord: any = {
            id,
            type: "public",
            fileName: title,
            content: req.file!.buffer.toString("utf-8"),
            mimeType: "text/plain",
            expiryDate: expiryDate.toISOString(),
            createdAt: new Date().toISOString(),
            downloadCount: 0
        };

        const local = loadLocalDb();
        if (local.files[id]) {
            fileRecord.downloadCount = local.files[id].downloadCount;
        }
        local.files[id] = fileRecord;
        saveLocalDb(local);

        res.send(`上传成功。 访问链接: ${process.env.APP_URL || "http://localhost:3000"}/view/${id}\n`);
    } catch (err: any) {
        res.status(500).send(`Error: ${err.message}\n`);
    }
});

/**
 * 获取公开广场列表接口（最近 50 条）
 */
app.get("/api/files/public", async (req, res) => {
    try {
        const now = new Date().toISOString();
        const local = loadLocalDb();
        const files: any[] = Object.values(local.files).filter((f: any) => f.type === "public");

        const filtered = files
            .filter(f => f.expiryDate > now)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map(f => ({ id: f.id, fileName: f.fileName, createdAt: f.createdAt, expiryDate: f.expiryDate }));

        res.json(filtered.slice(0, 50));
    } catch (error: any) {
        res.json([]); 
    }
});

// --- Vite 中间件（集成开发与生产环境）---
async function startServer() {
    if (process.env.NODE_ENV !== "production") {
        // 开发环境下挂载 Vite
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        // 生产环境下直接托管静态资源
        const distPath = path.join(process.cwd(), "dist");
        app.use(express.static(distPath));
        app.get("*", (req, res) => {
            res.sendFile(path.join(distPath, "index.html"));
        });
    }

    app.listen(PORT, "0.0.0.0", async () => {
        console.log(`[File Express] 服务器运行于 http://0.0.0.0:${PORT}`);
        // 启动时自动清理过期文件
        try {
            await checkStorageLimit();
        } catch (e) {
            console.error("Startup storage cleanup failed:", e);
        }
    });
}

startServer();

