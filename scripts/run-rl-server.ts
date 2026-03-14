import { HeadlessEngine } from '../src/headless/HeadlessEngine';
import type { AIAction, HeadlessConfig } from '../src/headless/types';

const port = parseInt(process.env.PORT || '5555', 10);
const seed = process.env.SEED ? parseInt(process.env.SEED, 10) : undefined;
const maxTicks = parseInt(process.env.MAX_TICKS || '3000', 10);
const ticksPerStep = parseInt(process.env.TICKS_PER_STEP || '30', 10);

const config: HeadlessConfig = {
  seed,
  maxTicks,
  ticksPerStep,
  rlMode: true,
};

async function main() {
  // Dynamic import zeromq (ESM)
  const zmq = await import('zeromq');
  const sock = new zmq.Reply();

  await sock.bind(`tcp://127.0.0.1:${port}`);
  console.log(`RL server listening on tcp://127.0.0.1:${port}`);
  console.log(`Config: seed=${seed ?? 'random'}, maxTicks=${maxTicks}, ticksPerStep=${ticksPerStep}`);

  let engine = new HeadlessEngine(config);

  for await (const [msg] of sock) {
    try {
      const request = JSON.parse(msg.toString());
      const command: string = request.command;

      if (command === 'reset') {
        // Allow overriding seed on reset
        if (request.seed !== undefined) {
          const resetConfig = { ...config, seed: request.seed };
          engine = new HeadlessEngine(resetConfig);
        } else if (!seed) {
          // Random seed each reset if no fixed seed
          const resetConfig = { ...config, seed: Math.floor(Math.random() * 2147483647) };
          engine = new HeadlessEngine(resetConfig);
        } else {
          engine = new HeadlessEngine(config);
        }
        const result = engine.reset();
        await sock.send(JSON.stringify(result));
      } else if (command === 'step') {
        const defaultAction: AIAction = { actionType: 0, sourceX: 0, sourceZ: 0, targetX: 0, targetZ: 0, param: 0 };
        let actions: AIAction[];
        if (Array.isArray(request.action)) {
          actions = request.action.map((a: Partial<AIAction>) => ({
            actionType: a.actionType ?? 0,
            sourceX: a.sourceX ?? 0,
            sourceZ: a.sourceZ ?? 0,
            targetX: a.targetX ?? 0,
            targetZ: a.targetZ ?? 0,
            param: a.param ?? 0,
          }));
        } else if (request.action) {
          actions = [request.action as AIAction];
        } else {
          actions = [defaultAction];
        }
        const result = engine.step(actions);
        await sock.send(JSON.stringify(result));
      } else if (command === 'close') {
        await sock.send(JSON.stringify({ status: 'closed' }));
        sock.close();
        console.log('RL server shut down.');
        process.exit(0);
      } else {
        await sock.send(JSON.stringify({
          observation: { resources: [], mapGrid: [], energyGrid: [], oreGrid: [], unitData: [], buildingData: [], gameState: [], actionMask: [], tick: 0 },
          reward: 0,
          done: false,
          truncated: false,
          info: { error: `Unknown command: ${command}` },
        }));
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('Error processing message:', errorMsg);
      await sock.send(JSON.stringify({
        observation: { resources: [], mapGrid: [], energyGrid: [], oreGrid: [], unitData: [], buildingData: [], gameState: [], actionMask: [], tick: 0 },
        reward: 0,
        done: false,
        truncated: false,
        info: { error: errorMsg },
      }));
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
