FROM node:26-alpine

LABEL maintainer="Aleksandr Popov <mogadanez@gmail.com>"

ENV NODE_ENV=production

WORKDIR /sqsd

# Install dependencies (reproducible install from package-lock.json)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy sqsd source
COPY ./ /sqsd

# Drop the root privileges kept for the install step
USER node

# Run sqsd
CMD ["node", "run-cli.js"]
