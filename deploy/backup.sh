#!/bin/bash
# Every night at 02:00 (site time): the whole database as one compressed file, and the photos mirrored across.
# On the backup drive: database copies kept one year (366 days), inside the hotel only. Restore: see docs/ONSITE.md.
# No drive connected (the backup folder is on the same disk as the data): the database alone is still copied, the
# last 14 days, so a mistake or a damaged database can be undone; the photos are not, so the system disk never fills.
# The console says so until the drive is connected. A night the PC was off is made up five minutes after it starts.
# Each run writes status.json, which the admin console shows when a backup is late, failed or not on the drive.
# Run one now:  sudo docker compose -f deploy/docker-compose.yml exec backup bash /backup.sh now
set -u

status() {
  printf '{"at":"%s","ok":%s,"error":"%s","drive":%s}\n' "$(date -Iseconds)" "$1" "$2" "${3:-true}" > /backup/status.json.tmp && mv /backup/status.json.tmp /backup/status.json
}

# A separate drive: the backup folder sits on another device than the photos.
on_drive() { [ "$(stat -c %d /backup)" != "$(stat -c %d /uploads)" ]; }

run() {
  day=$(date +%F)
  if ! mongodump --uri="mongodb://mongo:27017/vms" --gzip --archive="/backup/vms-$day.archive.gz.part" --quiet; then
    rm -f "/backup/vms-$day.archive.gz.part"
    echo "$(date) backup $day FAILED" >> /backup/backup.log
    status false "The database copy failed"
    return
  fi
  mv "/backup/vms-$day.archive.gz.part" "/backup/vms-$day.archive.gz"
  if ! on_drive; then
    find /backup -maxdepth 1 -name 'vms-*.archive.gz' -mtime +14 -delete
    echo "$(date) backup $day done (database only: no backup drive connected)" >> /backup/backup.log
    status true "" false
    return
  fi
  mkdir -p /backup/uploads
  if ! cp -ru /uploads/. /backup/uploads/; then
    echo "$(date) backup $day FAILED copying photos" >> /backup/backup.log
    status false "The photos could not be copied. The backup drive may be full."
    return
  fi
  # Only ID images deleted under the retention rule leave the copy (id-masked, id-full). Visitor photos, material and
  # parcel photos are never removed from it: if any went missing on the PC, the copy is where they are found again.
  # Skipped if the photo folder looks empty (not mounted), so a mistake can never wipe the copy.
  if [ -n "$(ls -A /uploads 2>/dev/null)" ]; then
    for d in id-masked id-full; do
      [ -d "/backup/uploads/$d" ] || continue
      (cd "/backup/uploads/$d" && find . -type f | while IFS= read -r f; do [ -e "/uploads/$d/$f" ] || rm -f "$f"; done)
    done
  fi
  # The server's settings, with the key the full ID images are encrypted with: without it a restored PC could
  # never open them again.
  if [ -f /config/site.env ]; then cp /config/site.env /backup/server-settings.env.part && chmod 600 /backup/server-settings.env.part && mv /backup/server-settings.env.part /backup/server-settings.env; fi
  find /backup -maxdepth 1 -name 'vms-*.archive.gz' -mtime +366 -delete
  echo "$(date) backup $day done" >> /backup/backup.log
  status true ""
}

[ "${1:-}" = now ] && { run; exit 0; }
# Missed while the PC was off (no copy in the last 26 hours): made up shortly after start, once the database is up.
latest=$(ls -1t /backup/vms-*.archive.gz 2>/dev/null | head -1)
if [ -z "$latest" ] || [ $(( $(date +%s) - $(stat -c %Y "$latest") )) -gt 93600 ]; then
  sleep 300
  run
fi
while true; do
  sleep $(( $(date -d 'tomorrow 02:00' +%s) - $(date +%s) ))
  run
done
