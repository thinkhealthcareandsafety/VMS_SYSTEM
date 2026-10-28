#!/bin/bash
# Every night at 02:00 (site time): the whole database as one compressed file, and the photos mirrored across.
# Database copies are kept one year (366 days), on the backup drive inside the hotel only. Restore: see docs/ONSITE.md.
# Only onto the backup drive: install.sh marks it (.vms-backup-drive) when it is mounted, so an unplugged drive never
# fills the system disk. Each run writes status.json, which the admin console shows when a backup is late or failed.
# Run one now:  sudo docker compose -f deploy/docker-compose.yml exec backup bash /backup.sh now
set -u

status() {
  printf '{"at":"%s","ok":%s,"error":"%s"}\n' "$(date -Iseconds)" "$1" "$2" > /backup/status.json.tmp && mv /backup/status.json.tmp /backup/status.json
}

run() {
  day=$(date +%F)
  if [ ! -f /backup/.vms-backup-drive ]; then
    echo "$(date) backup $day SKIPPED: backup drive not connected" >> /backup/backup.log
    status false "The backup drive is not connected"
    return
  fi
  if mongodump --uri="mongodb://mongo:27017/vms" --gzip --archive="/backup/vms-$day.archive.gz.part" --quiet; then
    mv "/backup/vms-$day.archive.gz.part" "/backup/vms-$day.archive.gz"
    mkdir -p /backup/uploads && cp -ru /uploads/. /backup/uploads/
    # Photos and ID images deleted under the retention rule leave the copy too. Skipped if the photo folder looks
    # empty (not mounted), so a mistake can never wipe the copy.
    if [ -n "$(ls -A /uploads 2>/dev/null)" ]; then
      (cd /backup/uploads && find . -type f | while IFS= read -r f; do [ -e "/uploads/$f" ] || rm -f "$f"; done)
    fi
    find /backup -maxdepth 1 -name 'vms-*.archive.gz' -mtime +366 -delete
    echo "$(date) backup $day done" >> /backup/backup.log
    status true ""
  else
    rm -f "/backup/vms-$day.archive.gz.part"
    echo "$(date) backup $day FAILED" >> /backup/backup.log
    status false "The database copy failed"
  fi
}

[ "${1:-}" = now ] && { run; exit 0; }
while true; do
  sleep $(( $(date -d 'tomorrow 02:00' +%s) - $(date +%s) ))
  run
done
