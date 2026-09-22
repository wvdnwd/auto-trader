module.exports = {
  apps: [
    {
      name: 'traderr',
      script: './start-traderr.sh',
      cwd: __dirname,
      interpreter: '/bin/bash',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 100,
      watch: false,
      max_memory_restart: '1G',
      out_file: './logs/bot-out.log',
      error_file: './logs/bot-err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        FUTURES_API_BASE: 'https://contract.mexc.com/api/v1/contract',
      },
    },
  ],
};
