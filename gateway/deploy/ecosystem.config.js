'use strict';

/* pm2 process definition for the gateway. Reads /etc/local-tester-gateway.env
   (or GATEWAY_ENV_FILE) itself, with no dotenv dependency, so it re-reads the
   file fresh on every `pm2 start`/`pm2 restart ecosystem.config.js` — editing
   the env file and re-running deploy-pm2.sh is enough to pick up new values. */

const fs = require('fs');

const ENV_FILE = process.env.GATEWAY_ENV_FILE || '/etc/local-tester-gateway.env';

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    return env;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

module.exports = {
  apps: [
    {
      name: 'local-tester-gateway',
      script: './dist/index.js',
      // This file is deployed to /opt/local-tester-gateway/ecosystem.config.js,
      // alongside dist/, so __dirname is the app root and script resolves correctly.
      cwd: __dirname,
      env: loadEnvFile(ENV_FILE),
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      // Loopback-bound already enforced in gateway/src/index.ts; pm2 just supervises the process.
      out_file: '/var/log/local-tester-gateway/out.log',
      error_file: '/var/log/local-tester-gateway/error.log',
      time: true
    }
  ]
};
