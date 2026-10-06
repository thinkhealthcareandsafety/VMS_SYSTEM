# Going live: Vercel (frontend) + Render (backend) + MongoDB Atlas (database)

The browser only ever talks to the Vercel address. Vercel forwards every `/api/...` request to the
Render backend (`client/vercel.json`), so login cookies stay on one site and work in every browser.

Do the steps in this order. Each one needs a value from the step before it.

## 1. Database: MongoDB Atlas (free to start)
1. Sign up at https://www.mongodb.com/atlas and create a cluster: **M0 (free)**, provider AWS, region **Mumbai (ap-south-1)**.
2. Database Access: add a user with a long random password.
3. Network Access: add `0.0.0.0/0` (Render does not have a fixed address on the Starter plan).
4. Connect → Drivers: copy the connection string and put the database name in it:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/vms?retryWrites=true&w=majority`

## 2. Backend: Render
1. Sign up at https://render.com with GitHub.
2. New → **Blueprint** → pick the `VMS_SYSTEM` repo. Render reads `render.yaml` and creates `vms-system-api`
   (Starter plan with a 1 GB disk, about $8/month).
3. When asked, fill in:
   - `MONGODB_URI`: the string from step 1
   - `APP_BASE_URL`: leave as `https://vms-system.vercel.app` for now and fix it after step 3
4. After the first deploy, check `https://vms-system-api.onrender.com/api/health` shows `{"ok":true,"db":true}`.
   **If Render gave the service a different address**, put that address in `client/vercel.json` and push.
5. Create the first accounts: service → **Shell**, then run:
   ```
   node scripts/create-user.js admin "Site Admin" admin 'a-strong-password'
   node scripts/create-user.js guard1 "Main Gate" guard 'another-strong-password'
   ```

## 3. Frontend: Vercel
1. Sign up at https://vercel.com with GitHub → **Add New → Project** → import `VMS_SYSTEM`.
2. Set **Root Directory** to `client`. Everything else is read from `client/vercel.json`.
3. Deploy. Copy the address it gives you (e.g. `https://vms-system.vercel.app`).
4. Back in Render → Environment: set `APP_BASE_URL` to that exact address, so SMS approval links open the right site.

Every push to `main` now redeploys both automatically.

## Limits to know
- **Sticker printing is off** in the cloud: the printer sits on the gate's local network, which Render cannot reach.
  The guard screen says "No printer connected"; write the pass number on the visitor slip. A small print agent
  on a gate PC can bring printing back later.
- **SMS is still logged, not sent**, until an SMS provider is set up (`SMS_DRIVER=http`, see OPERATIONS.md).
  Until then, approve from Admin → SMS and prints → Open approval link.
- **Vercel's free (Hobby) plan is for non-commercial use.** A business should use Vercel Pro.
- **Data location:** the database is in Mumbai, but photos and masked Aadhaar images sit on Render's Singapore disk.
  If everything must stay in India, use a VPS in Mumbai or Bangalore for the backend instead (OPERATIONS.md).
