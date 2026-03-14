"""Local PPO training script for Lunar Wars RL agent.

Usage:
    # Install deps first:
    pip install -r training/requirements.txt

    # Basic training (starts game server automatically):
    python training/train.py

    # Custom settings:
    python training/train.py --timesteps 1000000 --port 5555 --ticks-per-step 30

    # Resume from checkpoint:
    python training/train.py --resume training/checkpoints/lunar_wars_ppo_500000_steps
"""

import argparse
import os
import sys

from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback, EvalCallback
from stable_baselines3.common.monitor import Monitor

# Add training dir to path for local imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lunar_wars_env import LunarWarsEnv


def make_env(port: int, ticks_per_step: int, max_ticks: int, game_dir: str, auto_start: bool) -> LunarWarsEnv:
    env = LunarWarsEnv(
        port=port,
        ticks_per_step=ticks_per_step,
        max_ticks=max_ticks,
        game_dir=game_dir,
        auto_start=auto_start,
    )
    return Monitor(env)


def main():
    parser = argparse.ArgumentParser(description="Train Lunar Wars RL agent with PPO")
    parser.add_argument("--timesteps", type=int, default=500_000, help="Total training timesteps")
    parser.add_argument("--port", type=int, default=5555, help="ZMQ server port")
    parser.add_argument("--ticks-per-step", type=int, default=30, help="Game ticks per RL step (30 = 0.5s)")
    parser.add_argument("--max-ticks", type=int, default=18000, help="Max ticks per episode (18000 = 5min)")
    parser.add_argument("--game-dir", type=str, default=None, help="Path to LunarWars project root")
    parser.add_argument("--no-auto-start", action="store_true", help="Don't auto-start game server")
    parser.add_argument("--resume", type=str, default=None, help="Path to checkpoint to resume from")
    parser.add_argument("--checkpoint-dir", type=str, default="training/checkpoints", help="Checkpoint directory")
    parser.add_argument("--log-dir", type=str, default="training/logs", help="Tensorboard log directory")
    parser.add_argument("--device", type=str, default="auto", help="Device: auto, cpu, cuda, mps")
    args = parser.parse_args()

    game_dir = args.game_dir or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs(args.checkpoint_dir, exist_ok=True)
    os.makedirs(args.log_dir, exist_ok=True)

    print(f"Training config:")
    print(f"  Timesteps:      {args.timesteps:,}")
    print(f"  Port:           {args.port}")
    print(f"  Ticks/step:     {args.ticks_per_step}")
    print(f"  Max ticks:      {args.max_ticks}")
    print(f"  Game dir:       {game_dir}")
    print(f"  Auto-start:     {not args.no_auto_start}")
    print(f"  Device:         {args.device}")
    print()

    env = make_env(
        port=args.port,
        ticks_per_step=args.ticks_per_step,
        max_ticks=args.max_ticks,
        game_dir=game_dir,
        auto_start=not args.no_auto_start,
    )

    checkpoint_callback = CheckpointCallback(
        save_freq=50_000,
        save_path=args.checkpoint_dir,
        name_prefix="lunar_wars_ppo",
        verbose=1,
    )

    if args.resume:
        print(f"Resuming from: {args.resume}")
        model = PPO.load(args.resume, env=env, device=args.device)
    else:
        model = PPO(
            "MlpPolicy",
            env,
            verbose=1,
            learning_rate=3e-4,
            n_steps=2048,
            batch_size=64,
            n_epochs=10,
            gamma=0.99,
            gae_lambda=0.95,
            clip_range=0.2,
            ent_coef=0.01,
            vf_coef=0.5,
            max_grad_norm=0.5,
            tensorboard_log=args.log_dir,
            device=args.device,
            policy_kwargs=dict(
                net_arch=dict(pi=[256, 256], vf=[256, 256]),
            ),
        )

    print("Starting training...")
    try:
        model.learn(
            total_timesteps=args.timesteps,
            callback=checkpoint_callback,
            progress_bar=True,
        )
    except KeyboardInterrupt:
        print("\nTraining interrupted by user.")

    save_path = os.path.join(args.checkpoint_dir, "lunar_wars_ppo_final")
    model.save(save_path)
    print(f"Model saved to: {save_path}")

    env.close()


if __name__ == "__main__":
    main()
