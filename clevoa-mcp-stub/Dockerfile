# Image de base figée par empreinte (Node 24.22.1, version de sécurité, vérifiée le 25/10/2026) : une version publiée se reconstruit avec la même
# base. Empreinte remplacée par une version corrective quand l'image Node reçoit un correctif de sécurité (docs/admin/installation.md § 6).
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
ENV PORT=4000 NODE_ENV=production
EXPOSE 4000
CMD ["node", "server.js"]
