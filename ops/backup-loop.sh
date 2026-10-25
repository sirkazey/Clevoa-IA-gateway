#!/bin/sh
# Sauvegarde automatique (conteneur mcp-backup) : au démarrage puis toutes les 24 h, copie dans /backups sous un nom horodaté, jamais
# écrasé : users.json (chiffré) en users-AAAA-MM-JJ_HHMMSS.json, et l'instantané de la base d'exploitation (hub-instantane.db, écrit
# par le hub chaque heure par la sauvegarde à chaud de SQLite) en hub-AAAA-MM-JJ_HHMMSS.db. Un fichier inchangé depuis sa dernière
# sauvegarde n'est pas recopié : un redémarrage du conteneur ne crée pas de doublon. La copie passe par un fichier temporaire vérifié
# (en-tête, taille, contenu identique) puis publié atomiquement ; une source absente ou invalide ne touche à rien. Rétention : fichiers
# de plus de BACKUP_KEEP_DAYS jours supprimés seulement après une copie réussie du même type, jamais la plus récente.
# Variables de test : SRC, DB_SRC, DEST (chemins), ONCE=1 (une seule passe ; code de retour 0 = users.json sauvegardé ou inchangé et
# instantané sauvegardé, inchangé ou pas encore écrit, 1 = l'un des deux refusé).
SRC=${SRC:-/data/users.json}; DB_SRC=${DB_SRC:-/data/hub-instantane.db}; DEST=${DEST:-/backups}; KEEP=${BACKUP_KEEP_DAYS:-30}; MIN_BYTES=64
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
# copy <source> <préfixe> <extension> <en-tête attendu> <libellé>
copy() {
  src=$1; prefix=$2; ext=$3; magic=$4; what=$5
  find "$DEST" -name "$prefix-*.$ext.tmp" -mmin +10 -delete 2>/dev/null   # restes d'une interruption antérieure
  if [ "$(head -c ${#magic} "$src")" != "$magic" ] || [ "$(wc -c < "$src")" -lt "$MIN_BYTES" ]; then
    log "$what invalide (en-tête ou taille) : sauvegarde refusée, les précédentes sont conservées"; return 1
  fi
  last=$(ls -1 "$DEST"/"$prefix"-*."$ext" 2>/dev/null | sort | tail -n 1)
  if [ -n "$last" ] && cmp -s "$src" "$last"; then log "$what inchangé depuis $(basename "$last") : rien à écrire"; return 0; fi
  stamp=$(date +%Y-%m-%d_%H%M%S); name="$prefix-$stamp.$ext"; n=0
  while [ -e "$DEST/$name" ]; do n=$((n + 1)); name="$prefix-$stamp-$n.$ext"; done   # jamais d'écrasement, même dans la même seconde
  tmp="$DEST/$name.tmp"
  if ! cp "$src" "$tmp" || ! cmp -s "$src" "$tmp"; then rm -f "$tmp"; log "copie échouée : $name non publié, les précédentes sont conservées"; return 1; fi
  mv "$tmp" "$DEST/$name" || { rm -f "$tmp"; log "publication échouée : $name, les précédentes sont conservées"; return 1; }
  log "sauvegarde $name ($(wc -c < "$DEST/$name") octets)"
  find "$DEST" -name "$prefix-*.$ext" ! -name "$name" -mtime "+$KEEP" -delete 2>/dev/null   # rétention, seulement après une copie réussie
  return 0
}
backup() {
  rc=0
  if [ -f "$SRC" ]; then copy "$SRC" users json "enc1:" users.json || rc=1
  else log "users.json absent : ni collaborateur connecté ni télémétrie active, rien à sauvegarder"; rc=1; fi
  # Base d'exploitation (1.5 et plus) : absente avant la première heure de fonctionnement ou sur une version antérieure, ce n'est pas une erreur.
  if [ -f "$DB_SRC" ]; then copy "$DB_SRC" hub db "SQLite format 3" "hub-instantane.db" || rc=1
  else log "hub-instantane.db absent : pas encore d'instantané de la base d'exploitation"; fi
  return $rc
}
if [ "${ONCE:-}" = "1" ]; then backup; exit $?; fi
trap 'exit 0' TERM INT
while :; do backup; sleep 86400 & wait $!; done
