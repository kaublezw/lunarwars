import { HeadlessEngine } from '../src/headless/HeadlessEngine';

const seedArg = process.env['SEED'];
const maxTicksArg = process.env['MAX_TICKS'];

const seed = seedArg ? parseInt(seedArg, 10) : undefined;
const maxTicks = maxTicksArg ? parseInt(maxTicksArg, 10) : undefined;

const engine = new HeadlessEngine({ seed, maxTicks });

console.log(`Starting headless game (seed: ${engine.seed}, max ticks: ${maxTicks ?? 72000})...`);

const start = performance.now();
const result = engine.run();
const elapsed = ((performance.now() - start) / 1000).toFixed(2);

console.log(`Seed: ${result.seed}`);
console.log(`Winner: Team ${result.winner ?? 'none (truncated)'} in ${result.totalTicks} ticks (${(result.totalTicks / 60).toFixed(1)}s game time)`);
console.log(`Real time: ${elapsed}s`);
