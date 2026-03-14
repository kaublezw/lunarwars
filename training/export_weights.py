"""Export trained PPO model weights to JSON for TypeScript inference.

Usage:
    source training/.venv/bin/activate
    modal run training/export_weights.py

Outputs public/rl_model_weights.json — a flat representation of the
3-layer MLP policy network that can be loaded in the browser.
"""

import modal

app = modal.App("lunar-wars-export")

volume = modal.Volume.from_name("lunar-wars-models", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("stable-baselines3>=2.3.0", "gymnasium>=0.29.0", "numpy>=1.24.0")
    .run_commands("pip install torch --index-url https://download.pytorch.org/whl/cpu")
)


@app.function(image=image, volumes={"/models": volume})
def export_weights() -> str:
    import glob
    import json
    import os

    from stable_baselines3 import PPO

    checkpoint_dir = "/models/checkpoints"
    final_path = os.path.join(checkpoint_dir, "lunar_wars_ppo_final.zip")
    if os.path.exists(final_path):
        model_path = final_path
    else:
        existing = glob.glob(os.path.join(checkpoint_dir, "*.zip"))
        if not existing:
            raise FileNotFoundError(f"No checkpoints found in {checkpoint_dir}")
        model_path = max(existing, key=os.path.getmtime)
    print(f"Loading checkpoint: {model_path}")
    model = PPO.load(model_path, device="cpu")
    state_dict = model.policy.state_dict()

    # Policy network: 2 hidden layers + action head
    # policy_net.0: Linear(5813, 256) + ReLU
    # policy_net.2: Linear(256, 256) + ReLU
    # action_net:   Linear(256, 556)  ((5+32+32+32+32+6)*4 = 556 action logits)
    layer_keys = [
        ("mlp_extractor.policy_net.0.weight", "mlp_extractor.policy_net.0.bias"),
        ("mlp_extractor.policy_net.2.weight", "mlp_extractor.policy_net.2.bias"),
        ("action_net.weight", "action_net.bias"),
    ]

    layers = []
    for w_key, b_key in layer_keys:
        w = state_dict[w_key].cpu().numpy()
        b = state_dict[b_key].cpu().numpy()
        # Round to 5 decimal places to reduce JSON size
        layers.append({
            "weight": [round(float(x), 5) for x in w.flatten()],
            "bias": [round(float(x), 5) for x in b.flatten()],
            "shape": list(w.shape),  # [out_features, in_features]
        })
        print(f"{w_key}: shape {list(w.shape)}")

    data = json.dumps({"layers": layers})
    print(f"JSON size: {len(data) / 1024:.0f} KB")
    return data


@app.local_entrypoint()
def main():
    import os

    print("Exporting model weights from Modal volume...")
    json_str = export_weights.remote()

    out_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "public",
        "rl_model_weights.json",
    )
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        f.write(json_str)
    print(f"Weights saved to {out_path}")
