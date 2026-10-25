#!/bin/sh
# Sauvegarde manuelle du hub : copie users.json (chiffré AES-256-GCM) depuis le volume Docker vers un dossier, et l'instantané
# de la base d'exploitation (hub-instantane.db, écrit chaque heure par le hub 1.5 et plus) en hub-AAAA-MM-JJ_HHMMSS.db s'il existe.
# Usage : ops/backup.sh [dossier]        (défaut : BACKUP_DIR ou ./backups)
# Variables : sudo VOLUME=<nom du volume> ops/backup.sh … si plusieurs volumes mcp-data existent sur la machine (VOLUME après sudo :
# sudo ne transmet pas les variables posées avant lui).
# Le fichier est inutilisable sans ENCRYPTION_KEY (fichier .env ou variables de la stack) : la garder À PART des sauvegardes.
# À lancer avec sudo (accès au démon Docker) depuis n'importe quel dossier, Portainer ou non.
set -eu
IMAGE=node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53   # même image figée que le hub
docker info >/dev/null 2>&1 || { echo "Docker inaccessible : lancer avec sudo (ou depuis un compte du groupe docker)." >&2; exit 1; }
DEST=${1:-${BACKUP_DIR:-./backups}}
VOL=${VOLUME:-$(docker volume ls -q --filter name=mcp-data)}
[ -n "$VOL" ] || { echo "Aucun volume mcp-data : le hub n'a jamais démarré sur cette machine." >&2; exit 1; }
[ "$(printf '%s\n' "$VOL" | wc -l)" -eq 1 ] || { echo "Plusieurs volumes trouvés : $(printf '%s ' $VOL). Relancer avec sudo VOLUME=<nom> ops/backup.sh." >&2; exit 1; }
OWNER="${SUDO_UID:-$(id -u)}:${SUDO_GID:-$(id -g)}"   # sous sudo, le fichier (et le dossier créé) appartiennent à l'administrateur, pas à root
if [ ! -d "$DEST" ]; then mkdir -p "$DEST"; chown "$OWNER" "$DEST"; fi
STAMP=$(date +%Y-%m-%d_%H%M%S); NAME="users-$STAMP.json"; DBNAME="hub-$STAMP.db"; n=0
while [ -e "$DEST/$NAME" ] || [ -e "$DEST/$DBNAME" ]; do n=$((n + 1)); NAME="users-$STAMP-$n.json"; DBNAME="hub-$STAMP-$n.db"; done   # jamais d'écrasement
# Copie faite en root dans le conteneur (le volume appartient à l'utilisateur node, en 700), via un fichier temporaire vérifié puis publié.
docker run --rm -v "$VOL:/data:ro" -v "$(cd "$DEST" && pwd):/backups" "$IMAGE" \
  sh -c "[ -f /data/users.json ] || { echo 'users.json absent : ni collaborateur connecté ni télémétrie active, rien à sauvegarder' >&2; exit 2; }
         [ \"\$(head -c 5 /data/users.json)\" = enc1: ] || { echo 'users.json invalide (en-tête enc1: absent) : rien n est écrit' >&2; exit 3; }
         cp /data/users.json /backups/$NAME.tmp && cmp -s /data/users.json /backups/$NAME.tmp && chown $OWNER /backups/$NAME.tmp && chmod 600 /backups/$NAME.tmp && mv /backups/$NAME.tmp /backups/$NAME || { rm -f /backups/$NAME.tmp; exit 4; }
         [ -f /data/hub-instantane.db ] || exit 0
         [ \"\$(head -c 15 /data/hub-instantane.db)\" = 'SQLite format 3' ] || { echo 'hub-instantane.db invalide (en-tête SQLite absent) : base d exploitation non sauvegardée' >&2; exit 0; }
         cp /data/hub-instantane.db /backups/$DBNAME.tmp && cmp -s /data/hub-instantane.db /backups/$DBNAME.tmp && chown $OWNER /backups/$DBNAME.tmp && chmod 600 /backups/$DBNAME.tmp && mv /backups/$DBNAME.tmp /backups/$DBNAME || { rm -f /backups/$DBNAME.tmp; echo 'copie de hub-instantane.db échouée' >&2; }"
[ "$(head -c 5 "$DEST/$NAME")" = "enc1:" ] || { echo "Sauvegarde invalide : le fichier n'est pas chiffré au format attendu" >&2; exit 1; }
echo "Sauvegarde écrite : $DEST/$NAME ($(wc -c < "$DEST/$NAME") octets, chiffrée). Conserver ENCRYPTION_KEY séparément."
[ -f "$DEST/$DBNAME" ] && echo "Base d'exploitation : $DEST/$DBNAME (instantané de moins de 6 heures)." || echo "Base d'exploitation : non sauvegardée (voir le message ci-dessus ; sans message : hub antérieur à 1.5 ou démarré depuis moins d'une minute)."
exit 0
