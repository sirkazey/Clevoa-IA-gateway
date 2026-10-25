# Image de base figée par empreinte (Node 24.22.1, version de sécurité, vérifiée le 25/10/2026) : une version publiée se reconstruit avec la même
# base. Empreinte remplacée par une version corrective quand l'image Node reçoit un correctif de sécurité (docs/admin/installation.md § 6).
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
ENV PORT=4000
EXPOSE 4000
CMD ["node", "server.js"]
