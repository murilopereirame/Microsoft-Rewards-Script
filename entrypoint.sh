#!/bin/bash

set -e

echo "$TZ" > /etc/timezone
ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
dpkg-reconfigure -f noninteractive tzdata

Xvfb :99 -screen 0 1280x720x16 &
export DISPLAY=:99
sleep 2

fluxbox &

x11vnc -display :99 -nopw -forever &

envsubst < /etc/cron.d/microsoft-rewards-cron.template > /etc/cron.d/microsoft-rewards-cron
chmod 0644 /etc/cron.d/microsoft-rewards-cron
crontab /etc/cron.d/microsoft-rewards-cron
cron

if [ "$RUN_ON_START" = "true" ]; then
  npm start
fi

tail -f /var/log/cron.log
