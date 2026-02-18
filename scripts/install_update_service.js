const path = require('path');
const { Service } = require('node-windows');

const serviceScript = path.join(__dirname, '..', 'service', 'updater-service.js');

const svc = new Service({
  name: 'LiveScreenShareUpdaterService',
  description: 'Background updater service for Live Screen Share Desktop',
  script: serviceScript,
  wait: 2,
  grow: 0.5,
  maxRetries: 100,
  env: [
    { name: 'RELEASE_OWNER', value: process.env.RELEASE_OWNER || 'AgentIsComing' },
    { name: 'RELEASE_REPO', value: process.env.RELEASE_REPO || 'live-screen-share-releases' }
  ]
});

svc.on('install', () => {
  console.log('Updater service installed. Starting...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('Updater service already installed.');
  svc.start();
});

svc.on('start', () => {
  console.log('Updater service started.');
});

svc.on('error', (error) => {
  console.error('Service install error:', error.message || error);
  process.exitCode = 1;
});

svc.install();
