FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY server.mjs ./
COPY data ./data
EXPOSE 8080
CMD ["node", "server.mjs"]
