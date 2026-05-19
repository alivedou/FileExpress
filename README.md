# FileExpress 📦
A minimalist, secure, and ephemeral file transfer hub.

## 🌟 Key Features
- **Security**: Files are stored with **AES-256-GCM** encryption.
- **Stability**: Built-in storage quota management and auto-cleanup for expired files.
- **Anti-Abuse**: IP-based rate limiting to prevent automated script abuse.
- **Management**: Includes a CLI tool (`fe.sh`) for server-side configuration.
- **Responsive**: Mobile-first design with QR code support for easy pick-ups.

## 🚀 Quick Deployment (Linux/VPS)

1. **Install Node.js (20+ / LTS)**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Clone & Build**
   ```bash
   git clone https://github.com/alivedou/FileExpress
   cd FileExpress
   npm install && npm run build
   ```

3. **Configure & Start**
   ```bash
   chmod +x fe.sh
   ./fe.sh  # Follow the menu to configure and start
   ```

## 💻 Local Development (VSCode + nvm)
```bash
nvm use 20
npm install
npm run dev    # Start dev server with HMR
npm run build  # Build for production
npm start      # Run production server
```

## ⚙️ Environment Variables
| Variable | Default | Description |
| :--- | :--- | :--- |
| `STORAGE_ENCRYPTION_KEY` | Auto-generated | AES encryption key for files. |
| `MAX_TOTAL_STORAGE_MB` | 1024 | Total storage quota in MB. |
| `MAX_SINGLE_FILE_SIZE_MB`| 10 | Max size for a single upload. |

## 🗑️ Reset & Uninstallation
- **To Reset Data**: Run `./fe.sh` and select **Option 2 (Full System Reset)**. This deletes all files, database records, and configuration.
- **To Uninstall**: Simply delete the project folder (`rm -rf FileExpress`). The app is portable and leaves no system traces.

---
**License**: For educational and personal use only.
