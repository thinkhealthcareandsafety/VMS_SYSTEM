# On-site install: one mini PC, three gate tablets

All visitor data stays on the mini PC inside the hotel. The internet is used only to send messages (WhatsApp, email,
SMS) and to let hosts open their approval links. The admin console and guard desk can be opened only inside the hotel.

```
 Gate 1 tablet    Gate 2 tablet    Gate 3 tablet        Admin PC (security office)
        \_______________|______________/____________________/
                    hotel network (Wi-Fi / LAN)
                               |
                     MINI PC (server room, on UPS)
                     database + photos + backups
                               |  outgoing only
              Cloudflare tunnel -> hosts' approval links, WhatsApp replies
```

## What you need
- Mini PC (i5 / 16 GB / 512 GB+ SSD), LAN cable, UPS power
- 1 TB external SSD for backups
- 3 Android tablets (Chrome), one per gate, plus a printer for the pass slips
- A USB stick (8 GB) to install Ubuntu
- Your Cloudflare login, the GateSmartX licence key

## Step 1. Cloudflare (once, from the office, 15 minutes)
1. Sign up at cloudflare.com, **Add a site**: `gatesmartx.com`, free plan. It copies your current DNS records.
2. At GoDaddy, change the domain's **nameservers** to the two Cloudflare gives you. Wait until Cloudflare says Active.
3. **API token**: My Profile → API Tokens → Create Token → template *Edit zone DNS* → Zone: gatesmartx.com. Copy it (this is `CF_API_TOKEN`).
4. **Tunnel**: Zero Trust → Networks → Tunnels → Create → Cloudflared → name `stregis`. Copy the token from the install command (the long text after `--token`; this is `TUNNEL_TOKEN`).
   Public hostname: `stregis.gatesmartx.com` → Service `HTTP` → `app:4000`. (If Vercel still holds this name, remove the domain from the Vercel project first.)

## Step 2. Hotel IT (send this list before the visit)
1. A **fixed IP** for the mini PC (DHCP reservation), e.g. `10.20.30.40`.
2. Gate tablets and the admin PC can reach that IP on port **443**.
3. The mini PC may go out to the internet on port **443** (no incoming ports needed).
4. An **internal DNS record**: `stregis-desk.gatesmartx.com` → the mini PC's IP. With it, the gates keep working when the internet is down.
5. Rack space and UPS power for the mini PC.

## Step 3. Install Ubuntu on the mini PC (30 minutes)
1. On any PC, download **Ubuntu Server 24.04 LTS**, write it to the USB stick with **balenaEtcher**.
2. Boot the mini PC from the USB (F7/F12/Esc at power-on). Install with defaults; tick **Install OpenSSH server**.
   User: `gatesmartx`, a strong password (keep it in the GateSmartX password manager; never give it to the hotel).
3. In the BIOS, set **Restore on AC power loss = Power On**, so it starts by itself after a power cut.

## Step 4. Backup drive
Plug in the external SSD, then:
```
lsblk                                   # find it, e.g. sdb
sudo mkfs.ext4 -L vmsbackup /dev/sdb    # erases the SSD
sudo mkdir -p /mnt/vms-backup
echo 'LABEL=vmsbackup /mnt/vms-backup ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
```

## Step 5. Install the system
```
sudo apt-get install -y git
git clone https://github.com/thinkhealthcareandsafety/VMS_SYSTEM.git ~/vms && cd ~/vms
sudo bash deploy/install.sh          # first run creates deploy/.env with fresh secrets
nano deploy/.env                     # fill LAN_HOST, CF_API_TOKEN, TUNNEL_TOKEN (Ctrl+O, Enter, Ctrl+X)
sudo bash deploy/install.sh          # builds and starts everything (5-10 minutes the first time)
```
In Cloudflare DNS add: **A** `stregis-desk` → the mini PC's IP, proxy **off** (grey cloud).

## Step 6. First sign-in and settings
```
sudo docker compose -f deploy/docker-compose.yml exec app node scripts/create-user.js admin "Site Admin" superadmin 'a-long-password'
```
Open `https://stregis-desk.gatesmartx.com` on the admin PC and sign in. Then in **Settings**:
1. **Licence**: paste the key from GateSmartX.
2. **Site name**, **gates** (3), **assembly point**, **escalation contacts**.
3. **Staff**: one guard login per gate (`gate1`, `gate2`, `gate3`), each set to its gate.
4. **Hosts**: import the Excel list.

## Step 7. The three tablets
1. Connect to the hotel staff Wi-Fi. Open Chrome → `https://stregis-desk.gatesmartx.com`.
2. Sign in with that gate's login. Allow the **camera**.
3. Chrome menu → **Add to Home screen**. Settings → Display → screen timeout: longest; keep it on charge.
4. Test: check in a test visitor, approve, print the slip, scan out at another gate.

## Step 8. Messages
- WhatsApp (Meta app → WhatsApp → Configuration): webhook `https://stregis.gatesmartx.com/api/whatsapp/webhook`. Fill the `WHATSAPP_*` lines in `deploy/.env`, run `sudo bash deploy/install.sh`.
- Email / SMS: fill their lines the same way.

## Before you leave the site
- [ ] Check-in, approval, slip print, scan out at a different gate: visit history shows both gates and guards
- [ ] Courier logged and handed over; material in and vendor checkout
- [ ] Emergency **drill** sent, roll call ticked, all clear
- [ ] Pull the internet cable for a minute: check-in still works on the tablets
- [ ] Next morning: `ls /mnt/vms-backup` shows last night's backup

## Running it
| Task | How |
|---|---|
| Update to the latest version | `cd ~/vms && git pull && sudo bash deploy/install.sh` |
| See if everything runs | `sudo docker compose -f deploy/docker-compose.yml ps` |
| Logs | `sudo docker compose -f deploy/docker-compose.yml logs --tail 100 app` |
| Check backups | `tail /mnt/vms-backup/backup.log` |
| Renew the licence | GateSmartX: `node server/scripts/license.js <private-key.pem> "<Site>" <YYYY-MM-DD> 3`; the admin pastes it in Settings → Licence |
| Restore a backup | `sudo bash deploy/restore.sh` (the latest) or `sudo bash deploy/restore.sh 2026-10-28`. It saves the database as it is first, so a restore can be undone, and copies back any missing photos. On a new PC, copy `/mnt/vms-backup/server-settings.env` to `deploy/.env` before installing: it holds the key the full ID images are encrypted with. |

When the licence ends, new check-ins, material and courier entries pause. Check-outs, Emergency and all records keep
working. Never keep the licence private key (`private-key.pem`) on the hotel's mini PC.
