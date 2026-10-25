# Image de base figée par empreinte (Node 24.22.1, version de sécurité, vérifiée le 25/10/2026) : une version publiée se reconstruit avec la même
# base. Empreinte remplacée par une version corrective quand l'image Node reçoit un correctif de sécurité (docs/admin/installation.md § 6).
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
ENV PORT=4000
EXPOSE 4000
CMD ["node", "server.js"]
