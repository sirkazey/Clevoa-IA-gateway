#!/bin/sh
# Restauration du hub : remet une sauvegarde dans le volume Docker, hub arrêté, puis le redémarre.
# Usage : ops/restore.sh <fichier de sauvegarde>   (users-*.json : collaborateurs et jetons ; hub-*.db : base d'exploitation, 1.5 et plus)
# Variables : VOLUME=<nom du volume>, CONTAINER=<nom du conteneur du hub> si la détection automatique échoue. Le conteneur retenu
# doit monter le volume retenu : toute incohérence est refusée avant d'arrêter le hub ou de toucher aux données.
# Fichiers acceptés : toute sauvegarde users-*.json du hub (quotidienne users-AAAA-MM-JJ.json, manuelle ou horodatée _HHMMSS) ;
# seul le contenu compte (en-tête enc1:). Ou une sauvegarde hub-*.db de la base d'exploitation (en-tête SQLite) : historique de
# disponibilité, compteurs d'usage, journal d'audit ; users.json n'est pas touché. Les deux se restaurent indépendamment.
# Prérequis : la MÊME ENCRYPTION_KEY que lors de la sauvegarde dans le .env (ou les variables de la stack Portainer).
# À lancer avec sudo (accès au démon Docker, sauvegardes automatiques appartenant à root) depuis n'importe quel dossier.
set -eu
IMAGE=node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53   # même image figée que le hub
FILE=${1:?Usage : sudo ops/restore.sh <sauvegarde users-AAAA-MM-JJ….json ou hub-AAAA-MM-JJ….db>}
[ -f "$FILE" ] || { echo "Fichier introuvable : $FILE" >&2; exit 1; }
[ -r "$FILE" ] || { echo "Fichier illisible ($FILE) : les sauvegardes automatiques appartiennent à root, lancer avec sudo." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker inaccessible : lancer avec sudo (ou depuis un compte du groupe docker)." >&2; exit 1; }
if [ "$(head -c 5 "$FILE")" = "enc1:" ]; then TARGET=users.json
elif [ "$(head -c 15 "$FILE")" = "SQLite format 3" ]; then TARGET=hub.db
else echo "Ce fichier n'est ni une sauvegarde chiffrée du hub (en-tête enc1:) ni une base d'exploitation (en-tête SQLite)" >&2; exit 1; fi
VOL=${VOLUME:-$(docker volume ls -q --filter name=mcp-data)}
[ -n "$VOL" ] || { echo "Aucun volume mcp-data : démarrer le hub une première fois, puis relancer." >&2; exit 1; }
[ "$(printf '%s\n' "$VOL" | wc -l)" -eq 1 ] || { echo "Plusieurs volumes trouvés : $(printf '%s ' $VOL). Relancer avec sudo VOLUME=<nom> ops/restore.sh <fichier>." >&2; exit 1; }
CONT=${CONTAINER:-$(docker ps -a -q --filter name=mcp-hub --filter volume="$VOL")}   # le conteneur mcp-hub qui monte CE volume
[ "$(printf '%s\n' "$CONT" | grep -c .)" -le 1 ] || { echo "Plusieurs conteneurs mcp-hub montent $VOL : $(docker ps -a --filter name=mcp-hub --filter volume="$VOL" --format '{{.Names}}' | tr '\n' ' '). Relancer avec sudo CONTAINER=<nom> ops/restore.sh <fichier>." >&2; exit 1; }
if [ -n "$CONT" ]; then
  MOUNTS=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$CONT" 2>/dev/null) || { echo "Conteneur introuvable : $CONT" >&2; exit 1; }
  case " $MOUNTS" in *" $VOL "*) ;; *) echo "Incohérence : le conteneur $(docker inspect -f '{{.Name}}' "$CONT" | sed 's|^/||') ne monte pas le volume $VOL (volumes montés : ${MOUNTS:-aucun}). Rien n'a été modifié ; vérifier VOLUME et CONTAINER." >&2; exit 1;; esac
fi
DIR=$(cd "$(dirname "$FILE")" && pwd); NAME=$(basename "$FILE")
if [ -n "$CONT" ]; then docker stop "$CONT" >/dev/null; echo "Hub arrêté."; trap '[ -n "$CONT" ] && docker start "$CONT" >/dev/null 2>&1; echo "Hub relancé après interruption." >&2' EXIT; else echo "Aucun conteneur mcp-hub trouvé : restauration du volume seul."; fi
# Copie vérifiée vers un fichier temporaire du volume, PUIS seulement mise de côté de l'ancien fichier sous <fichier>.avant-restauration
# (un seul niveau, écrasé à la restauration suivante ; pour hub.db, son journal WAL le suit, jamais appliqué à la base restaurée) et
# publication. Un échec (disque plein, copie illisible) laisse le volume intact. Noms passés en arguments, jamais interprétés par le shell.
if ! docker run --rm -v "$VOL:/data" -v "$DIR:/b:ro" "$IMAGE" sh -c '
  set -e; cd /data; t="$1"; tmp="$t.restauration.tmp"
  if ! cp "/b/$2" "$tmp" || ! cmp -s "/b/$2" "$tmp"; then rm -f "$tmp"; exit 1; fi
  rm -f "$t.avant-restauration-wal" "$t.avant-restauration-shm" "$t-shm"
  if [ -f "$t" ]; then mv "$t" "$t.avant-restauration"; fi
  if [ -f "$t-wal" ]; then mv "$t-wal" "$t.avant-restauration-wal"; fi
  mv "$tmp" "$t"
  chown node:node "$t" "$t".avant-restauration* 2>/dev/null || true; chmod 600 "$t" "$t".avant-restauration* 2>/dev/null || true' sh "$TARGET" "$NAME"; then
  echo "Restauration impossible (copie dans le volume en échec : disque plein ?). Rien n'a été modifié." >&2; exit 1
fi
echo "Fichier restauré dans le volume $VOL ($TARGET)."
[ -n "$CONT" ] || exit 0
trap - EXIT
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # seuls les journaux postérieurs au redémarrage comptent (un hub qui bouclait avant garde ses anciens messages)
docker start "$CONT" >/dev/null; echo "Hub redémarré, vérification (30 s au plus)…"
i=0; while [ $i -lt 30 ]; do
  sleep 1; i=$((i + 1)); LOGS=$(docker logs --since "$SINCE" "$CONT" 2>&1)
  if [ "$TARGET" = hub.db ] && printf '%s' "$LOGS" | grep -q "base d'exploitation indisponible"; then echo "ÉCHEC : hub.db restaurée illisible (voir docker logs $CONT) ; le hub fonctionne sans historique ni compteurs. L'ancienne base est dans le volume : hub.db.avant-restauration." >&2; exit 1; fi
  if [ "$TARGET" = users.json ] && printf '%s' "$LOGS" | grep -q "users.json illisible"; then echo "ÉCHEC : users.json illisible, ENCRYPTION_KEY différente de celle de la sauvegarde. L'ancien fichier est dans le volume : users.json.avant-restauration." >&2; exit 1; fi
  if printf '%s' "$LOGS" | grep -q "Hub MCP v"; then echo "OK : le hub a démarré avec les données restaurées."; exit 0; fi
done
echo "Le hub n'a pas annoncé son démarrage en 30 s : voir docker logs $CONT (clé absente, PUBLIC_URL, port…)." >&2; exit 1
