const { Service } = require('node-windows');
const path = require('path');

const serviceScript = path.join(__dirname, '..', 'service', 'updater-service.js');

const svc = new Service({
  name: 'LiveScreenShareUpdaterService',
  script: serviceScript
});

svc.on('uninstall', () => {
  console.log('Updater service uninstalled.');
});

svc.on('error', (error) => {
  console.error('Service uninstall error:', error.message || error);
  process.exitCode = 1;
});

svc.uninstall();
