FROM node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 AS manifests
# pnpm lives in the image so containers start without downloading it.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
WORKDIR /app
# Manifests land before the source tree so editing a source file does not re-run the
# install. pnpm gets a partial workspace: every package listed in pnpm-workspace.yaml
# needs its manifest below, or --frozen-lockfile fails. The store is a cache mount, so
# a lockfile change reuses whatever was already downloaded.
COPY --chmod=755 package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
# The first run fetches pnpm's native binary into COREPACK_HOME; the runtime, which may have no
# network, copies it from here.
RUN corepack install && pnpm --version >/dev/null && chmod -R a+rX "${COREPACK_HOME}"
COPY --chmod=755 patches patches
COPY --chmod=755 apps/api/package.json apps/api/
COPY --chmod=755 apps/cli/package.json apps/cli/
COPY --chmod=755 apps/desktop/package.json apps/desktop/
COPY --chmod=755 apps/mobile/package.json apps/mobile/
COPY --chmod=755 apps/web/package.json apps/web/
COPY --chmod=755 apps/worker/package.json apps/worker/
COPY --chmod=755 apps/www/package.json apps/www/
COPY --chmod=755 packages/adapter-kit/package.json packages/adapter-kit/
COPY --chmod=755 packages/adapters/package.json packages/adapters/
COPY --chmod=755 packages/auth/package.json packages/auth/
COPY --chmod=755 packages/chat-ui/package.json packages/chat-ui/
COPY --chmod=755 packages/contracts/package.json packages/contracts/
COPY --chmod=755 packages/core/package.json packages/core/
COPY --chmod=755 packages/db/package.json packages/db/
COPY --chmod=755 packages/i18n/package.json packages/i18n/
COPY --chmod=755 packages/logging/package.json packages/logging/
COPY --chmod=755 packages/memory/package.json packages/memory/
COPY --chmod=755 packages/page-kit/package.json packages/page-kit/
COPY --chmod=755 packages/testkit/package.json packages/testkit/
COPY --chmod=755 packages/ui-tokens/package.json packages/ui-tokens/
COPY --chmod=755 packages/ui-web/package.json packages/ui-web/
COPY --chmod=755 infra/sandboxes/supervisor/package.json infra/sandboxes/supervisor/
COPY --chmod=755 infra/updater/package.json infra/updater/
# Production dependencies get their own stage, built from the manifests alone, so the runtime's
# largest layer stays byte-identical until the lockfile changes and a deploy downloads only the
# app's own files.
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod \
  --store-dir=/pnpm/store --cpu=current --os=current \
  --filter="@rakazo/api..." --filter="@rakazo/worker..." \
  --filter="@rakazo/web..." --filter="@rakazo/sandbox-supervisor..."

FROM manifests AS build
# Only what the image runs (api, worker, web, supervisor) and the root build tools, with
# native binaries for this image's platform alone. Mobile, desktop and the marketing site
# never run here.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile \
  --store-dir=/pnpm/store --cpu=current --os=current \
  --filter=. --filter="@rakazo/api..." --filter="@rakazo/worker..." \
  --filter="@rakazo/web..." --filter="@rakazo/sandbox-supervisor..."
# Normalize modes: a restrictive host umask (e.g. 077 on hardened hosts) would otherwise
# leave the copied tree unreadable to USER node at runtime.
COPY --chmod=755 . .
RUN pnpm --filter @rakazo/db generate
RUN pnpm --filter @rakazo/api --filter @rakazo/worker build
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
# Build and test tooling stays here; the runtime takes its dependencies from the deps stage.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
  && rm -rf apps/desktop apps/mobile apps/www docs examples

# Bookworm's packaged SSH client still carries CVE-2026-60002. Build the portable
# client for the runtime ABI and verify the upstream release checksum before extraction.
FROM node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 AS ssh-client
RUN apt-get update && apt-get install -y --no-install-recommends libfido2-dev libedit-dev libkrb5-dev openssh-client
WORKDIR /build
RUN curl -fsSLo openssh.tar.gz https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-10.6p2.tar.gz \
  && echo '9ae44872090cf2f06b3cf9ff147e7f16f309671340763ed2f99248398ae29d5b  openssh.tar.gz' | sha256sum -c - \
  && tar -xzf openssh.tar.gz --strip-components=1
RUN ./configure --prefix=/usr --sysconfdir=/etc/ssh --libexecdir=/usr/lib/openssh \
      --with-kerberos5=/usr --with-libedit --with-security-key-builtin \
  && make -j2 ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan ssh-keysign ssh-pkcs11-helper ssh-sk-helper \
  && install -d /client/usr/bin /client/usr/lib/openssh /client/etc/ssh/ssh_config.d \
  && install -s ssh scp sftp ssh-add ssh-agent ssh-keygen ssh-keyscan /client/usr/bin/ \
  && install -s ssh-keysign ssh-pkcs11-helper ssh-sk-helper /client/usr/lib/openssh/ \
  && ln -s ssh /client/usr/bin/slogin \
  && install -m 0755 contrib/ssh-copy-id /client/usr/bin/ssh-copy-id \
  && install -m 0644 /etc/ssh/ssh_config /client/etc/ssh/ssh_config \
  && install -D -m 0644 LICENCE /client/usr/share/doc/openssh-client/copyright

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
COPY infra/sandboxes/computer/apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh
# Prisma's migration engine detects and links against OpenSSL. A stdio MCP server that runs on
# another machine is launched over ssh, which the slim base image does not ship.
# Sharp bundles the font libraries. Supply the configuration and fonts for plot labels.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends openssl libfido2-1 libedit2 libgssapi-krb5-2 fontconfig-config fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ssh-client /client/ /
RUN ssh -V && ssh -G localhost >/dev/null
# Managed stdio package installs need npm; the Node image bundles an older copy.
RUN npm install --global --ignore-scripts npm@11.21.2 && npm cache clean --force
ENV COREPACK_HOME=/usr/local/share/corepack
COPY --from=manifests /usr/local/share/corepack /usr/local/share/corepack
RUN corepack enable
WORKDIR /app
# --link keeps each layer independent of the ones below, so an unchanged one is reused as is.
COPY --link --from=deps /app /app
COPY --link --from=build /app /app
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp /app/apps/web/asset-archive /run/ingress
# Last root step, so a cached earlier layer cannot be the filesystem that ships.
RUN /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
ARG GIT_SHA
ENV NODE_ENV=production
ENV EMAIL_COPY_DIR=/app/email-copy
ENV GIT_SHA=$GIT_SHA
EXPOSE 3100 5173 7091
# The signal on which a replaced API lets its chat turns end before it exits (apps/api/src/http/drain.ts).
# deploy-main.sh sends it only to an API whose image names one.
LABEL org.rakazo.run-drain-signal=SIGUSR2
USER node
CMD ["pnpm", "--filter", "@rakazo/api", "start"]
