# Weekly backup copy to AKB's office server

Besides the backups inside AWS, AKB's own office server keeps a copy of the database every week. This protects against losing the AWS account itself, for example through a billing problem, a hacked login or AWS closing the account.

**How it works**

- **The office pulls, AWS never pushes.** Once a day the office server checks whether its newest copy is 6 days old or more. If it is, it downloads the latest nightly backup.
  - That gives one copy a week.
  - If the office server was off on the usual day, it catches up the next day it runs.
  - Nothing on AWS can reach into the office, and nothing on AWS can delete the office's copies.
- **The office login is limited.** It can read the nightly backups and nothing else. It can't see the server or the live database, and it can't change or delete anything.
- **The copies stay encrypted.** A stolen office disk is useless without the owners' backup key (`DEPLOY_AWS.md`, step 2).
- **Each copy is checked as it arrives.** Its fingerprint must match the one recorded when the backup was made. A damaged download is thrown away and tried again the next day.
- **AWS watches the office.** After each copy, the office leaves a receipt in AWS. If no copy is collected for 8 days, the AWS server emails an alert.
- **Copies are kept for a year** (`KEEP_DAYS=365`), then removed.

**Cost:** roughly $1–5 a month of AWS download charges, depending on database size.

## Setup (about 20 minutes)

### 1. AWS: make the office login

1. If the stack was created before this feature existed, update it first: CloudFormation → `akb-erp` → **Update** → Replace current template → upload `deploy/aws/akb-erp-stack.yaml` → Next. Keep the existing values.
2. Set `OfficeIpCidr` to the office's fixed IP if it has one, e.g. `203.0.113.10/32`. The office login then only works from the office. Leave it as `0.0.0.0/0` if the office IP changes.
3. Note `OfficeBackupUser` and `BackupBucket` on the **Outputs** tab.
4. **IAM** → Users → the `OfficeBackupUser` name → Security credentials → **Create access key** → "Application running outside AWS". Copy the **Access key** and the **Secret access key**. The secret is shown only once.

### 2. Office server: install

**Windows**

1. Install the AWS CLI: download and run the 64-bit Windows installer (AWSCLIV2.msi) from the AWS website.
2. Create the folder `C:\AKB-Backup` and copy `deploy\office\pull-backup.ps1` and `deploy\office\office-backup.conf.example` into it.
3. Rename `office-backup.conf.example` to `office-backup.conf` and fill in:
   - `BUCKET`
   - `REGION`
   - `DEST`, e.g. `D:\AKB-Backups`. Use a disk that is itself mirrored, or copied to an external drive monthly.
4. Create `C:\AKB-Backup\aws-credentials` in Notepad, using the access key from step 1:

   ```
   [default]
   aws_access_key_id = AKIA...
   aws_secret_access_key = ...
   ```

5. Lock that file down so only administrators and the system can read it. Run in an administrator PowerShell:

   ```powershell
   icacls C:\AKB-Backup\aws-credentials /inheritance:r /grant:r "SYSTEM:R" "Administrators:R"
   ```

6. Test it. The first copy should arrive and the log should say `ok`:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\AKB-Backup\pull-backup.ps1 -Now
   ```

7. Schedule it daily at 02:30. It only downloads once a week. It runs even if nobody is signed in, and catches up if the machine was off:

   ```powershell
   $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\AKB-Backup\pull-backup.ps1'
   $t = New-ScheduledTaskTrigger -Daily -At 2:30am
   $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun
   Register-ScheduledTask -TaskName 'AKB ERP weekly backup copy' -Action $a -Trigger $t -Settings $s -User 'SYSTEM' -RunLevel Highest
   ```

**Linux**

```bash
sudo apt-get install -y awscli || sudo snap install aws-cli --classic
sudo mkdir -p /opt/akb-backup && cd /opt/akb-backup
sudo cp /path/to/AKB-ERP/deploy/office/pull-backup.sh /path/to/AKB-ERP/deploy/office/office-backup.conf.example .
sudo mv office-backup.conf.example office-backup.conf && sudo nano office-backup.conf     # BUCKET, REGION, DEST
sudo nano aws-credentials        # the [default] block shown in the Windows steps
sudo chmod 600 aws-credentials && sudo chmod 700 /opt/akb-backup
sudo ./pull-backup.sh --now      # test: the first copy arrives
echo '30 2 * * * root /opt/akb-backup/pull-backup.sh' | sudo tee /etc/cron.d/akb-backup-copy
```

## Checking it

- Each run writes a line to `pull-backup.log` in the backup folder.
- The copies are named `akb-YYYYMMDD-HHMMSS.dump.age`, by the date and time each backup was made.
- If AWS emails "office-copy", the office server hasn't collected a copy for 8 days. Check that it's on and online, and read the log.

## Restoring from an office copy

Only needed if AWS itself is unavailable. You need the owners' backup key.

- **Back onto AWS:** follow "The server is lost" in `DEPLOY_AWS.md`, putting the office copy on the new server. Then run:

  ```bash
  sudo deploy/aws/restore.sh --key /root/akb-backup.key --file /root/akb-YYYYMMDD-HHMMSS.dump.age --replace-live
  ```

- **On a machine in the office**, using the Docker setup from `RUNNING_ON_A_MAC.md`, which also works on Windows or Linux with Docker:

  ```bash
  age --decrypt -i akb-backup.key -o akb.dump akb-YYYYMMDD-HHMMSS.dump.age
  docker compose up -d db
  docker compose exec -T db psql -U postgres -c "drop database if exists akb with (force)" -c "create database akb owner akb_owner"
  docker compose exec -T db pg_restore -U postgres --exit-on-error -d akb < akb.dump
  docker compose up -d
  ```

  Delete `akb.dump` afterwards; it is the unencrypted database.
