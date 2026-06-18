# File Express 📦

A minimalist, secure, and ephemeral file transfer hub.

## Quick Start 🚀

### ⚡ One-Click Cloud Deployment (Highly Recommended)
For a premium, instant VPS or Linux workstation installation, just copy and execute this single command:
```bash
bash <(curl -sSfL https://raw.githubusercontent.com/alivedou/FileExpress/main/fe.sh)
```
This script will guide you to configure environment, manage and run the application daemon cleanly!

### 🛠️ Manual Installation from Source

**1. Install Node.js (Version 22 LTS or 24 Current Recommended)**

*Option A: Via NVM (Recommended)*
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc # or restart your terminal
nvm install 22
nvm use 22
```

*Option B: Direct Installation (Ubuntu/Debian)*
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**2. Clone Repository**  
```bash
git clone https://github.com/alivedou/FileExpress.git
cd FileExpress
```

**3. Install Dependencies & Build**  
```bash
npm install
npm run build
```

**4. Run Application & Configuration**  
Make the script executable and run the interactive CLI menu:
```bash
chmod +x fe.sh
./fe.sh
```

> **Configuration (`FE` Menu / `.env` file):**
> File Express can be customized through the CLI menu or directly by editing the `.env` file. Important variables include:
> - `APP_PORT`: Custom port for the server (default `3000`).
> - `MAX_STORAGE_HOURS`: The maximum allowed duration for private files (default `24` hours). Change this value to allow longer ephemeral storage.
> - `MAX_DOWNLOADS`: The maximum allowed extraction count for private files (default `100` times).
> - `MAX_TOTAL_STORAGE_MB`: Overall max disk usage to prevent system overload.

**5. Uninstall Application**  
To permanently remove the application, all stored files, and its background processes, use the built-in self-destruct option:
```bash
./fe.sh
# Select option: 6. 高级选项 (Advanced Options)
# Select option: 2. 完全干净卸载整个应用 (Clean Uninstall)
# Type CONFIRM
```
*Alternatively, you can manually stop the process and delete the directory if needed.*

**6. Deployment Guide**  
You can easily deploy File Express in various robust environments:

- **Local & WSL**: Works perfectly out of the box using `./fe.sh`. You can also enter the Advanced Options to install a global `fe` alias, allowing you to evoke the panel from anywhere securely.
- **VPS Server (Public Node)**: Ideal for a 24/7 public file hub. Utilize the "Background Running" option (Option 4) in the `FE` menu to smoothly daemonize the service on your cloud instance.
- **Cloudflare Tunnel (Zero Trust)**: Highly recommended for exposing the service without opening firewall ports. Simply install `cloudflared` on your WSL or VPS and tunnel the local `http://localhost:<PORT>` securely to your custom domain.

## FAQ / Troubleshooting

**Q: Styles are missing or WebSocket errors in production?**  
A: This usually happens if the application is running in "Development Mode" on a public server. 
1. Run `npm run build` to generate the production bundle.
2. Run the application using `./fe.sh` or ensure `NODE_ENV=production` is set.
3. If styles still fail, the `base: './'` relative path (configured in V2.5.0) will handle sub-directory or proxy-path issues.

**Q: Google Fonts resetting connection?**  
A: In regions like Mainland China, Google service access is blocked. File Express V2.5.0 uses the `fonts.loli.net` mirror by default to ensure stability.
