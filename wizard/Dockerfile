FROM node:22-alpine

# The wizard reuses the project's existing doctor/import/migrate scripts, which
# operate the same Compose project through the mounted Docker socket.
RUN apk add --no-cache \
    bash \
    coreutils \
    curl \
    docker-cli \
    docker-cli-compose \
    python3

WORKDIR /app
COPY wizard ./wizard

EXPOSE 8787
CMD ["node", "wizard/server.mjs"]
