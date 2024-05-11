FROM node:18 as build

WORKDIR /microsoft-rewards-script

RUN apt-get update && apt-get install -y git

RUN git clone https://github.com/murilopereirame/Microsoft-Rewards-Script.git .

# Install necessary dependencies for Playwright and cron
RUN apt-get install -y \
    jq \
    cron \
    gettext-base \
    xvfb \
    libgbm-dev \
    libnss3 \
    libasound2 \
    libxss1 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    tzdata \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies, set permissions, and build the script
RUN npm install && \
    chmod -R 755 /microsoft-rewards-script/node_modules && \
    npm run pre-build && \
    npm run build

RUN npm prune --production

# Install playwright chromium
RUN npx playwright install chromium

RUN ln -s /config/config.json ./dist/config.json
RUN ln -s /config/accounts.json ./dist/accounts.json

# Define the command to run your application
CMD ["node", "dist/index.js"]
