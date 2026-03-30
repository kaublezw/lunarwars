module.exports = {
  apps: [{
    name: 'lunarwars-ws',
    cwd: '/opt/lunarwars/server',
    script: 'node_modules/.bin/tsx',
    args: 'server.ts',
    env: {
      PORT: 8080,
      NODE_ENV: 'production',
    },
    max_memory_restart: '200M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
