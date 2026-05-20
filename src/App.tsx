/**
 * 文件快递柜 前端入口
 * 作者: adou
 * 技术栈：React 18 + Tailwind CSS + Framer Motion (动画) + Lucide React (图标)
 */
import React, { useState, useEffect, useMemo, useRef } from "react";
import { BrowserRouter, Routes, Route, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Upload, Download, FileText, Lock, Shield, Clock, Hash, CheckCircle2, 
  ChevronRight, AlertCircle, FileUp, ArrowLeft, Sun, Moon, Languages, Info, X,
  Copy, ExternalLink, QrCode
} from "lucide-react";
import QRCode from "qrcode";

// --- 多语言翻译数据 ---
const translations = {
  zh: {
    title: "文件快递柜",
    subtitle: "极简、安全、临时的文件传送枢纽",
    deposit: "存放",
    extract: "提取",
    public: "公开分享",
    private: "私密柜",
    publicLabel: "内容 (.txt 文字分享)",
    privateLabel: "选择文件",
    zipHint: "压缩包 < 50MB, 其他 < 5MB",
    typeHint: "允许类型: .jpg, .png, .txt, .md, .zip",
    dragHint: "拖拽文件至此或点击上传",
    durationLabel: "保存时长",
    engage: "确认存入",
    processing: "正在处理...",
    success: "存入成功",
    expiresIn: "到期时间",
    pickupCode: "提取码",
    copyCode: "复制验证码",
    copyLink: "直达链接",
    copied: "已复制",
    accessUrl: "公开链接",
    qrCode: "二维码",
    newDeposit: "再次存入",
    pickCodePlaceholder: "请输入六位提取码",
    verify: "验证提取码",
    notice: "使用说明",
    noticeFull: "【 使用说明 】\n1. 压缩包 (.zip) 限制以系统设置为准。\n2. 所有私密文件均通过 AES-256 加密存储，保障数据隐私。\n3. 私密文件提取 5 次或到达设定时间后立即销毁。\n4. 公开文本保存 3 天。\n\n项目作者: adou",
    systemReady: "系统就绪",
    return: "返回主页",
    fail: "获取失败",
    expired: "文件已销毁或不存在",
    square: "公开广场",
    emptySquare: "暂无公开文件",
    timeLeft: "剩余",
    titlePlaceholder: "文件名称（可选）",
    switchToPickup: "提取文件",
    switchToUpload: "存放文件",
    attachTxt: "点击添加 .txt 文件",
    remove: "移除",
    readyFiles: "个文件已就绪",
    uploadLimit: "文件体积限制",
    decrypting: "正在解密数据...",
    encryptedStatus: "数据已进行 AES-256 加密存储",
    decryptionError: "数据解密失败，加密密钥不正确或已更改"
  },
  en: {
    // ... 英文翻译保持不变 ...
    title: "File Express",
    subtitle: "Simple, Secure, Temporary File Storage",
    deposit: "Deposit",
    extract: "Extract",
    public: "Public",
    private: "Private",
    publicLabel: "Paste text content here",
    privateLabel: "Select Files",
    zipHint: "Size limits depend on server config",
    typeHint: "Allowed: .jpg, .png, .txt, .md, .zip",
    dragHint: "Drag files here or click to upload",
    durationLabel: "Storage Duration",
    engage: "Confirm & Drop",
    processing: "Processing...",
    success: "Success",
    expiresIn: "Expires at",
    pickupCode: "Pickup Code",
    copyCode: "Copy Code",
    copyLink: "Direct Link",
    copied: "Copied",
    accessUrl: "Public Link",
    qrCode: "QR Code",
    newDeposit: "New Deposit",
    pickCodePlaceholder: "Enter 6-digit code",
    verify: "Verify & Download",
    notice: "Guide",
    noticeFull: "【 USAGE GUIDE 】\n1. Strictly follow size limits.\n2. All files are AES-256 encrypted server-side.\n3. Private files are destroyed after 5 downloads or expiration.\n4. Public texts are kept for 3 days.\n\nAuthor: adou",
    systemReady: "Ready",
    return: "Home",
    fail: "Failed",
    expired: "File expired or destroyed",
    square: "Public Square",
    emptySquare: "No documents",
    timeLeft: "Remains",
    titlePlaceholder: "Title (Optional)",
    switchToPickup: "Switch to Extract",
    switchToUpload: "Switch to Deposit",
    attachTxt: "Click to add .txt file",
    remove: "Remove",
    readyFiles: "file(s) ready",
    uploadLimit: "Volume Limits",
    decrypting: "Decrypting payload...",
    encryptedStatus: "AES-256 Encrypted",
    decryptionError: "Decryption failed. Key is incorrect or has been changed."
  }
};

