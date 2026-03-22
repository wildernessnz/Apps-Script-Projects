FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Cloud Run sets PORT automatically
ENV PORT=8080

CMD ["node", "index.js"]
