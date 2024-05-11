FROM node:lts

WORKDIR /microsoft-rewards-script

RUN apk add --update --no-cache git

RUN git clone https://github.com/murilopereirame/Microsoft-Rewards-Script.git .

# Install dependencies including Playwright
RUN apt-get install -y \
    xvfb \
    libgbm-dev \
    libnss3 \
    libasound2 \
    libxss1 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install

RUN npm run build

RUN npm prune --production

# Install playwright chromium
RUN npx playwright install chromium

RUN ln -s /config/config.json ./dist/config.json
RUN ln -s /config/accounts.json ./dist/accounts.json

# Define the command to run your application
CMD ["node", "dist/index.js"]