type Language = "zh" | "en";
type StorageType = "public" | "private";

export default function App() {
  // 全局语言状态
  const [lang, setLang] = useState<Language>("zh");
  // 深色模式状态
  const [isDark, setIsDark] = useState(false);
  // 从后端获取的应用标题等动态配置
  const [config, setConfig] = useState<any>(null);

  // 主题切换辅助逻辑
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // 初始化获取应用名称和副标题
  useEffect(() => {
    fetch("/api/config")
      .then(res => res.json())
      .then(data => {
        setConfig(data);
        if (data.appName) {
          document.title = data.appName;
        }
      })
      .catch(err => console.error("Config fetch failed:", err));
  }, []);

  const t = translations[lang];

  return (
    <BrowserRouter>
      <div className="min-h-screen transition-colors duration-500 overflow-x-hidden">
        {/* 全局导航栏 */}
        <nav className="fixed top-0 w-full px-4 sm:px-6 py-3 sm:py-4 flex justify-between items-center z-50 bg-[var(--bg-primary)]/80 backdrop-blur-md border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2 sm:gap-3 group cursor-default">
            <div className="relative w-2 h-2 sm:w-2.5 sm:h-2.5">
              <div className="absolute inset-0 rounded-full bg-[var(--accent)] animate-pulse opacity-20" />
              <div className="absolute inset-0 rounded-full bg-[var(--accent)] shadow-sm" />
            </div>
            <span className="text-[11px] sm:text-[13px] font-bold tracking-tight text-[var(--text-secondary)]">
              {t.systemReady}
            </span>
          </div>
          
          <div className="flex items-center gap-3">
            {/* 语言切换按钮 */}
            <button 
              onClick={() => setLang(lang === "zh" ? "en" : "zh")}
              className="px-2 py-1 border border-[var(--border-color)] hover:border-[var(--accent)] hover:text-[var(--accent)] rounded transition-all text-[11px] font-bold"
            >
              {lang === 'zh' ? 'English' : '中文'}
            </button>
            {/* 主题切换按钮 */}
            <button 
              onClick={() => setIsDark(!isDark)}
              className="p-2 border border-[var(--border-color)] hover:border-[var(--accent)] rounded transition-all"
              title="Theme Toggle"
            >
              {isDark ? <Sun size={15} className="text-[var(--accent)]" /> : <Moon size={15} />}
            </button>
          </div>
        </nav>

        <div className="pt-20 sm:pt-24 pb-12">
          <Routes>
            <Route path="/" element={<MainLayout t={t} lang={lang} config={config} />} />
            <Route path="/view/:id" element={<ViewPage t={t} />} />
          </Routes>
        </div>
        
        {/* 装饰性页脚信心 */}
        <div className="fixed bottom-4 left-6 text-[10px] font-medium text-[var(--text-secondary)] opacity-40 pointer-events-none hidden md:block">
          STATUS: ONLINE // AUTHOR: adou
        </div>
        <div className="fixed bottom-4 right-6 text-[10px] font-medium text-[var(--text-secondary)] opacity-40 pointer-events-none hidden md:block">
          &copy; 2026 {config?.appName || "FILE_EXPRESS"} | By adou
        </div>
      </div>
    </BrowserRouter>
  );
}

// --- 通用组件 ---

/**
 * 分段控件组件：用于 存放/提取、公开/私密 的模式切换
 */
