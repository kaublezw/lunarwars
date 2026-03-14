"""Gymnasium wrapper for the Lunar Wars RL environment.

Connects to the TypeScript ZMQ game server and exposes a standard
Gymnasium interface for training with stable-baselines3.

The RL agent controls team 1; the built-in AI controls team 0.
"""

import os
import signal
import subprocess
import time
from typing import Any, Optional

import gymnasium as gym
import numpy as np
import zmq

# Fixed observation dimensions
MAX_UNITS = 100
MAX_BUILDINGS = 100
UNIT_FEATURES = 9
BUILDING_FEATURES = 8
MAP_GRID_SIZE = 32
RESOURCE_FEATURES = 4
GAME_STATE_FEATURES = 12
ACTION_MASK_SIZE = MAP_GRID_SIZE * MAP_GRID_SIZE  # 1024
MAX_ACTIONS_PER_STEP = 4

# Total observation size (fixed)
OBS_SIZE = (
    RESOURCE_FEATURES
    + MAP_GRID_SIZE * MAP_GRID_SIZE * 3  # terrain + energy + ore grids
    + UNIT_FEATURES * MAX_UNITS
    + BUILDING_FEATURES * MAX_BUILDINGS
    + GAME_STATE_FEATURES
    + ACTION_MASK_SIZE
    + 1  # tick
)

RL_TEAM = 1  # RL agent is team 1


