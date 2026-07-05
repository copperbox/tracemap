FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Provision Playwright's Chromium and its OS dependencies while we are still
# root. The web-UI verification the implementer needs (libnss3, the GTK/ATK
# chain, wayland libs, ...) requires apt + a browser download — steps a non-root
# agent cannot do at runtime. Baking them in turns "bootstrap a browser from
# scratch" (which previously exhausted an agent's whole context) into a no-op.
#
# The browser lands in a shared, world-accessible PLAYWRIGHT_BROWSERS_PATH so
# the agent user finds it; PLAYWRIGHT_VERSION is pinned so the agent installs a
# matching Playwright JS package (see .sandcastle/implement-prompt.md). Keep the
# two envs in sync with any bump.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_VERSION=1.49.1
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
  && chmod -R a+rwX /ms-playwright \
  && rm -rf /var/lib/apt/lists/*

# Install uv system-wide (as root) so it lands on the default PATH and is
# available to the agent user regardless of $HOME. Installing it after the
# USER switch is fragile: uv installs to $HOME/.local/bin, and the value of
# $HOME after `USER` depends on the builder, so uv can end up off-PATH.
RUN curl -LsSf https://astral.sh/uv/install.sh \
  | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Pin HOME so per-user installs (Claude CLI, `uv tool install`, graphify)
# reliably land in /home/agent/.local/bin, which is added to PATH below.
ENV HOME=/home/agent

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# Install Graphify (uv is already installed system-wide above).
RUN uv tool install graphifyy
RUN graphify install --project && graphify claude install

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
