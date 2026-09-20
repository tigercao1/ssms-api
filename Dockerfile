# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=24.16.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="NestJS"

# NestJS app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci --include=dev

# Copy application code
COPY . .

# Build application
RUN npm run build


# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app /app

# Drop dev dependencies (Nest CLI, TypeScript, Jest) — the compiled app in
# dist/ only needs runtime deps. Smaller image, faster boot.
RUN npm prune --omit=dev

# Start the COMPILED app. Do NOT use `npm run start` (= `nest start`), which is
# the dev command: it recompiles via the Nest CLI at boot and blows past the
# health-check grace period on a 256MB machine.
EXPOSE 3000
CMD [ "node", "dist/main" ]
