# The image the demo tapes record in: Node for clausona's bundle, plus the real Claude Code.
# Built with network; the container that records runs with --network none.
FROM node:22-bookworm-slim

# Pinned so a re-recording shows the same Claude Code; demo.tape names this version too.
ARG CLAUDE_CODE_VERSION=2.1.284
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force
# seed.mjs marks this version's onboarding and release notes as seen.
ENV CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}
