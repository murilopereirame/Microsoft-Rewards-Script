# Use an official Node.js runtime as a base image
FROM node:18

# Set the working directory in the container
WORKDIR /usr/src/microsoft-rewards-script

# Install necessary dependencies for Playwright and cron
RUN apt-get update && apt-get install -y \
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
    x11vnc \
    xvfb \
    fluxbox \
    && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:99

# Copy all files to the working directory
COPY . .

# Install dependencies, set permissions, and build the script
RUN npm install && \
    chmod -R 755 /usr/src/microsoft-rewards-script/node_modules && \
    npm run pre-build && \
    npm run build

RUN npx playwright install firefox

# Copy cron file to cron directory
COPY src/crontab.template /etc/cron.d/microsoft-rewards-cron.template

# Create the log file to be able to run tail
RUN touch /var/log/cron.log

EXPOSE 5900

# Define the command to run your application with cron optionally

RUN chmod +x entrypoint.sh
CMD ["sh", "entrypoint.sh"]