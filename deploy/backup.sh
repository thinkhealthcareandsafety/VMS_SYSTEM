#!/bin/bash
# Every night at 02:00 (site time): the whole database as one compressed file, and any new photos copied across.
# Database copies are kept 30 days. Restore: see docs/ONSITE.md.
set -u
while true; do
  sleep $(( $(date -d 'tomorrow 02:00' +%s) - $(date +%s) ))
  day=$(date +%F)
  if mongodump --uri="mongodb://mongo:27017/vms" --gzip --archive="/backup/vms-$day.archive.gz" --quiet; then
    mkdir -p /backup/uploads && cp -ru /uploads/. /backup/uploads/
    find /backup -maxdepth 1 -name 'vms-*.archive.gz' -mtime +30 -delete
    echo "$(date) backup $day done" >> /backup/backup.log
  else
    echo "$(date) backup $day FAILED" >> /backup/backup.log
  fi
done
