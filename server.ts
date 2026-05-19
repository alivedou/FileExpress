/**
 * File Express Backend
 * Author: adou
 */
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import AdmZip from "adm-zip";
import cors from "cors";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import crypto from "crypto";

// --- ENV Configuration ---
const APP_NAME = process.env.APP_NAME || "File Express";
const APP_SUBTITLE = process.env.APP_SUBTITLE || "极简、安全、临时的文件传输中心";
const MAX_SINGLE_FILE_SIZE_MB = parseInt(process.env.MAX_SINGLE_FILE_SIZE_MB || "10");
const MAX_ZIP_PAYLOAD_SIZE_MB = parseInt(process.env.MAX_ZIP_PAYLOAD_SIZE_MB || "50");
const MAX_TOTAL_STORAGE_MB = parseInt(process.env.MAX_TOTAL_STORAGE_MB || "1024"); // 1GB default limit
const ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY || "8664183d-3b8f-431f-9988-6622b72f104d"; 

// --- Encryption Helpers ---
function encrypt(buffer: Buffer): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: [iv (12)] [authTag (16)] [encryptedPayload]
    return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(buffer: Buffer): Buffer | null {
    try {
        const iv = buffer.slice(0, 12);
        const authTag = buffer.slice(12, 28);
        const encrypted = buffer.slice(28);
        const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (e) {
        console.error("Decryption failed:", e);
        return null;
    }
}

// Load Firebase Config
const firebaseConfig = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));

// CRITICAL Force the project ID in the environment to ensure all Google Cloud SDKs use the correct project
if (firebaseConfig.projectId) {
    process.env.GOOGLE_CLOUD_PROJECT = firebaseConfig.projectId;
}

// --- Storage Fallback Logic ---
const LOCAL_DB_PATH = path.join(process.cwd(), "local_db.json");
const LOCAL_STORAGE_DIR = path.join(process.cwd(), "local_storage");

if (!fs.existsSync(LOCAL_STORAGE_DIR)) {
    fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
}

function loadLocalDb() {
    if (fs.existsSync(LOCAL_DB_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(LOCAL_DB_PATH, "utf-8"));
        } catch { return { files: {} }; }
    }
    return { files: {} };
}
function saveLocalDb(data: any) { fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2)); }

function saveLocalFile(id: string, buffer: Buffer): string {
    const filePath = path.join(LOCAL_STORAGE_DIR, id);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

function getLocalFile(id: string): Buffer | null {
    const filePath = path.join(LOCAL_STORAGE_DIR, id);
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath);
    }
    return null;
}

function deleteLocalFile(id: string) {
    const filePath = path.join(LOCAL_STORAGE_DIR, id);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

let useFallback = false;

// Initialize Firebase Admin
let adminApp: admin.app.App;
try {
    if (admin.apps.length > 0) {
        adminApp = admin.apps[0]!;
    } else {
        adminApp = admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            projectId: firebaseConfig.projectId,
            storageBucket: firebaseConfig.storageBucket
        });
    }
} catch (e: any) {
    console.warn("[Firebase] Init failed, using local fallback:", e.message);
    useFallback = true;
}

let db: admin.firestore.Firestore;
const dbId = firebaseConfig.firestoreDatabaseId;
try {
    db = (dbId && dbId !== "(default)") ? getFirestore(adminApp!, dbId) : getFirestore(adminApp!);
} catch (e: any) {
    console.warn("[Firestore] DB access failed, forcing local fallback.");
    useFallback = true;
}

const storage = !useFallback ? admin.storage().bucket(firebaseConfig.storageBucket) : null;

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const upload = multer({ storage: multer.memoryStorage() });

// API routes go here FIRST
app.get("/api/health", (req, res) => {
    res.json({ 
        status: "ok", 
        mode: useFallback ? "local" : "cloud",
        timestamp: new Date().toISOString() 
    });
});

// --- Database Helper ---
async function dbOperation<T>(operation: (currentDb: admin.firestore.Firestore) => Promise<T>, localOp: () => T): Promise<T> {
    if (useFallback) return localOp();
    try {
        return await operation(db);
    } catch (error: any) {
        if (error.code === 7 || error.code === 5 || error.message?.includes("PERMISSION_DENIED") || error.message?.includes("NOT_FOUND")) {
            console.error(`[Firebase] Service unavailable (Code ${error.code}). Using Local storage.`);
            useFallback = true;
            return localOp();
        }
        throw error;
    }
}