function SegmentedControl<T extends string>({ 
  options, 
  value, 
  onChange,
  className = ""
}: { 
  options: { label: string, value: T }[], 
  value: T, 
  onChange: (v: T) => void,
  className?: string
}) {
  return (
    <div className={`relative flex p-1 bg-black/5 dark:bg-white/5 border border-[var(--border-color)] rounded-lg ${className}`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`relative flex-1 py-1.5 text-[12px] font-bold tracking-tight transition-all z-10 ${
            value === opt.value ? "text-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          {opt.label}
          {value === opt.value && (
            <motion.div
              layoutId="segmented-highlight"
              className="absolute inset-0 bg-[var(--bg-primary)] border border-[var(--accent)]/30 shadow-sm rounded-md -z-10"
              transition={{ type: "spring", bounce: 0.1, duration: 0.3 }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * 首页主布局：包含控制台和公开广场
 */
function MainLayout({ t, lang, config }: { t: any, lang: Language, config: any }) {
  const [mode, setMode] = useState<"upload" | "pickup">("upload");
  const [storageType, setStorageType] = useState<StorageType>("public");
  const [showNotice, setShowNotice] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchParams] = useSearchParams();

  // 监听 URL 参数。如果有 ?pickup=123456，自动进入提取模式
  useEffect(() => {
    if (searchParams.get('pickup')) {
      setMode('pickup');
    }
  }, [searchParams]);

  // 上传成功后刷新公开广场
  const onUploadSuccess = () => {
    setRefreshKey(prev => prev + 1);
  };

  return (
    <main className="px-4 flex flex-col items-center max-w-4xl mx-auto w-full">
      {/* 标题部分 */}
      <motion.div 
        initial={{ opacity: 0, y: 10 }} 
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-6 sm:mb-8 w-full"
      >
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-2">
          {config?.appName || t.title}
        </h1>
        <div className="flex items-center justify-center gap-2 sm:gap-4 opacity-70">
          <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent to-[var(--border-color)]" />
          <p className="text-[11px] sm:text-[13px] font-medium text-[var(--text-secondary)] uppercase tracking-wider whitespace-nowrap">
            {config?.appSubtitle || t.subtitle}
          </p>
          <div className="h-[1px] flex-1 bg-gradient-to-l from-transparent to-[var(--border-color)]" />
        </div>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full">
        {/* 左侧：控制中心（存/取） */}
        <section className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5 sm:gap-2">
               <Shield size={16} className="text-[var(--accent)]" />
               <span className="text-[12px] font-bold text-[var(--text-secondary)]">{t.deposit} / {t.extract}</span>
            </div>
          </div>

          <div className="card-minimal p-4 sm:p-6 space-y-4 sm:space-y-6">
            <SegmentedControl 
              options={[
                { label: t.deposit, value: "upload" },
                { label: t.extract, value: "pickup" }
              ]}
              value={mode}
              onChange={(v) => setMode(v as any)}
            />

            <AnimatePresence mode="wait">
              {mode === "upload" ? (
                <motion.div 
                  key="upload-container" 
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="space-y-6"
                >
                  <SegmentedControl 
                    options={[
                      { label: t.public, value: "public" },
                      { label: t.private, value: "private" }
                    ]}
                    value={storageType}
                    onChange={(v) => setStorageType(v as any)}
                    className="border-none !p-0"
                  />
                  
                  <UploadForm t={t} type={storageType} setType={setStorageType} onSuccess={onUploadSuccess} config={config} />
                </motion.div>
              ) : (
                <motion.div key="pickup-container" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <PickupForm t={t} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* 右侧：公开广场 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between px-1">
             <div className="flex items-center gap-2">
              <Hash size={14} className="text-[var(--accent)]" />
              <span className="text-[12px] font-bold text-[var(--text-secondary)]">{t.square}</span>
             </div>
             <button 
               onClick={() => setRefreshKey(prev => prev + 1)}
               className="text-[11px] font-medium text-[var(--accent)] hover:underline opacity-70 hover:opacity-100 transition-all"
             >
               {lang === 'zh' ? '刷新' : 'Refresh'}
             </button>
          </div>
          <div className="h-[500px] overflow-y-auto pr-1 space-y-2">
            <PublicSquare t={t} refreshKey={refreshKey} />
          </div>
        </section>
      </div>

      {/* 底部辅助连接 */}
      <div className="mt-8 sm:mt-12 flex items-center gap-4 sm:gap-6">
        <button 
          onClick={() => setShowNotice(true)}
          className="group flex items-center gap-2 text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--accent)] transition-all"
        >
          <Info size={14} /> 
          <span className="border-b border-transparent group-hover:border-[var(--accent)] pb-0.5">{t.notice}</span>
        </button>
        <div className="h-4 w-[1px] bg-[var(--border-color)]" />
        <div className="text-[11px] text-[var(--text-secondary)] opacity-40 italic">{t.encryptedStatus}</div>
      </div>

      {/* 使用说明弹窗 */}
      <AnimatePresence>
        {showNotice && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 backdrop-blur-md z-[100] flex items-center justify-center p-6"
            onClick={() => setShowNotice(false)}
          >
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
              className="card-minimal max-w-md w-full p-8 border-t-4 border-t-[var(--accent)]"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex justify-between items-center mb-8 border-b border-[var(--border-color)] pb-4">
                <h3 className="text-xl font-black italic tracking-widest uppercase terminal-text">{t.notice}</h3>
                <X size={20} className="cursor-pointer opacity-40 hover:opacity-100 hover:text-[var(--accent)]" onClick={() => setShowNotice(false)} />
              </div>
              <div className="text-[11px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap font-mono uppercase tracking-tight">
                {t.noticeFull}
              </div>
              <div className="mt-8 pt-4 border-t border-[var(--border-color)] text-[8px] opacity-20 text-right">
                END_OF_TRANSMISSION // VERSION_2.0
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

/**
 * 公开列表展示组件
 */
function PublicSquare({ t, refreshKey }: { t: any, refreshKey: number }) {
  const [files, setFiles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    fetch("/api/files/public")
      .then(res => res.json())
      .then(data => {
        setFiles(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => {
        setFiles([]);
        setLoading(false);
      });
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1,2,3].map(i => (
          <div key={i} className="card-minimal h-20 animate-pulse bg-[var(--border-color)]/20" />
        ))}
      </div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      className="space-y-3"
    >
      {files.length === 0 ? (
        <div className="card-minimal py-20 text-center opacity-20 italic text-[10px] uppercase font-black border-dashed">
          &lt; NO_PUBLIC_RECORDS_FOUND &gt;
        </div>
      ) : (
        files.map(file => (
          <motion.div 
            key={file.id} 
            whileHover={{ y: -2, shadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)" }}
            onClick={() => navigate(`/view/${file.id}`)}
            className="card-minimal p-4 flex items-center justify-between cursor-pointer group hover:border-[var(--accent)] transition-all"
          >
            <div className="flex items-center gap-3 overflow-hidden">
               <div className="p-2 bg-[var(--accent)]/5 rounded-lg transition-colors">
                <FileText size={18} className="text-[var(--accent)]" />
               </div>
               <div className="overflow-hidden">
                <p className="text-sm font-semibold truncate max-w-[150px]">{file.fileName}</p>
                <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)] opacity-60">
                  <Clock size={10} />
                  <span>{t.timeLeft}: {Math.floor((new Date(file.expiryDate).getTime() - Date.now()) / 3600000)}h</span>
                </div>
               </div>
            </div>
            <ChevronRight size={16} className="text-[var(--border-color)] group-hover:text-[var(--accent)] transition-all" />
          </motion.div>
        ))
      )}
    </motion.div>
  );
}

/**
 * 文件存放表单逻辑
 */
function UploadForm({ t, type, setType, onSuccess, config }: { t: any, type: StorageType, setType: (v: StorageType) => void, onSuccess: () => void, config: any }) {
  const [files, setFiles] = useState<File[]>([]); // 物理文件数组
  const [title, setTitle] = useState(""); // 公开分享标题
  const [content, setContent] = useState(""); // 公开分享文本内容
  const [duration, setDuration] = useState("24"); // 保存时长
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>(null); // 上传成功结果存储（包含 ID 或 提取码）
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string>(""); // 生成的二维码图片数据
  const [showQr, setShowQr] = useState(false);

  const maxSingle = config?.maxSingleFileMB || "5";
  const maxZip = config?.maxZipPayloadMB || "50";

  // 成功后生成二维码：如果是公开内容生成链接码，私密内容生成包含提取参数的链接
  useEffect(() => {
    if (result) {
      const url = type === 'public' 
        ? `${window.location.origin}${result.url}`
        : `${window.location.origin}/?pickup=${result.pickupCode}`;
      
      QRCode.toDataURL(url, { margin: 2, width: 256, color: { dark: '#06b6d4', light: '#ffffff00' } })
        .then(data => setQrCodeUrl(data))
        .catch(err => console.error(err));
    }
  }, [result, type]);

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopyStatus(label);
    setTimeout(() => setCopyStatus(null), 2000);
  };

  // 核心上传处理逻辑
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const fd = new FormData();
      if (type === 'public') {
        // 公开分享：支持文本粘贴或选择单个文本文件
        if (files.length > 0) {
          if (files[0].size > 2 * 1024 * 1024) {
            setError("公开文本文件不能超过 2MB");
            setLoading(false);
            return;
          }
          fd.append('file', files[0]);
        } else {
          fd.append('title', title);
          fd.append('content', content);
        }
      } else {
        // 私密柜：支持多文件并行上传
        let totalSize = 0;
        files.forEach(f => {
          totalSize += f.size;
          fd.append('files', f);
        });

        const limitBytes = (parseInt(maxZip) || 50) * 1024 * 1024;
        if (totalSize > limitBytes) {
           setError(`总文件体积 (${(totalSize / 1024 / 1024).toFixed(1)}MB) 超出限制 ${maxZip}MB`);
           setLoading(false);
           return;
        }

        fd.append('duration', duration);
      }
      const res = await fetch(`/api/upload/${type}`, { method: 'POST', body: fd });
      const data = await res.json();
      if (data.success) {
        setResult(data);
        setShowQr(true); // 默认展示二维码，方便扫码
        onSuccess();
      }
      else {
        // 针对不同错误码给出友好提示
        if (data.error === "STORAGE_QUOTA_EXCEEDED") {
          setError("服务器空间已满，请稍后再试或联系管理员");
        } else {
          setError(data.error || "上传失败");
        }
      }
    } catch (err) {
      setError("网络连接错误，请检查网络后重试");
    } finally {
      setLoading(false);
    }
  };

  // 成功后的信息展示页
  if (result) {
    return (
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        className="space-y-4 max-h-[85vh] overflow-y-auto px-2 py-4 scrollbar-hide"
      >
        {/* 并排展示的头部：成功信息与二维码 */}
        <div className="flex items-center justify-between gap-4 bg-green-500/5 border border-green-500/20 p-4 sm:p-5 rounded-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-green-500/10 rounded-bl-full -z-10 blur-2xl"></div>
          
          <div className="flex-1 text-left">
            <div className="flex items-center gap-2 sm:gap-3 mb-1.5 sm:mb-2">
               <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-green-500/20 flex flex-shrink-0 items-center justify-center text-green-600">
                 <CheckCircle2 size={18} className="sm:w-5 sm:h-5" />
               </div>
               <h4 className="text-[12px] sm:text-[14px] font-black uppercase tracking-[0.1em] italic text-green-600 dark:text-green-500">
                 {t.success}
               </h4>
            </div>
            <div className="text-[9px] sm:text-[10px] text-[var(--text-secondary)] font-bold opacity-60 font-mono ml-[40px] sm:ml-[52px]">
               EXP: {new Date(result.expiresAt).toLocaleString()}
            </div>
          </div>
          
          {qrCodeUrl ? (
            <div className="bg-white p-1.5 sm:p-2 rounded-xl shadow-sm shrink-0 border border-black/5 transform rotate-2 hover:rotate-0 hover:scale-105 transition-all cursor-pointer">
              <img src={qrCodeUrl} alt="QR Code" className="w-16 h-16 sm:w-20 sm:h-20" />
            </div>
          ) : null}
        </div>
        
        {type === 'public' ? (
          <div className="space-y-4">
            {/* 公开链接展示 */}
            <div className="card-minimal p-4 border-[var(--border-color)] bg-[var(--bg-primary)]">
               <p className="text-[11px] font-bold mb-2 text-left text-[var(--text-secondary)] opacity-60 uppercase">{t.accessUrl}</p>
               <div 
                 onClick={() => window.open(result.url, '_blank')}
                 className="group flex flex-col sm:flex-row items-center justify-between p-3 border border-[var(--border-color)] bg-[var(--bg-secondary)] rounded-lg cursor-pointer hover:border-[var(--accent)] transition-all gap-2"
               >
                 <span className="text-[12px] font-medium truncate w-full sm:w-auto text-[var(--accent)] underline">{window.location.origin}{result.url}</span>
                 <ExternalLink size={14} className="opacity-40 group-hover:opacity-100 transition-opacity hidden sm:block text-[var(--accent)]" />
               </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 提取码展示 */}
            <div className="card-minimal p-4 sm:p-5 border-[var(--accent)]/30 bg-[var(--accent)]/5">
               <p className="text-[10px] sm:text-[11px] font-bold mb-3 text-center sm:text-left text-[var(--text-secondary)] opacity-60 uppercase">{t.pickupCode}</p>
               <div className="text-4xl sm:text-5xl font-mono tracking-wider font-extrabold text-[var(--accent)] text-center my-2 sm:my-4">
                {result.pickupCode}
               </div>
               
               <div className="flex gap-2 text-[10px] mt-4">
                <button 
                  onClick={() => handleCopy(result.pickupCode, 'code')}
                  className="flex-1 py-2 sm:py-3 border border-[var(--border-color)] rounded-xl text-[10px] font-black uppercase tracking-widest hover:border-[var(--accent)] transition-all flex items-center justify-center gap-2 bg-[var(--bg-primary)]"
                >
                  {copyStatus === 'code' ? t.copied : <><Copy size={14} /> {t.copyCode}</>}
                </button>
                <button 
                  onClick={() => handleCopy(`${window.location.origin}/?pickup=${result.pickupCode}`, 'link')}
                  className="flex-1 py-2 sm:py-3 border border-[var(--border-color)] rounded-xl text-[10px] font-black uppercase tracking-widest hover:border-[var(--accent)] transition-all flex items-center justify-center gap-2 bg-[var(--bg-primary)]"
                >
                  {copyStatus === 'link' ? t.copied : <><ExternalLink size={14} /> {t.copyLink}</>}
                </button>
              </div>
            </div>
          </div>
        )}

        <button 
          onClick={() => {setResult(null); setFiles([]); setContent(""); setTitle(""); setShowQr(false);}} 
          className="w-full py-3 sm:py-4 bg-[var(--bg-primary)] border border-[var(--border-color)] hover:border-[var(--accent)] hover:text-[var(--accent)] rounded-xl text-[12px] sm:text-[13px] font-black transition-all mt-4 uppercase tracking-widest flex items-center justify-center gap-2"
        >
          <Upload size={16} className="opacity-50" />
          {t.newDeposit}
        </button>
      </motion.div>
    );
  }

  // 默认表单页
  return (
    <motion.form 
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      onSubmit={handleSubmit} className="space-y-4 sm:space-y-6"
    >
      {type === 'public' ? (
         <div className="space-y-3 sm:space-y-4">
            <input 
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t.titlePlaceholder}
              className="input-minimal text-sm"
            />
            {files.length > 0 ? (
              <div className="card-minimal flex items-center justify-between p-3 sm:p-4 border-[var(--accent)]/30 bg-[var(--accent)]/5 shadow-inner">
                <div className="flex items-center gap-3 overflow-hidden">
                  <FileText className="text-[var(--accent)]" size={16} /> 
                  <span className="text-[12px] font-medium truncate">{files[0].name}</span>
                </div>
                <button type="button" onClick={() => setFiles([])} className="text-[11px] font-bold text-red-500 hover:scale-105 transition-all">{t.remove}</button>
              </div>
            ) : (
              <textarea 
                value={content} onChange={e => setContent(e.target.value)}
                placeholder={t.publicLabel} 
                className="input-minimal h-32 sm:h-44 resize-none"
              />
            )}
            <input id="pub-f" type="file" accept=".txt" className="hidden" onChange={e => {
              if (e.target.files?.[0]) setFiles([e.target.files[0]]);
            }} />
            {!files.length && !content && (
              <button type="button" onClick={() => document.getElementById('pub-f')?.click()} className="w-full py-3 border-2 border-dashed border-[var(--border-color)] rounded-lg text-[12px] font-semibold text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all">
                {t.attachTxt}
              </button>
            )}
         </div>
      ) : (
         <div className="space-y-4 sm:space-y-6">
            <div className="flex flex-col gap-1 items-center mb-4 px-2">
              <div className="flex justify-between w-full text-[10px] uppercase font-bold tracking-tight opacity-50">
                <span>{t.uploadLimit}</span>
                <span className="text-[var(--accent)]">
                  {maxSingle}MB (SINGLE) / {maxZip}MB (ZIP)
                </span>
              </div>
              <div className="w-full h-[1px] bg-gradient-to-r from-transparent via-[var(--border-color)] to-transparent" />
            </div>

            {/* 文件拖拽组件，支持点击调起系统选择器 */}
            <div 
              className={`card-minimal border-dashed border-2 flex flex-col items-center py-4 sm:py-10 gap-1 sm:gap-3 cursor-pointer group transition-all ${files.length > 0 ? "border-[var(--accent)] bg-[var(--accent)]/5" : "hover:border-[var(--accent)] hover:bg-[var(--accent)]/5"}`}
              onClick={() => document.getElementById('priv-f')?.click()}
            >
              <FileUp className={`transition-all ${files.length > 0 ? "text-[var(--accent)] scale-110" : "opacity-20 group-hover:opacity-100 group-hover:text-[var(--accent)]"}`} size={24} />
              <div className="text-center px-4">
                {files.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-[11px] font-bold">{files.length} {t.readyFiles}</p>
                    <p className="text-[10px] text-[var(--text-secondary)] opacity-60 truncate max-w-[120px] sm:max-w-[200px]">{files.map(f => f.name).join(", ")}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-[12px] font-bold">{t.dragHint}</p>
                    <p className="text-[10px] text-[var(--text-secondary)] opacity-50">{t.typeHint}</p>
                  </div>
                )}
              </div>
              <input 
                id="priv-f" type="file" multiple 
                accept=".jpg,.jpeg,.png,.txt,.md,.zip" 
                className="hidden" 
                onChange={e => {
                  if (e.target.files) {
                    const selected = Array.from(e.target.files);
                    if (selected.length > 10) {
                      setError("最多允许 10 个文件");
                      setFiles(selected.slice(0, 10));
                    } else {
                      setFiles(selected);
                    }
                  }
                }} 
              />
           </div>

           {/* 时间选择网格 */}
           <div className="space-y-3">
              <div className="flex justify-between items-center px-1">
                <p className="text-[12px] font-bold text-[var(--text-secondary)]">{t.durationLabel}</p>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {Array.from(new Set(["2", "6", "12", config?.maxStorageHours ? Math.max(24, config.maxStorageHours).toString() : "24"])).map((h, i, arr) => {
                   if (i > 0 && h === arr[i-1]) return null;
                   return (
                   <button key={h} type="button" onClick={() => setDuration(h)} className={`py-2 text-[13px] font-bold border rounded-lg transition-all ${duration === h ? "bg-[var(--accent)] text-white border-transparent shadow-md" : "border-[var(--border-color)] hover:border-[var(--accent)]"}`}>
                     {h}h
                   </button>
                   );
                })}
              </div>
           </div>
         </div>
      )}

      {error && (
        <div className="p-3 border-2 border-red-500/50 bg-red-500/5 rounded-xl text-center">
          <p className="text-[10px] text-red-500 font-black font-mono uppercase tracking-[0.2em]">{error}</p>
        </div>
      )}

      {/* 提交按钮：处理中会显示 Loading 动画 */}
      <button 
        disabled={loading || (type === 'public' ? (!content && !files.length) : !files.length)}
        className="w-full h-12 sm:h-14 bg-[var(--accent)] text-white shadow-md hover:shadow-lg rounded-lg text-[14px] font-bold disabled:opacity-50 transition-all flex items-center justify-center gap-2 active:scale-95"
      >
        {loading ? (
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            <span>{t.processing}</span>
          </div>
        ) : (
          <span>{t.engage}</span>
        )}
      </button>
    </motion.form>
  );
}

/**
 * 提取表单组件：用于输入 6 位验证码
 */
function PickupForm({ t }: { t: any }) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchParams] = useSearchParams();
  const autoPickupRun = useRef(false);

  // 自动填写逻辑：如果是通过带参数的链接进入，自动填充提取码但由用户手动触发提取
  useEffect(() => {
    const urlCode = searchParams.get('pickup');
    if (urlCode && urlCode.length === 6 && !autoPickupRun.current) {
      setCode(urlCode);
      autoPickupRun.current = true;
    }
  }, [searchParams]);

  const executeVerify = async (vCode: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: vCode })
      });
      const data = await res.json();
      if (data.success) {
        // 优选方案：直接通过浏览器跳转到 GET 下载接口，移动端兼容性最佳
        if (data.downloadUrl) {
          window.location.href = data.downloadUrl;
        } else if (data.data) {
          // 备选方案（保留旧逻辑兼容性）
          const link = document.createElement('a');
          link.href = `data:${data.mimeType};base64,${data.data}`;
          link.download = data.fileName;
          link.click();
        } else {
          window.open(data.downloadUrl || `/view/${data.id}`, '_blank');
        }
      } else {
        if (data.error === "DECRYPTION_FAILED") {
          setError(t.decryptionError);
        } else {
          setError(t.expired);
        }
      }
    } catch (err) {
      setError("网络连接中断");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    executeVerify(code);
  };

  return (
    <motion.form 
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      onSubmit={handleVerify} className="space-y-10 py-4"
    >
      <div className="text-center">
        <h2 className="text-xl font-black font-mono tracking-[0.3em] uppercase mb-2 terminal-text">{t.extract}</h2>
        <div className="flex items-center gap-2 justify-center opacity-30">
          <div className="h-[1px] w-8 bg-[var(--border-color)]" />
          <p className="text-[9px] font-black uppercase">Secure_Vault_Access</p>
          <div className="h-[1px] w-8 bg-[var(--border-color)]" />
        </div>
      </div>
      {/* 密码输入框：支持限制 6 位数字，并带有打字机样式的交互 */}
      <div className="relative group">
        <input 
          placeholder="000000"
          value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          className="w-full text-center text-4xl sm:text-6xl font-mono tracking-[0.2em] sm:tracking-[0.4em] font-black border-b-[3px] border-[var(--border-color)] py-8 bg-transparent focus:outline-none focus:border-[var(--accent)] transition-all placeholder:opacity-5 italic"
        />
        <div className="absolute -bottom-[2px] left-0 w-0 h-[3px] bg-[var(--accent)] group-focus-within:w-full transition-all duration-500 shadow-[0_0_15px_var(--accent)]" />
        {error && <p className="absolute -bottom-8 left-0 right-0 text-center text-[9px] font-black text-red-500 uppercase tracking-widest">{error}</p>}
      </div>
      <button 
        disabled={loading || code.length !== 6}
        className="w-full h-16 bg-[var(--accent)] text-white shadow-[0_4px_15px_rgba(6,182,212,0.3)] rounded-xl text-[11px] tracking-[0.4em] uppercase font-black disabled:opacity-10 transition-all flex items-center justify-center gap-3"
      >
        {loading ? (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-white animate-pulse" />
            <span>{t.processing}</span>
          </div>
        ) : (
          <>
            <Lock size={14} className="opacity-40" />
            {t.verify}
            <Lock size={14} className="opacity-40" />
          </>
        )}
      </button>
    </motion.form>
  );
}

/**
 * 公开访问页：查看文字内容
 */
function ViewPage({ t }: { t: any }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/view/${id}`).then(res => res.json()).then(res => {
      if (res.content) setData(res); else setError(t.expired);
      setLoading(false);
    }).catch(() => { setError(t.fail); setLoading(false); });
  }, [id, t]);

  return (
    <div className="px-6 flex justify-center">
      <div className="w-full max-w-4xl">
        <button onClick={() => navigate("/")} className="mb-10 group flex items-center gap-2 text-[10px] font-black font-mono text-[var(--text-secondary)] hover:text-[var(--accent)] uppercase tracking-widest transition-all">
          <ArrowLeft size={14} className="group-hover:-translate-x-1 transition-transform" /> 
          &lt; {t.return}
        </button>

        {/* 骨架屏 / 加载动画 */}
        {loading ? (
          <div className="py-20 text-center">
            <div className="w-12 h-1 bg-[var(--border-color)] mx-auto relative overflow-hidden mb-6 rounded-full">
              <div className="absolute inset-0 bg-[var(--accent)] w-1/3 animate-[loading_1s_infinite] rounded-full" />
            </div>
            <p className="text-[12px] font-medium opacity-60">{t.decrypting}</p>
            <style>{`
              @keyframes loading {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(300%); }
              }
            `}</style>
          </div>
        ) : error ? (
          <div className="card-minimal py-20 text-center space-y-6 border-red-500/20">
             <AlertCircle size={48} className="mx-auto text-red-500/30" />
             <div className="space-y-2">
               <p className="text-xs font-black font-mono text-red-500 uppercase tracking-widest">{error}</p>
               <p className="text-[9px] font-bold opacity-30 font-mono uppercase">Reference: OBJ_NOT_FOUND_OR_EXPIRED</p>
             </div>
          </div>
        ) : (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="card-minimal border-t-4 border-t-[var(--accent)]">
            {/* 内容预览头部 */}
            <div className="p-8 border-b border-[var(--border-color)] flex flex-col md:flex-row justify-between items-start md:items-end gap-6 bg-[var(--accent)]/5">
              <div className="space-y-4">
                <div className="inline-block px-3 py-1 bg-[var(--accent)] text-white font-black text-[9px] uppercase tracking-widest italic rounded">
                  Public_Access
                </div>
                <div>
                  <h1 className="text-2xl sm:text-4xl font-black font-display tracking-tight uppercase italic terminal-text truncate max-w-[240px] sm:max-w-md">{data.fileName}</h1>
                  <p className="text-[10px] text-[var(--text-secondary)] font-mono font-bold uppercase tracking-widest mt-4 flex items-center gap-2">
                    <Clock size={12} className="opacity-40" />
                    REGISTERED: {new Date(data.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <Shield className="text-[var(--accent)]/40 hidden md:block" size={48} />
            </div>
            {/* 文字分享的核心展示区域 */}
            <div className="p-8 bg-black/5 dark:bg-white/5 rounded-b-xl font-mono text-sm leading-relaxed whitespace-pre-wrap selection:bg-[var(--accent)] selection:text-white border-t border-[var(--border-color)] min-h-[300px]">
              {data.content}
            </div>
            <div className="p-4 flex justify-between items-center opacity-40">
               <div className="text-[8px] font-black font-mono uppercase tracking-[0.3em]">
                Payload_Digest: SHA256_VERIFIED
               </div>
               <div className="text-[8px] font-mono tracking-tighter italic">
                {data.content.length} bytes processed
               </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
