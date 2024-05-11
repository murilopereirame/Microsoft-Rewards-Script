FROM node:lts-alpine as build

WORKDIR /microsoft-rewards-script

RUN apk add --update --no-cache git

RUN git clone https://github.com/murilopereirame/Microsoft-Rewards-Script.git .

# Install dependencies including Playwright
RUN apk add --update --no-cache \
    xvfb \
    mesa-gbm \
    nss \
    alsa-lib \
    libxscrnsaver \
    libatk-bridge-2.0 \
    gtk+3.0

RUN npm install

RUN npm run build

RUN npm prune --production

RUN mkdir production && cp -a dist node_modules package.json "./production"

FROM node:lts-alpine

WORKDIR /usr/src/microsoft-rewards-script

COPY --from=build /microsoft-rewards-script/production /usr/src/microsoft-rewards-script

# Install playwright chromium
RUN npx playwright install chromium

RUN ln -s /config/config.json ./dist/config.json
RUN ln -s /config/accounts.json ./dist/accounts.json

# Define the command to run your application
CMD ["node", "dist/index.js"]
