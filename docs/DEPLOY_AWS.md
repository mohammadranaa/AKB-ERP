# AKB ERP on AWS (the real system)

The real AKB ERP runs on one AWS server in AKB's own AWS account. The owners decided this in November 2026, replacing the earlier plan for a server in the office.
The Vercel trial (`DEPLOY_VERCEL_TRIAL.md`) stays a practice system with made-up data. Nothing is copied from it: the AWS system starts empty and the real data comes from EduSoft plus opening balances.

Everything for this setup is in `deploy/aws/`.

| File | What it is |
|---|---|
| `akb-erp-stack.yaml` | The AWS template: creates the server, network, backup storage, alerts and spending alert in one go |
| `docker-compose.yml`, `Caddyfile`, `nginx-real-ip.conf` | How the software runs on the server: HTTPS front, screens, API, database |
| `install.sh` | One-time installation on the server |
| `create-admin.sh` | Creates the first administrator |
| `backup-s3.sh`, `restore.sh` | Encrypted backups to S3 and restoring them |
| `health.sh` | Checks every 5 minutes and emails when something is wrong |
| `update.sh` | Installs a new version from GitHub |

## What gets built

```
 Staff (office, phones)                AWS account (one region)
        │  HTTPS only                ┌────────────────────────────────────────────────────┐
        └──────────────────────────► │ EC2 server (Ubuntu 24.04, encrypted disk)          │
                                     │   Caddy (HTTPS certificate) → screens (nginx)       │
                                     │     → API → PostgreSQL 17      (no internet access) │
                                     │                                                    │
                                     │ every 4 h / nightly / monthly: encrypted backup ──►│── S3 bucket (server can add, never delete)
                                     │ nightly: snapshot of the whole disk, kept 14 days  │
                                     │ alarms: hardware fault → moves itself; hang → reboot│── email alerts
                                     └────────────────────────────────────────────────────┘
```

- Only ports 80 (redirects to HTTPS) and 443 are open. There is **no SSH port**: the server is reached through AWS Session Manager, which needs an AWS login.
- The database cannot be reached from outside at all.
- Authenticator-app codes are always required (`REQUIRE_TOTP` cannot be switched off in production).
- Backups are encrypted on the server with a **public** key. The private key that opens them is kept off the server by the owners. Anyone who steals the backups cannot read them, and a hacked server cannot delete them.

**Monthly cost**, roughly, at Mumbai prices; Bahrain and UAE cost a little more:

| Item | Cost |
|---|---|
| m7i.large server, 2 cores and 8 GB | about $77 |
| 100 GB disk | about $9 |
| Snapshots, backups, traffic, public IP | about $10–20 |
| **Total** | **about $100 a month** |

A 1-year or 3-year savings plan cuts the server part by up to about 45%.

## Before you start: decide these

1. **Region.** AWS has no Pakistan region. Mumbai (`ap-south-1`) is cheapest and closest. Bahrain (`me-south-1`) or UAE (`me-central-1`) keep the data out of India. The steps are identical everywhere: just switch the region in the top-right of the AWS console before step 3.
2. **The address staff will use**, e.g. `erp.akbgroup.pk`. You need access to that domain's DNS settings.
3. **Who keeps the backup key.** At least two people, e.g. the CEO and the finance head. **Without this key the backups cannot be opened by anyone, including us.**

## Step 1: secure the AWS account (once)

1. Sign in as the root user (the email the account was opened with) and turn on **MFA**: account menu → Security credentials → Assign MFA.
2. Do not create access keys for the root user.
3. Open **IAM Identity Center**, enable it, and create a user for each person who will manage AWS. Give them the `AdministratorAccess` permission set and require MFA. Use these logins from now on, not root.

## Step 2: make the backup key, on your own computer

Install `age` (Mac: `brew install age`; Windows: `winget install FiloSottile.age`), then:

```bash
age-keygen -o akb-backup.key
```

It prints `Public key: age1...`. Copy that line; it goes to the server in step 6.

The file `akb-backup.key` is the **private key**:
- Keep two copies offline: a USB drive in the office safe and a password manager, or a printed copy in a sealed envelope.
- Do not email it, do not put it in WhatsApp, and never leave it on the server.

## Step 3: create the server (about 10 minutes)

1. In the AWS console, pick the region (top right).
2. Open **CloudFormation** → Create stack → With new resources → Upload a template file → choose `deploy/aws/akb-erp-stack.yaml`.
3. Stack name: `akb-erp`. Fill in the settings:
   - `AlertEmail`: who gets alerts
   - `MonthlyBudgetUSD`: e.g. 150
   - Leave the rest as they are. `AllowedHttpsCidr` can be narrowed to the office IP later if phones won't be used outside it.
4. Tick "I acknowledge that AWS CloudFormation might create IAM resources" → Submit.
5. Wait for `CREATE_COMPLETE`. Then open the **Outputs** tab and note `ServerIp` and `BackupBucket`.
6. Open the email from AWS ("Subscription Confirmation") and click **Confirm**. Otherwise no alerts will arrive.

## Step 4: point the domain at the server

At your domain's DNS provider, add an **A record** for `erp.akbgroup.pk` (or your chosen address) with the value `ServerIp`. Check it from any computer, and wait until the answer shows `ServerIp` (minutes to an hour):

```bash
nslookup erp.akbgroup.pk
```

## Step 5: open a terminal on the server

