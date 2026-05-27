# Animated QR Transfer - Unraid Docker Deploy

## Option A: Build locally on Unraid

Copy this folder to your Unraid server, for example:

```bash
/mnt/user/appdata/animated-qr-transfer
```

Then SSH into Unraid:

```bash
cd /mnt/user/appdata/animated-qr-transfer
docker build -t animated-qr-transfer:latest .
docker run -d \
  --name animated-qr-transfer \
  -p 8099:80 \
  --restart unless-stopped \
  animated-qr-transfer:latest
```

Open:

```text
http://UNRAID-IP:8099
```

## Option B: Docker Compose

```bash
cd /mnt/user/appdata/animated-qr-transfer
docker compose up -d --build
```

## Tailscale HTTPS

Camera scanning from a phone usually requires HTTPS. Use Tailscale Serve against the Unraid service:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8099
```

Then open the Tailscale HTTPS URL on your phone.

If Tailscale is running inside a container/add-on instead of directly on Unraid, point Serve to the Unraid LAN IP instead:

```bash
tailscale serve --bg --https=443 http://UNRAID-IP:8099
```