// --- Storage Service Pattern ---
interface StorageProvider {
    saveFile(id: string, fileName: string, buffer: Buffer): Promise<string>;
    deleteFile(path: string): Promise<void>;
    getFile(path: string): Promise<Buffer>;
}

// Global Storage Usage Check (Circuit Breaker)
async function checkStorageLimit(): Promise<boolean> {
    const local = loadLocalDb();
    let totalSize = 0;
    Object.values(local.files).forEach((f: any) => {
        if (f.fileSize) totalSize += f.fileSize;
        else if (f.content) totalSize += Buffer.from(f.content).length;
    });

    // Add physical storage folder check if local mode
    if (fs.existsSync(LOCAL_STORAGE_DIR)) {
        const files = fs.readdirSync(LOCAL_STORAGE_DIR);
        files.forEach(file => {
            totalSize += fs.statSync(path.join(LOCAL_STORAGE_DIR, file)).size;
        });
    }

    const usageMb = totalSize / (1024 * 1024);
    
    if (usageMb > MAX_TOTAL_STORAGE_MB * 0.9) {
        console.warn(`[Storage] Usage ${usageMb.toFixed(2)}MB approaching limit ${MAX_TOTAL_STORAGE_MB}MB. Triggering cleanup.`);
        const now = new Date();
        let cleaned = 0;
        Object.keys(local.files).forEach(id => {
            if (new Date(local.files[id].expiryDate) < now) {
                if (local.files[id].isLocalBinary) deleteLocalFile(id);
                delete local.files[id];
                cleaned++;
            }
        });
        if (cleaned > 0) saveLocalDb(local);
    }

    return usageMb < MAX_TOTAL_STORAGE_MB;
}

// --- API Routes ---

app.get("/api/config", (req, res) => {
    res.json({
        appName: APP_NAME,
        appSubtitle: APP_SUBTITLE
    });
});

// Public Upload (Only .txt)
app.post("/api/upload/public", upload.single("file"), async (req, res) => {
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
                return res.status(400).json({ error: "Only .txt files are allowed in public mode" });
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
            return res.status(400).json({ error: "Content cannot be empty" });
        }

        // Use filename (lowercase sanitized) + tiny hash to avoid massive collisions while keeping it readable
        const shortHash = Math.random().toString(36).substring(2, 6);
        const id = `pub_${fileName.toLowerCase().replace(/[^a-z0-9.]/gi, '_')}_${shortHash}`;
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 3);

        const fileRecord = {
            id,
            type: "public",
            fileName,
            content,
            mimeType: "text/plain",
            expiryDate: expiryDate.toISOString(),
            createdAt: new Date().toISOString(),
            downloadCount: 0
        };

        await dbOperation<any>(
            (currentDb) => currentDb.collection("files").doc(id).set(fileRecord),
            () => {
                const local = loadLocalDb();
                local.files[id] = fileRecord;
                saveLocalDb(local);
                return true;
            }
        );

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