AWS console → EC2 → Instances → `akb-erp` → **Connect** → Session Manager → Connect. Then:

```bash
sudo -i
cloud-init status --wait        # waits until the server's own preparation has finished
git clone https://github.com/mohammadranaa/AKB-ERP.git /opt/akb-erp
cd /opt/akb-erp
```

If the GitHub repository is private, give the server a read-only deploy key instead:

1. Run `ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 && cat /root/.ssh/id_ed25519.pub`.
2. Add the printed line in GitHub: repository → Settings → Deploy keys → Add, leaving "Allow write access" off.
3. Clone with `git clone git@github.com:mohammadranaa/AKB-ERP.git /opt/akb-erp`.

## Step 6: install

```bash
cd /opt/akb-erp
deploy/aws/install.sh --domain erp.akbgroup.pk --email it@akbgroup.pk --backup-key age1...your-public-key...
```

This takes 5–10 minutes. It:
1. checks the domain points here
2. creates random passwords that exist only on the server (`/opt/akb-erp/.env`)
3. builds and starts everything and obtains the HTTPS certificate
4. sets up the automatic backups and health checks
5. takes a first backup to prove S3 works

## Step 7: first administrator

```bash
deploy/aws/create-admin.sh admin "Full Name"
```

1. Open `https://erp.akbgroup.pk` and sign in with the one-time password it prints.
2. Set a new password, then scan the QR code with an authenticator app (Google or Microsoft Authenticator).
3. Create the other users from **Administration → Users**. Each person gets their own login; no shared accounts.

## Step 8: prove a restore works

Do this now, and again on the first working day of every month.

1. Open the private key file on your computer and copy its contents (the `AGE-SECRET-KEY-...` line).
2. On the server, run:

   ```bash
   nano /root/akb-backup.key        # paste the key, save with Ctrl+O, exit with Ctrl+X
   chmod 600 /root/akb-backup.key
   deploy/aws/restore.sh --key /root/akb-backup.key --latest daily
   shred -u /root/akb-backup.key    # remove the key from the server again
   ```

The check restores the latest nightly backup into a separate database, counts the records, confirms the ledger balances, and deletes the copy. The live system is not touched.

## Going live

1. Load the master data and the 2025–2026 history from EduSoft. Run that import on this server, never on a laptop or the trial.
2. Enter and check the opening balances, which go through the normal approval step.
3. Run in parallel with EduSoft for 2–4 weeks, and switch EduSoft off when closing balances match on consecutive days.
4. Delete the Vercel trial projects and the Neon database at the end of the trial.

## What happens automatically

| What | When | Kept |
|---|---|---|
| Encrypted database backup to S3 | 10:00, 14:00 and 18:00 | 7 days |
| Encrypted database backup to S3 | every night at 23:30 | 35 days |
| Encrypted database backup to S3 | 1st of each month, 23:45 | 13 months |
| Backup before every update | each update | 30 days |
| Snapshot of the whole server disk | every night at 00:00 | 14 days |
| Security updates (reboot if needed) | daily, reboot at 03:30 | — |
| Health check, with an email when something is wrong and again when fixed | every 5 minutes | — |
| Server moves to healthy hardware after an AWS fault, or reboots if it hangs | automatic | — |
| Email when spending passes 80% of the budget | automatic | — |

The health check covers four things:
- the API stops answering
- HTTPS stops answering
- the certificate is not renewing
- the disk is over 80% full, or there's been no nightly backup for 26 hours

## Updating to a new version

Run outside working hours, since staff are signed out for about a minute:

```bash
sudo -i
/opt/akb-erp/deploy/aws/update.sh
```

It backs up first, pulls the latest version from GitHub, rebuilds, restarts, and applies any database changes.

### If an update fails

The alert email names the old version, e.g. `3f2a1bc`. Then:

```bash
cd /opt/akb-erp
git checkout 3f2a1bc                                  # the old version
docker compose -f deploy/aws/docker-compose.yml --env-file .env -p akb-erp up -d --build
# put the key on the server as in step 8, then:
deploy/aws/restore.sh --key /root/akb-backup.key --latest pre-update --replace-live
shred -u /root/akb-backup.key
```

## Disasters

- **AWS hardware fails:** nothing to do. The server moves itself and you get an email.
- **Data entered wrongly or deleted:** posted entries can't be deleted; corrections are reversals. If a whole database has to be rolled back, use `restore.sh ... --replace-live` with the backup from before the problem.

  Everything entered after that backup is lost. Anything after the last backup has to be re-entered, which is at most 4 hours of work in the day and the evening at night.
- **The server is lost or broken beyond repair:**
  1. Create a new stack (step 3) in the **same region**, named e.g. `akb-erp-2`, entering the old `BackupBucket` name in `ExistingBackupBucket`.
  2. Repeat steps 4–6.
  3. Run `restore.sh --latest daily --replace-live`. The stack deletion protection and "keep the bucket" settings mean the old backups survive.
- **Moving to the client's own server later:** the same `deploy/aws/docker-compose.yml` runs on any Ubuntu server with Docker. Install, then restore the latest backup there.

## Never

- Open port 5432 (database) or 22 (SSH) in the security group.
- Set `REQUIRE_TOTP=false`, or run the demo seed, on this server. Both are refused in production anyway.
- Copy `/opt/akb-erp/.env` or the backup private key anywhere they could leak.
- Put real company data on the Vercel trial.
