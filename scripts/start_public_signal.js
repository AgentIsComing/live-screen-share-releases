const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const cloudflaredPath = path.join(__dirname, '..', 'tools', 'cloudflared.exe');
const runtimeDir = path.join(__dirname, '..', 'runtime');
const infoPath = path.join(runtimeDir, 'tunnel-info.json');

if (!fs.existsSync(cloudflaredPath)) {
  console.error(`cloudflared not found at ${cloudflaredPath}`);
  process.exit(1);
}

fs.mkdirSync(runtimeDir, { recursive: true });

function writeInfo(url) {
  const payload = {
    url,
    wsUrl: url.replace(/^https:/i, 'wss:') + '/signal',
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(infoPath, JSON.stringify(payload, null, 2));
}

const child = spawn(cloudflaredPath, ['tunnel', '--url', 'http://localhost:3000'], {
  stdio: ['inherit', 'pipe', 'pipe']
});

const tryUrlRegex = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

function handleChunk(chunk, isErr) {
  const text = chunk.toString();
  if (isErr) {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }

  const match = text.match(tryUrlRegex);
  if (match && match[1]) {
    writeInfo(match[1]);
    process.stdout.write(`\n[auto-detect] tunnel saved: ${match[1]}\n`);
  }
}

child.stdout.on('data', (c) => handleChunk(c, false));
child.stderr.on('data', (c) => handleChunk(c, true));

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));