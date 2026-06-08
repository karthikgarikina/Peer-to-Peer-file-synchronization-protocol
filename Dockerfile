FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN apk add --no-cache curl
# Ensure sync dir exists
RUN mkdir -p /app/sync_dir
CMD ["node", "src/index.js"]
