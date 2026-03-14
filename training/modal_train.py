"""Modal.com CPU training for Lunar Wars RL agent.

Runs PPO training on rented CPUs. The game simulation (TypeScript/Node.js)
is the bottleneck, so we parallelize with multiple game server subprocesses.

Setup:
    1. pip install modal
    2. modal setup   (one-time auth)
    3. modal run training/modal_train.py

    # Custom timesteps:
    modal run training/modal_train.py --timesteps 1000000

    # Resume from a saved checkpoint (upload it to the volume first):
    modal run training/modal_train.py --resume /models/checkpoints/lunar_wars_ppo_500000_steps

Downloads the trained model to training/checkpoints/ when done.
"""

import modal

app = modal.App("lunar-wars-rl")

# Persistent volume for model checkpoints and tensorboard logs
volume = modal.Volume.from_name("lunar-wars-models", create_if_missing=True)

# Build image with Node.js + Python ML stack
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates", "gnupg")
    .run_commands(
        "mkdir -p /etc/apt/keyrings",
        "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
        'echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list',
        "apt-get update && apt-get install -y nodejs",
    )
    .pip_install(
        "stable-baselines3[extra]>=2.3.0",
        "gymnasium>=0.29.0",
        "pyzmq>=25.0.0",
        "numpy>=1.24.0",
        "tensorboard>=2.14.0",
    )
    .run_commands("pip install torch --index-url https://download.pytorch.org/whl/cpu")
    .add_local_dir(".", remote_path="/app/lunar-wars", copy=True, ignore=[
        "node_modules", ".git", "dist",
        "training/checkpoints", "training/logs", "training/.venv",
    ])
    .run_commands("cd /app/lunar-wars && npm install --production=false")
)


@app.function(
    image=image,
    cpu=8,
    timeout=86400,  # 24 hour max
    volumes={"/models": volume},
)
def train(
    timesteps: int = 5_000_000,
    ticks_per_step: int = 30,
    max_ticks: int = 18000,
    resume: str = "",
    n_envs: int = 8,
):
    import os
    import subprocess
    import sys
    import time

    from stable_baselines3 import PPO
    from stable_baselines3.common.callbacks import CheckpointCallback
    from stable_baselines3.common.vec_env import SubprocVecEnv, VecMonitor

    sys.path.insert(0, "/app/lunar-wars/training")

    base_port = 5555
    game_dir = "/app/lunar-wars"
    checkpoint_dir = "/models/checkpoints"
    log_dir = "/models/tb_logs"
    os.makedirs(checkpoint_dir, exist_ok=True)
    os.makedirs(log_dir, exist_ok=True)

    # Start n_envs TypeScript RL server subprocesses, each on its own port
    servers = []
    for rank in range(n_envs):
        port = base_port + rank
        env = os.environ.copy()
        env["PORT"] = str(port)
        env["MAX_TICKS"] = str(max_ticks)
        env["TICKS_PER_STEP"] = str(ticks_per_step)

        print(f"Starting RL game server {rank} on port {port}...")
        proc = subprocess.Popen(
            ["npx", "tsx", "scripts/run-rl-server.ts"],
            cwd=game_dir,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
        servers.append(proc)

    time.sleep(5)  # Wait for all servers to start

    for rank, proc in enumerate(servers):
        if proc.poll() is not None:
            stdout = proc.stdout.read().decode() if proc.stdout else ""
            raise RuntimeError(f"Game server {rank} failed to start:\n{stdout}")

    print(f"All {n_envs} game servers running.")

    from lunar_wars_env import LunarWarsEnv

    def make_env(rank: int):
        def _init() -> LunarWarsEnv:
            return LunarWarsEnv(
                port=base_port + rank,
                ticks_per_step=ticks_per_step,
                max_ticks=max_ticks,
                game_dir=game_dir,
                auto_start=False,
            )
        return _init

    vec_env = SubprocVecEnv([make_env(i) for i in range(n_envs)], start_method="fork")
    monitored_env = VecMonitor(vec_env)

    save_freq = max(10_000 // n_envs, 1)
    checkpoint_cb = CheckpointCallback(
        save_freq=save_freq,
        save_path=checkpoint_dir,
        name_prefix="lunar_wars_ppo",
        verbose=1,
    )

    # Auto-detect latest checkpoint for preemption recovery
    if not resume:
        import glob as _glob
        existing = _glob.glob(os.path.join(checkpoint_dir, "*.zip"))
        if existing:
            resume = max(existing, key=os.path.getmtime)
            print(f"Auto-resume: detected checkpoint {resume}")

    if resume:
        print(f"Resuming from checkpoint: {resume}")
        model = PPO.load(resume, env=monitored_env, device="cpu")
    else:
        model = PPO(
            "MlpPolicy",
            monitored_env,
            verbose=1,
            learning_rate=5e-5,
            n_steps=1024,
            batch_size=256,
            n_epochs=10,
            gamma=0.99,
            gae_lambda=0.95,
            clip_range=0.2,
            ent_coef=0.01,
            vf_coef=0.5,
            max_grad_norm=0.5,
            tensorboard_log=log_dir,
            device="cpu",
            policy_kwargs=dict(
                net_arch=dict(pi=[256, 256], vf=[256, 256]),
            ),
        )

    print(f"Training for {timesteps:,} timesteps on CPU with {n_envs} envs...")
    try:
        model.learn(
            total_timesteps=timesteps,
            callback=checkpoint_cb,
            progress_bar=True,
            reset_num_timesteps=False,
        )

        final_path = os.path.join(checkpoint_dir, "lunar_wars_ppo_final")
        model.save(final_path)
        print(f"Model saved to {final_path}")
    finally:
        monitored_env.close()
        for rank, proc in enumerate(servers):
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    volume.commit()
    print("Volume committed. Training complete.")


@app.function(image=image, volumes={"/models": volume})
def download_model(remote_path: str = "/models/checkpoints/lunar_wars_ppo_final.zip"):
    """Download a trained model from the Modal volume."""
    with open(remote_path, "rb") as f:
        return f.read()


@app.local_entrypoint()
def main(
    timesteps: int = 5_000_000,
    ticks_per_step: int = 30,
    max_ticks: int = 18000,
    resume: str = "",
    download: bool = True,
    n_envs: int = 8,
):
    print(f"Launching Modal training: {timesteps:,} timesteps, {n_envs} envs, CPU")
    train.remote(
        timesteps=timesteps,
        ticks_per_step=ticks_per_step,
        max_ticks=max_ticks,
        resume=resume,
        n_envs=n_envs,
    )

    if download:
        import os
        local_dir = os.path.join(os.path.dirname(__file__), "checkpoints")
        os.makedirs(local_dir, exist_ok=True)
        local_path = os.path.join(local_dir, "lunar_wars_ppo_final.zip")

        print(f"Downloading trained model to {local_path}...")
        model_bytes = download_model.remote()
        with open(local_path, "wb") as f:
            f.write(model_bytes)
        print(f"Model downloaded: {local_path}")
