FROM node:26-alpine

LABEL maintainer="Aleksandr Popov <mogadanez@gmail.com>"

WORKDIR /sqsd

# Install dependencies (reproducible install from package-lock.json)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy sqsd source
COPY ./ /sqsd

# Run sqsd
CMD ["node", "run-cli.js"]
