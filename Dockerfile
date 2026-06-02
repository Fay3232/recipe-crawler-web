FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV DATA_DIR=/app/data

COPY . .

RUN mkdir -p /app/data

EXPOSE 4173

CMD ["node", "server.js"]
