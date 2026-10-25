# Console de suivi Clevoa. À construire depuis la racine du dépôt (elle réutilise clevoa-backend/handler.js pour lire la table) :
#   docker build -f clevoa-console/Dockerfile -t clevoa-console .
# Même image de base figée que le hub ; npm, corepack et yarn retirés de l'image d'exécution.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
WORKDIR /app/clevoa-console
COPY clevoa-console/package*.json ./
RUN npm ci --omit=dev \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY clevoa-backend/handler.js /app/clevoa-backend/handler.js
COPY clevoa-console/server.js clevoa-console/demo.js ./
COPY clevoa-console/public ./public
USER node
ENV NODE_ENV=production CONSOLE_PORT=8090
EXPOSE 8090
CMD ["node", "server.js"]
