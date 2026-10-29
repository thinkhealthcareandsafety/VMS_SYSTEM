#!/bin/bash
# Put the database and photos back from the backup drive, after a damaged disk, a new PC or a serious mistake.
#   sudo bash deploy/restore.sh                      the latest backup
#   sudo bash deploy/restore.sh 2026-10-28           that night's backup
# Safe to run: the database as it is now is saved first (before-restore-*.archive.gz on the backup drive), so a restore
# can itself be undone with:  sudo bash deploy/restore.sh before-restore-<time>
# Photos are copied back without overwriting any photo already on the PC.
set -euo pipefail
cd "$(dirname "$0")"
BACKUP_DIR=$(grep -E '^BACKUP_DIR=' .env 2>/dev/null | cut -d= -f2- || true)
BACKUP_DIR=${BACKUP_DIR:-/mnt/vms-backup}
DATA_DIR=$(grep -E '^DATA_DIR=' .env 2>/dev/null | cut -d= -f2- || true)
DATA_DIR=${DATA_DIR:-/srv/vms/data}
C="docker compose -f docker-compose.yml"

[ "$(id -u)" = 0 ] || { echo "Run it with sudo: sudo bash deploy/restore.sh"; exit 1; }
pick=${1:-}
if [ -z "$pick" ]; then archive=$(ls -1t "$BACKUP_DIR"/vms-*.archive.gz 2>/dev/null | head -1 || true)
elif [ -f "$pick" ]; then archive=$pick
elif [ -f "$BACKUP_DIR/vms-$pick.archive.gz" ]; then archive="$BACKUP_DIR/vms-$pick.archive.gz"
elif [ -f "$BACKUP_DIR/$pick.archive.gz" ]; then archive="$BACKUP_DIR/$pick.archive.gz"
else archive=""; fi
[ -n "$archive" ] && [ -f "$archive" ] || { echo "No backup found${pick:+ for $pick} in $BACKUP_DIR. Backups there:"; ls -1 "$BACKUP_DIR"/*.archive.gz 2>/dev/null || echo "  (none)"; exit 1; }

echo "This puts the database back as it was in: $(basename "$archive") ($(date -r "$archive" '+%d %b %Y %H:%M'))."
echo "Everything entered after that is replaced. The database as it is now is saved first."
read -r -p "Type RESTORE to go ahead: " ok
[ "$ok" = RESTORE ] || { echo "Nothing changed."; exit 1; }

stamp=$(date +%Y%m%d-%H%M)
echo "1/4 Saving the database as it is now: $BACKUP_DIR/before-restore-$stamp.archive.gz"
$C exec -T mongo mongodump --quiet --gzip --archive > "$BACKUP_DIR/before-restore-$stamp.archive.gz.part"
mv "$BACKUP_DIR/before-restore-$stamp.archive.gz.part" "$BACKUP_DIR/before-restore-$stamp.archive.gz"

echo "2/4 Stopping the app, so nothing is entered during the restore"
$C stop app >/dev/null

echo "3/4 Restoring the database"
if ! $C exec -T mongo mongorestore --quiet --drop --gzip --archive < "$archive"; then
  echo "The restore failed. Putting back the database as it was..."
  $C exec -T mongo mongorestore --quiet --drop --gzip --archive < "$BACKUP_DIR/before-restore-$stamp.archive.gz"
  $C start app >/dev/null
  echo "Back as it was. Call GateSmartX."; exit 1
fi

echo "4/4 Copying back any photos missing on this PC"
if [ -d "$BACKUP_DIR/uploads" ]; then
  mkdir -p "$DATA_DIR/uploads"
  owner=$(stat -c %u:%g "$DATA_DIR/uploads")
  cp -rn "$BACKUP_DIR/uploads/." "$DATA_DIR/uploads/"
  chown -R "$owner" "$DATA_DIR/uploads"
else
  echo "    No photos on the backup drive (no drive was connected when it was taken)."
fi
$C start app >/dev/null
sleep 5
echo "Done. Visits in the database now: $($C exec -T mongo mongosh --quiet vms --eval 'db.visits.countDocuments()')"
[ -f "$BACKUP_DIR/server-settings.env" ] && echo "On a new PC: the server settings (with the ID encryption key) are in $BACKUP_DIR/server-settings.env. Copy them to deploy/.env before installing."
exit 0
