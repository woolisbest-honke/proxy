FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib

# プラットフォームが PORT を渡すため、ここでの EXPOSE は目安
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