class LunarWarsEnv(gym.Env):
    """Gymnasium environment for Lunar Wars RL training.

    Action space: MultiDiscrete([5, 32, 32, 32, 32, 6] * 4) -- 4 sub-actions per step
        Each sub-action: [actionType, srcGridX, srcGridZ, tgtGridX, tgtGridZ, param]

        actionType 0 = NoOp
        actionType 1 = MoveUnit:       srcGridX/Z -> near unit,     tgtGridX/Z -> destination
        actionType 2 = AttackMove:     srcGridX/Z -> near unit,     tgtGridX/Z -> destination
        actionType 3 = TrainUnit:      srcGridX/Z -> near building, param -> unit category (0-4)
        actionType 4 = BuildStructure: srcGridX/Z -> near worker,   tgtGridX/Z -> build site, param -> building type (1-5)

    Observation space: Box(OBS_SIZE,) - normalized float32 array
        [resources(4), terrainGrid(1024), energyGrid(1024), oreGrid(1024),
         unitData(900), buildingData(800), gameState(12), actionMask(1024), tick(1)]
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        port: int = 5555,
        ticks_per_step: int = 30,
        max_ticks: int = 18000,
        game_dir: Optional[str] = None,
        auto_start: bool = True,
        server_startup_wait: float = 3.0,
    ):
        super().__init__()
        self.port = port
        self.ticks_per_step = ticks_per_step
        self.max_ticks = max_ticks
        self.game_dir = game_dir or os.path.dirname(
            os.path.dirname(os.path.abspath(__file__))
        )
        self.auto_start = auto_start
        self.server_startup_wait = server_startup_wait
        self._server_process: Optional[subprocess.Popen] = None

        self.observation_space = gym.spaces.Box(
            low=-1.0, high=10.0, shape=(OBS_SIZE,), dtype=np.float32
        )

        # 4 sub-actions: [actionType, srcGridX, srcGridZ, tgtGridX, tgtGridZ, param] * 4
        self.action_space = gym.spaces.MultiDiscrete(
            [5, 32, 32, 32, 32, 6] * MAX_ACTIONS_PER_STEP
        )

        self._ctx = zmq.Context()
        self._sock: Optional[zmq.Socket] = None

    def _start_server(self) -> None:
        if self._server_process is not None:
            return
        env = os.environ.copy()
        env["PORT"] = str(self.port)
        env["MAX_TICKS"] = str(self.max_ticks)
        env["TICKS_PER_STEP"] = str(self.ticks_per_step)
        self._server_process = subprocess.Popen(
            ["npx", "tsx", "scripts/run-rl-server.ts"],
            cwd=self.game_dir,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        time.sleep(self.server_startup_wait)

    def _connect(self) -> None:
        if self._sock is not None:
            return
        if self.auto_start:
            self._start_server()
        self._sock = self._ctx.socket(zmq.REQ)
        self._sock.setsockopt(zmq.RCVTIMEO, 30000)  # 30s timeout
        self._sock.setsockopt(zmq.SNDTIMEO, 10000)
        self._sock.connect(f"tcp://127.0.0.1:{self.port}")

    def _send(self, msg: dict) -> dict:
        assert self._sock is not None
        self._sock.send_json(msg)
        return self._sock.recv_json()

    def _parse_observation(self, obs_data: dict) -> np.ndarray:
        """Convert fixed-length JSON observation to normalized float array."""
        obs = np.zeros(OBS_SIZE, dtype=np.float32)
        idx = 0

        # Resources [energy, matter, energyRate, matterRate] normalized by /1000
        resources = obs_data.get("resources", [0, 0, 0, 0])
        for i in range(RESOURCE_FEATURES):
            obs[idx + i] = resources[i] / 1000.0 if i < len(resources) else 0.0
        idx += RESOURCE_FEATURES

        # Map grid (32x32, already 0/1)
        map_grid = obs_data.get("mapGrid", [])
        grid_len = min(len(map_grid), MAP_GRID_SIZE * MAP_GRID_SIZE)
        for i in range(grid_len):
            obs[idx + i] = float(map_grid[i])
        idx += MAP_GRID_SIZE * MAP_GRID_SIZE

        # Energy grid (32x32, already 0/1)
        energy_grid = obs_data.get("energyGrid", [])
        eg_len = min(len(energy_grid), MAP_GRID_SIZE * MAP_GRID_SIZE)
        for i in range(eg_len):
            obs[idx + i] = float(energy_grid[i])
        idx += MAP_GRID_SIZE * MAP_GRID_SIZE

        # Ore grid (32x32, already 0/1)
        ore_grid = obs_data.get("oreGrid", [])
        og_len = min(len(ore_grid), MAP_GRID_SIZE * MAP_GRID_SIZE)
        for i in range(og_len):
            obs[idx + i] = float(ore_grid[i])
        idx += MAP_GRID_SIZE * MAP_GRID_SIZE

        # Units: server sends fixed-length own-first array (900 values)
        unit_data = obs_data.get("unitData", [])
        for i in range(0, min(len(unit_data), MAX_UNITS * UNIT_FEATURES), UNIT_FEATURES):
            chunk = unit_data[i : i + UNIT_FEATURES]
            if len(chunk) < UNIT_FEATURES:
                break
            max_hp = chunk[6]
            if max_hp == 0:
                break  # zero-padded slot
            slot = i // UNIT_FEATURES
            base = idx + slot * UNIT_FEATURES
            entity_id = chunk[0]
            team = chunk[1]
            cat_idx = chunk[2]
            px, pz = chunk[3], chunk[4]
            hp = chunk[5]
            ammo, max_ammo = chunk[7], chunk[8]

            obs[base + 0] = entity_id / 1000.0
            obs[base + 1] = 1.0 if int(team) == RL_TEAM else 0.0
            obs[base + 2] = cat_idx / 4.0
            obs[base + 3] = px / 256.0
            obs[base + 4] = pz / 256.0
            obs[base + 5] = hp / max_hp if max_hp > 0 else 0.0
            obs[base + 6] = max_hp / 2000.0
            obs[base + 7] = ammo / max_ammo if max_ammo > 0 and ammo >= 0 else 0.0
            obs[base + 8] = max_ammo / 50.0 if max_ammo > 0 else 0.0
        idx += MAX_UNITS * UNIT_FEATURES

        # Buildings: server sends fixed-length own-first array (800 values)
        building_data = obs_data.get("buildingData", [])
        for i in range(0, min(len(building_data), MAX_BUILDINGS * BUILDING_FEATURES), BUILDING_FEATURES):
            chunk = building_data[i : i + BUILDING_FEATURES]
            if len(chunk) < BUILDING_FEATURES:
                break
            max_hp = chunk[6]
            if max_hp == 0:
                break  # zero-padded slot
            slot = i // BUILDING_FEATURES
            base = idx + slot * BUILDING_FEATURES
            entity_id = chunk[0]
            team = chunk[1]
            type_idx = chunk[2]
            px, pz = chunk[3], chunk[4]
            hp = chunk[5]
            progress = chunk[7]

            obs[base + 0] = entity_id / 1000.0
            obs[base + 1] = 1.0 if int(team) == RL_TEAM else 0.0
            obs[base + 2] = type_idx / 5.0
            obs[base + 3] = px / 256.0
            obs[base + 4] = pz / 256.0
            obs[base + 5] = hp / max_hp if max_hp > 0 else 0.0
            obs[base + 6] = max_hp / 2000.0
            obs[base + 7] = progress
        idx += MAX_BUILDINGS * BUILDING_FEATURES

        # Game state (12 binary features, already 0/1)
        game_state = obs_data.get("gameState", [])
        gs_len = min(len(game_state), GAME_STATE_FEATURES)
        for i in range(gs_len):
            obs[idx + i] = float(game_state[i])
        idx += GAME_STATE_FEATURES

        # Action mask (1024 values, 0/1/2, normalize by /2.0)
        action_mask = obs_data.get("actionMask", [])
        am_len = min(len(action_mask), ACTION_MASK_SIZE)
        for i in range(am_len):
            obs[idx + i] = float(action_mask[i]) / 2.0
        idx += ACTION_MASK_SIZE

        # Tick (normalized)
        obs[idx] = obs_data.get("tick", 0) / max(self.max_ticks, 1)

        return obs

    def _build_actions(self, action: np.ndarray) -> list[dict]:
        """Convert MultiDiscrete action array (24 values) to list of ZMQ AIAction dicts."""
        actions = []
        cell_size = 256.0 / MAP_GRID_SIZE
        for i in range(MAX_ACTIONS_PER_STEP):
            base = i * 6
            action_type = int(action[base])
            src_grid_x = int(action[base + 1])
            src_grid_z = int(action[base + 2])
            tgt_grid_x = int(action[base + 3])
            tgt_grid_z = int(action[base + 4])
            param = int(action[base + 5])

            source_x = (src_grid_x + 0.5) * cell_size
            source_z = (src_grid_z + 0.5) * cell_size
            target_x = (tgt_grid_x + 0.5) * cell_size
            target_z = (tgt_grid_z + 0.5) * cell_size

            actions.append({
                "actionType": action_type,
                "sourceX": float(source_x),
                "sourceZ": float(source_z),
                "targetX": float(target_x),
                "targetZ": float(target_z),
                "param": param,
            })
        return actions

    def reset(
        self,
        *,
        seed: Optional[int] = None,
        options: Optional[dict[str, Any]] = None,
    ) -> tuple[np.ndarray, dict]:
        super().reset(seed=seed)
        self._connect()

        msg: dict[str, Any] = {"command": "reset"}
        if seed is not None:
            msg["seed"] = seed

        resp = self._send(msg)
        obs = self._parse_observation(resp["observation"])
        info = resp.get("info", {})
        return obs, info

    def step(
        self, action: np.ndarray
    ) -> tuple[np.ndarray, float, bool, bool, dict]:
        ai_actions = self._build_actions(action)
        resp = self._send({"command": "step", "action": ai_actions})

        obs = self._parse_observation(resp["observation"])
        reward = float(resp.get("reward", 0.0))
        done = bool(resp.get("done", False))
        truncated = bool(resp.get("truncated", False))
        info = resp.get("info", {})

        return obs, reward, done, truncated, info

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._send({"command": "close"})
            except Exception:
                pass
            self._sock.close()
            self._sock = None
        if self._server_process is not None:
            self._server_process.terminate()
            try:
                self._server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._server_process.kill()
            self._server_process = None
