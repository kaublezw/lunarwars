import { fork, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { HeadlessMultiplayerEngine } from '../src/headless/HeadlessMultiplayerEngine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const seedArg = process.env['SEED'];
const maxTicksArg = process.env['MAX_TICKS'];
const portArg = process.env['PORT'] || '8080';
const requestedSeed = seedArg ? parseInt(seedArg, 10) : undefined;
const maxTicks = maxTicksArg ? parseInt(maxTicksArg, 10) : undefined;
const serverUrl = `ws://localhost:${portArg}`;

// --- Start relay server as child process ---

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = join(__dirname, '..', 'server', 'server.ts');
    const child = fork(serverPath, [], {
      execArgv: ['--import', 'tsx/esm'],
      env: { ...process.env, PORT: portArg },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    let started = false;

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('EADDRINUSE')) {
        console.error(`[server] ${msg}`);
      }
    });

    child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !started) {
        if (msg.includes('listening')) {
          started = true;
          resolve(child);
        }
      }
    });

    child.on('error', (err) => {
      if (!started) reject(err);
    });

    child.on('exit', (code) => {
      if (!started) {
        // Server failed to start (e.g. port in use) — try connecting to existing server
        console.log('Server process exited — assuming existing server is running');
        started = true;
        resolve(child);
      }
    });

    // Timeout fallback
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve(child);
      }
    }, 3000);
  });
}

// --- Main ---

async function main() {
  console.log('Starting headless multiplayer test...');

  // 1. Start server
  let serverProcess: ChildProcess | null = null;
  try {
    serverProcess = await startServer();
    console.log(`Server started on port ${portArg}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }

  try {
    // 2. Create two clients
    const clientA = new HeadlessMultiplayerEngine('Client A', maxTicks);
    const clientB = new HeadlessMultiplayerEngine('Client B', maxTicks);

    // 3. Connect both to server
    await clientA.connect(serverUrl);
    await clientB.connect(serverUrl);
    console.log('Both clients connected');

    // 4. Client A creates room
    const gameStartA = clientA.waitForGameStart();
    const roomCode = await clientA.createRoom();
    console.log(`Client A: room created (code: ${roomCode})`);

    // 5. Client B joins room
    const gameStartB = clientB.waitForGameStart();
    await clientB.joinRoom(roomCode);
    console.log(`Client B: joined room ${roomCode}`);

    // 6. Both wait for game_start
    const [cfgA, cfgB] = await Promise.all([gameStartA, gameStartB]);

    const gameSeed = requestedSeed ?? cfgA.seed;
    console.log(`Game starting (seed: ${gameSeed}, input delay: ${cfgA.inputDelay})`);

    // If user requested a specific seed, override (both must use the same seed)
    // Note: the server assigns the seed, so in practice we use the server's seed
    // The SEED env var is informational — the server picks the actual seed.

    // 7. Init worlds with same seed
    clientA.initWorld(cfgA.seed, cfgA.team, cfgA.inputDelay);
    clientB.initWorld(cfgB.seed, cfgB.team, cfgB.inputDelay);

    // 8. Run both concurrently
    const start = performance.now();
    const [resultA, resultB] = await Promise.all([clientA.run(), clientB.run()]);
    const elapsed = (performance.now() - start) / 1000;

    // 9. Report results
    console.log('\n--- Results ---');
    console.log(`Seed: ${resultA.seed}`);
    console.log(`Winner: Team ${resultA.winner ?? 'none (truncated)'} in ${resultA.totalTicks} ticks (${(resultA.totalTicks / 60).toFixed(1)}s game time)`);
    console.log(`Real time: ${elapsed.toFixed(2)}s (${Math.round(resultA.totalTicks / elapsed)} ticks/sec)`);
    console.log(`Client A: ${resultA.checksumsPassed} checksums passed, ${resultA.desyncCount} desyncs`);
    console.log(`Client B: ${resultB.checksumsPassed} checksums passed, ${resultB.desyncCount} desyncs`);

    if (resultA.desyncCount > 0 || resultB.desyncCount > 0) {
      console.error('\nDESYNC DETECTED — simulation diverged between clients');
      process.exitCode = 1;
    } else if (resultA.winner !== resultB.winner || resultA.totalTicks !== resultB.totalTicks) {
      console.error(`\nRESULT MISMATCH — A: team ${resultA.winner} @ ${resultA.totalTicks} ticks, B: team ${resultB.winner} @ ${resultB.totalTicks} ticks`);
      process.exitCode = 1;
    } else {
      console.log('\nMultiplayer test PASSED — both clients stayed in sync');
    }

    // Cleanup
    clientA.disconnect();
    clientB.disconnect();
  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
