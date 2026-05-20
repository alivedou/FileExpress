# File Express 📦

A minimalist, secure, and ephemeral file transfer hub.

## Quick Start

**1. Install Node.js 20**

*Option A: Via NVM (Recommended)*
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc # or restart your terminal
nvm install 20
nvm use 20
```

*Option B: Direct Installation (Ubuntu/Debian)*
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
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
> - `MAX_STORAGE_HOURS`: The maximum allowed duration for private files (default `24` hours). Change this value to `72` or custom values to allow longer ephemeral storage.
> - `MAX_TOTAL_STORAGE_MB`: Overall max disk usage to prevent system overload.

**5. Uninstall Application**  
To remove the application and all its data, simply delete the directory:
```bash
cd ..
rm -rf FileExpress
```

**6. Deployment Guide**  
You can easily deploy File Express in various robust environments:

- **Local & WSL**: Works perfectly out of the box using `./fe.sh`. Ideal for short-term personal file transfers within the same local network.
- **VPS Server (Public Node)**: Ideal for a 24/7 public file hub. Utilize the "Background Running" option (Option 4) in the `FE` menu to smoothly daemonize the service on your cloud instance.
- **Cloudflare Tunnel (Zero Trust)**: Highly recommended for exposing the service without opening firewall ports. Simply install `cloudflared` on your WSL or VPS and tunnel the local `http://localhost:<PORT>` securely to your custom domain.
