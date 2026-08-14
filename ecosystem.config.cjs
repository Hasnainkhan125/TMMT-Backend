module.exports = {
  apps: [
    {
      name: 'qumak-backend',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 5001
      },
      error_file: 'logs/server-error.log',
      out_file: 'logs/server-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'qumak-studio-worker',
      script: 'workers/videoWorker.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '800M',
      autorestart: true,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/worker-error.log',
      out_file: 'logs/worker-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