// Private Upload
app.post("/api/upload/private", upload.array("files"), async (req, res) => {
    try {
        if (!(await checkStorageLimit())) {
            return res.status(507).json({ error: "STORAGE_QUOTA_EXCEEDED" });
        }
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        // Generate unique 6-digit pickup code
        let pickupCode = "";
        let isUnique = false;
        let attempts = 0;
        while (!isUnique && attempts < 10) {
            pickupCode = Math.floor(100000 + Math.random() * 900000).toString();
            const existing = await dbOperation(
                async (currentDb) => {
                    const snap = await currentDb.collection("files")
                        .where("type", "==", "private")
                        .where("pickupCode", "==", pickupCode)
                        .get();
                    return snap.empty ? null : snap.docs[0].data();
                },
                () => {
                    const local = loadLocalDb();
                    return Object.values(local.files).find((f: any) => f.type === "private" && f.pickupCode === pickupCode);
                }
            );
            if (!existing) isUnique = true;
            else attempts++;
        }

        const durationHours = parseInt(req.body.duration) || 24;
        const maxDownloads = 5;

        // Check file types
        const allowedExtensions = [".jpg", ".jpeg", ".png", ".txt", ".md", ".zip"];
        for (const file of files) {
            const ext = path.extname(file.originalname).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                return res.status(400).json({ error: `File type not allowed: ${ext}. Allowed: .jpg, .png, .txt, .md, .zip` });
            }
        }

        let finalBuffer: Buffer;
        let finalFileName: string;
        let finalMimeType: string;

        // Determine if we need to zip
        // Logic: if multiple files, or if single file > 5MB and not zip
        const isSingleZip = files.length === 1 && (files[0].mimetype === "application/zip" || files[0].originalname.endsWith(".zip"));

        if (isSingleZip) {
            if (files[0].size > MAX_ZIP_PAYLOAD_SIZE_MB * 1024 * 1024) {
                return res.status(400).json({ error: `Zip file exceeds ${MAX_ZIP_PAYLOAD_SIZE_MB}MB limit` });
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
                // Zip multiple files or large single file
                const zip = new AdmZip();
                files.forEach(file => {
                    zip.addFile(file.originalname, file.buffer);
                });
                const zipBuffer = zip.toBuffer();

                if (zipBuffer.length > MAX_ZIP_PAYLOAD_SIZE_MB * 1024 * 1024) {
                    return res.status(400).json({ error: `Compressed payload exceeds ${MAX_ZIP_PAYLOAD_SIZE_MB}MB limit` });
                }
                finalBuffer = zipBuffer;
                finalFileName = files.length === 1 ? `${files[0].originalname}.zip` : "package.zip";
                finalMimeType = "application/zip";
            }
        }

        // --- ENCRYPT DATA BEFORE STORAGE ---
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
            createdAt: new Date().toISOString()
        };

        if (!useFallback && storage) {
            const storagePath = `private/${id}_${finalFileName}`;
            const fileUpload = storage.file(storagePath);
            await fileUpload.save(encryptedBuffer, { 
                contentType: "application/octet-stream", 
                resumable: false 
            });
            fileRecord.storagePath = storagePath;
        } else {
            // Optimization: Store locally in file system instead of bloating JSON with base64
            saveLocalFile(id, encryptedBuffer);
            fileRecord.isLocalBinary = true;
        }

        await dbOperation<any>(
            (currentDb) => currentDb.collection("files").doc(id).set(fileRecord),
            () => {
                const local = loadLocalDb();
                local.files[id] = fileRecord;
                saveLocalDb(local);
                return true;
            }
        );

        res.json({
            success: true,
            pickupCode,
            expiresAt: fileRecord.expiryDate
        });
    } catch (error: any) {
        console.error("[Upload] Private failed:", error);
        res.status(500).json({ error: error.message });
    }
});

// Extract File
app.post("/api/extract", async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: "Code required" });

        const now = new Date();
        const record: any = await dbOperation(
            async (currentDb) => {
                const snapshot = await currentDb.collection("files")
                    .where("type", "==", "private")
                    .where("pickupCode", "==", code)
                    .orderBy("createdAt", "desc")
                    .get();
                if (snapshot.empty) return null;
                // Find first non-expired
                for (const doc of snapshot.docs) {
                    const d = doc.data();
                    if (new Date(d.expiryDate) > now && d.downloadCount < d.maxDownloads) {
                        return { ...d, _ref: doc.ref };
                    }
                    // Clean up expired ones we found along the way
                    await doc.ref.delete().catch(() => {});
                }
                return null;
            },
            () => {
                const local = loadLocalDb();
                const matches = Object.keys(local.files)
                    .map(id => ({ ...local.files[id], id }))
                    .filter(f => f.type === "private" && f.pickupCode === code)
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                
                for (const f of matches) {
                    if (new Date(f.expiryDate) > now && f.downloadCount < f.maxDownloads) {
                        return f;
                    }
                    delete local.files[f.id];
                }
                saveLocalDb(local);
                return null;
            }
        );

        if (!record) return res.status(404).json({ error: "ENTRY_NOT_FOUND" });

        const expiry = new Date(record.expiryDate);
        if (new Date() > expiry || record.downloadCount >= record.maxDownloads) {
            if (!useFallback && record._ref) {
                await record._ref.delete();
                if (record.storagePath && storage) await storage.file(record.storagePath).delete().catch(() => {});
            } else {
                const local = loadLocalDb();
                if (record.isLocalBinary) deleteLocalFile(record.id);
                delete local.files[record.id];
                saveLocalDb(local);
            }
            return res.status(410).json({ error: "FILE_EXPIRED_OR_REMOVED" });
        }

        // Increment count
        if (!useFallback && record._ref) {
            await record._ref.update({ downloadCount: admin.firestore.FieldValue.increment(1) });
        } else {
            const local = loadLocalDb();
            local.files[record.id].downloadCount++;
            saveLocalDb(local);
        }

        if (!useFallback && record.storagePath && storage) {
            const [buffer] = await storage.file(record.storagePath).download();
            const decrypted = decrypt(buffer);
            if (!decrypted) return res.status(500).json({ error: "DECRYPTION_FAILED" });
            return res.json({ 
                success: true, 
                fileName: record.fileName, 
                isLocal: true,
                data: decrypted.toString("base64"),
                mimeType: record.mimeType 
            });
        } else {
            const buffer = getLocalFile(record.id);
            if (!buffer) return res.status(404).json({ error: "FILE_NOT_FOUND_ON_DISK" });
            const decrypted = decrypt(buffer);
            if (!decrypted) return res.status(500).json({ error: "DECRYPTION_FAILED" });
            return res.json({ 
                success: true, 
                fileName: record.fileName, 
                isLocal: true,
                data: decrypted.toString("base64"),
                mimeType: record.mimeType 
            });
        }
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// View Public Content
app.get("/api/view/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const data: any = await dbOperation(
            async (currentDb) => {
                const doc = await currentDb.collection("files").doc(id).get();
                return doc.exists ? { ...doc.data(), _ref: doc.ref } : null;
            },
            () => {
                const local = loadLocalDb();
                return local.files[id] || null;
            }
        );

        if (!data) return res.status(404).json({ error: "NOT_FOUND" });

        const expiry = new Date(data.expiryDate);
        if (new Date() > expiry) {
            if (!useFallback && data._ref) await data._ref.delete();
            else {
                const local = loadLocalDb();
                delete local.files[id];
                saveLocalDb(local);
            }
            return res.status(410).json({ error: "EXPIRED" });
        }

        res.json({ content: data.content, fileName: data.fileName, createdAt: data.createdAt });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Batch Upload
