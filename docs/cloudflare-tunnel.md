# Cloudflare Tunnel — Setup Guide

Gives the app a stable **HTTPS** public URL with zero port forwarding or SSL config.
Required for Web Share API file sharing (PDF directly to WhatsApp).

---

## 1. Install cloudflared

```bash
# Ubuntu / Debian
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

---

## 2. Authenticate

```bash
cloudflared tunnel login
```

Opens a browser — log in to your Cloudflare account and authorise.
A cert file is saved to `~/.cloudflared/cert.pem`.

---

## 3. Create a named tunnel

```bash
cloudflared tunnel create kosca-ar
```

Note the **Tunnel ID** printed (e.g. `a1b2c3d4-...`).

---

## 4. Create the config file

`~/.cloudflared/config.yml`

```yaml
tunnel: kosca-ar
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: ar.yourdomain.com
    service: http://localhost:3001
  - service: http_status:404
```

Replace `ar.yourdomain.com` with your subdomain and `<tunnel-id>` with the actual ID.

---

## 5. Add DNS record

```bash
cloudflared tunnel route dns kosca-ar ar.yourdomain.com
```

This creates a CNAME in your Cloudflare DNS automatically.

---

## 6. Run the tunnel

**One-off (for testing):**
```bash
cloudflared tunnel run kosca-ar
```

**As a system service (permanent):**
```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

---

## 7. Trust the proxy in Express

Add this to `src/server.js` so `req.protocol` returns `https`:

```js
app.set('trust proxy', 1);
```

---

## Result

| Before | After |
|--------|-------|
| `http://192.168.2.222:3001` | `https://ar.yourdomain.com` |
| Share API → no file sharing | Share API → native PDF share to WhatsApp ✓ |
| LAN only | Accessible from anywhere |

Once live, remove the `/ar/temp-share` upload routes — Web Share API will send the PDF file directly without the server detour.

---

## No domain? Quick test with a free URL

```bash
cloudflared tunnel --url http://localhost:3001
```

Cloudflare assigns a random `https://xxxx.trycloudflare.com` URL instantly — no account needed.
Not stable (changes on restart) but good for testing share functionality first.
