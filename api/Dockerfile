# The budget API.
#
# No build step: Node strips TypeScript types at load, so what runs on the NAS is
# the same source you edited. That removes a whole class of "works locally" bugs
# and there is nothing to keep in sync.

# Which build this is, for Settings and /api/health. This stage sees the whole
# context, .git included when the build has one, and writes version.json: the
# package version, the commit and its date, and when the image was built. Only
# that file is copied out below, so nothing else from .git reaches the image.
# A build from a GitHub URL keeps .git only with BUILDKIT_CONTEXT_KEEP_GIT_DIR
# (docker.yml sets it); without .git the commit and its date are null.
# safe.directory because the copied checkout belongs to another user than git
# runs as, which git otherwise refuses to read.
FROM node:26-alpine AS meta
RUN apk add --no-cache git
COPY . /src
RUN set -e; cd /src; \
    version=$(node -p "require('./api/package.json').version"); \
    commit=null; commitDate=null; \
    if [ -e .git ] && sha=$(git -c safe.directory='*' rev-parse HEAD 2>/dev/null); then \
      commit="\"$(echo "$sha" | cut -c1-7)\""; \
      commitDate="\"$(git -c safe.directory='*' log -1 --format=%cI)\""; \
    fi; \
    printf '{"version":"%s","commit":%s,"commitDate":%s,"builtAt":"%s"}\n' \
      "$version" "$commit" "$commitDate" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /version.json; \
    cat /version.json

FROM node:26-alpine

ENV NODE_ENV=production

# su-exec drops from root to node at start; see docker-entrypoint.sh.
RUN apk add --no-cache su-exec

WORKDIR /app

# Dependencies first, so editing source does not reinstall them.
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev

COPY api/tsconfig.json ./
COPY api/src ./src

# Copied after the dependencies and the source, so a new version.json (every
# build has a new build time) never makes npm ci run again. src/version.ts
# reads it from beside package.json.
COPY --from=meta /version.json ./version.json

# The app shell ships with the image so a deploy updates both halves at once.
# .dockerignore keeps site/*.jsonl out — budget.jsonl and transactions.jsonl are
# household data, not assets, and have no business inside a container image.
COPY site ./site
ENV SITE_DIR=/app/site

# The log lives on a mounted volume, not in the image. It is the only state that
# has to survive: everything else is a replay of it. A bind mount hides this
# directory's owner, so the entrypoint below gives the mounted one to node too.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
ENV LOG_PATH=/data/events.jsonl

# One directory per household, beside the log. Set here as well as in compose so
# the image is right on its own: the default is relative to /app, which lives in
# the image and is not writable by the unprivileged user the app runs as —
# households would fail to write, or quietly disappear on the next deploy.
ENV HOUSEHOLDS_DIR=/data/households

# Who is signed in, on the volume so a redeploy does not sign everyone out.
# Hashes of session tokens, never the tokens: nothing in it works as a cookie.
ENV SESSIONS_PATH=/data/sessions.json

# The NAS's connections (Connectors), beside the sessions and outside
# HOUSEHOLDS_DIR. Holds secrets, so the app keeps it mode 0600. The default is
# relative to /app, which is inside the image and not writable by the app's user.
ENV CONNECTORS_PATH=/data/connectors.json

# The local-bypass sandbox. Somewhere writable, ephemeral, and pointedly not the
# volume above: signing in without DSM gets you the whole app and none of the
# household's money, and the sandbox is discarded when the container restarts.
ENV DEV_LOG_PATH=/tmp/dev-events.jsonl

# The app never runs as root. A container that can only append to one file is
# a much smaller problem than one that can rewrite the app it is running. The
# container starts as root only so the entrypoint can make /data node's (a
# folder made in DSM's File Station belongs to the account that made it), then
# it runs the command below as node. Named apart from the base image's own
# docker-entrypoint.sh, which it replaces.
COPY api/docker-entrypoint.sh /usr/local/bin/planner-entrypoint.sh
RUN chmod 0755 /usr/local/bin/planner-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/planner-entrypoint.sh"]

EXPOSE 8090
ENV PORT=8090

# /api/health is deliberately the one route before the auth check, so the
# healthcheck does not need a credential and a failing proxy cannot mask a
# failing process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/server.ts"]