app.post("/api/batch-upload", upload.single("file"), async (req, res) => {
    if (!req.file || !req.file.originalname.endsWith(".txt")) {
        return res.status(400).send("Error: Only .txt files allowed.\n");
    }

    try {
        const title = req.file!.originalname.trim();
        const id = `pub_${title.toLowerCase().replace(/[^a-z0-9.]/gi, '_')}`;
        
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 3);

        const fileRecord = {
            id,
            type: "public",
            fileName: title,
            content: req.file!.buffer.toString("utf-8"),
            mimeType: "text/plain",
            expiryDate: expiryDate.toISOString(),
            createdAt: new Date().toISOString(),
            downloadCount: 0
        };

        await dbOperation<any>(
            (currentDb) => currentDb.collection("files").doc(id).set(fileRecord),
            () => {
                const local = loadLocalDb();
                local.files[id] = fileRecord;
                saveLocalDb(local);
                return true;
            }
        );

        res.send(`Successfully uploaded. Public access URL: ${process.env.APP_URL || "http://localhost:3000"}/view/${id}\n`);
    } catch (err: any) {
        res.status(500).send(`Error: ${err.message}\n`);
    }
});

// GET Public Files List
app.get("/api/files/public", async (req, res) => {
    try {
        const now = new Date().toISOString();
        const files: any[] = await dbOperation(
            async (currentDb) => {
                const snapshot = await currentDb.collection("files")
                    .where("type", "==", "public")
                    .limit(50)
                    .get();
                return snapshot.docs.map(doc => doc.data());
            },
            () => {
                const local = loadLocalDb();
                return Object.values(local.files).filter((f: any) => f.type === "public");
            }
        );

        const filtered = files
            .filter(f => f.expiryDate > now)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map(f => ({ id: f.id, fileName: f.fileName, createdAt: f.createdAt, expiryDate: f.expiryDate }));

        res.json(filtered.slice(0, 50));
    } catch (error: any) {
        res.json([]); 
    }
});

// --- Vite Middleware ---
async function startServer() {
    if (process.env.NODE_ENV !== "production") {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), "dist");
        app.use(express.static(distPath));
        app.get("*", (req, res) => {
            res.sendFile(path.join(distPath, "index.html"));
        });
    }

    // Start listening
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running at http://0.0.0.0:${PORT}`);
        if (useFallback) console.warn("!!! RUNNING IN LOCAL STORAGE FALLBACK MODE !!!");
    });
}

startServer();

