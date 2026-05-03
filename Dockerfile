FROM node:22-bookworm

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl git build-essential && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@latest

WORKDIR /app
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8080
CMD ["./entrypoint.sh"]
